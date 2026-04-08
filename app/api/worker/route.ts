import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyEmail } from '@/lib/ai-classifier';
// We updated these to match your existing shopify.ts exports
import { getShopifyContext, extractOrderNumber } from '@/lib/shopify';

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
            if (!msg.source) continue;

            const sourceBuffer = Buffer.from(msg.source);
            const parsed = await simpleParser(sourceBuffer);
            
            const subject = parsed.subject || "";
            const body = parsed.text || "";
            const from = parsed.from?.value[0]?.address || "";

            // 🛍️ Unified Shopify Lookup (Tries Order Number -> Email Fallback)
            const orderNumber = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(
                store.shop_url, 
                store.shopify_access_token, 
                from, 
                orderNumber
            );

            // 🤖 AI Processing & Auto-Drafting
            const triage = await classifyEmail(subject, body, store.rulebook);
            
            // Clean the draft (Remove Markdown ** and quotes)
            const finalDraft = (triage.draft || "")
                .replace(/\*\*/g, '')
                .replace(/^["']|["']$/g, '')
                .trim();

            // 💾 Database Upsert (Pre-populated for Review Board)
            await supabase.from('messages').upsert({
                connection_id: conn.id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage.category || 'General',
                priority: triage.priority || 'Medium',
                status: 'needs_review',
                ai_draft: finalDraft,
                shopify_data: shopifyData, // This powers the right sidebar!
                ai_reasoning: triage.reason || 'Analyzed intent and checked Shopify status.',
                external_id: msg.uid.toString()
            }, { onConflict: 'external_id' });

            console.log(`✅ Automated Triage & Draft for: ${subject}`);
        }
        
    } finally {
        lock.release();
        await client.logout();
    }
}