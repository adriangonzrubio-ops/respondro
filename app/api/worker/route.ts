import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyEmail } from '@/lib/ai-classifier';
// We updated these to match your existing shopify.ts exports
import { getOrderData, getCustomerOrders } from '@/lib/shopify'; 

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const { data: connections, error } = await supabase
            .from('user_connections')
            .select('*');

        if (error) throw error;

        for (const conn of connections) {
            await fetchInmap(conn);
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

async function fetchInmap(conn: any) {
    const { data: store } = await supabase
        .from('settings')
        .select('*')
        .eq('store_id', conn.store_id)
        .single();

    if (!store) return;

    const client = new ImapFlow({
        host: conn.imap_host,
        port: 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
for await (const msg of client.fetch({ seen: false }, { source: true })) {
            // 🛡️ Safety check: If there's no email source, skip this one
            // This clears the red error on Line 52
            if (!msg.source) continue;

            const sourceBuffer = Buffer.from(msg.source);
            const parsed = await simpleParser(sourceBuffer);
            
            const subject = parsed.subject || "";
            const body = parsed.text || "";
            const from = parsed.from?.value[0]?.address || "";

            // 🛍️ Shopify Lookup (Wilmo-style background fetch)
            let shopifyData = null;
            const orderNumberMatch = body.match(/#(\d+)/) || subject.match(/#(\d+)/);
            const orderNumber = orderNumberMatch ? orderNumberMatch[1] : null;

            if (orderNumber) {
                shopifyData = await getOrderData(store.shop_url, store.shopify_access_token, orderNumber);
            } else if (from) {
                shopifyData = await getCustomerOrders(store.shop_url, store.shopify_access_token, from);
            }

            // 🤖 AI Processing with Claude Sonnet 4.5
            const triage = await classifyEmail(subject, body, store.rulebook);
            
            // ✍️ Clean Signature: Removes Markdown (**) and extra quotes ("")
            const finalDraft = (triage.draft || "")
                .replace(/\*\*/g, '')
                .replace(/^["']|["']$/g, '')
                .trim();

            // 💾 Database Upsert (Multi-tenant ready for the App Store)
            await supabase.from('messages').upsert({
                connection_id: conn.id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage.category,
                priority: triage.priority,
                status: triage.path === 'AUTOMATE' ? 'automated' : 'needs_review',
                ai_draft: finalDraft,
                shopify_data: shopifyData, 
                ai_reasoning: triage.reason,
                external_id: msg.uid.toString()
            }, { onConflict: 'external_id' });
        }
    } finally {
        lock.release();
        await client.logout();
    }
}