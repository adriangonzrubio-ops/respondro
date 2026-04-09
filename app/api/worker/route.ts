import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber } from "@/lib/shopify";

export const dynamic = 'force-dynamic';

export async function GET() {
    let totalProcessed = 0;
    try {
        const { data: connections } = await supabase.from('user_connections').select('*');
        if (!connections) return NextResponse.json({ success: true, processed: 0 });

        for (const conn of connections) {
            try {
                totalProcessed += await fetchInImap(conn);
            } catch (e: any) {
                console.error(`❌ Worker Error:`, e.message);
            }
        }
        return NextResponse.json({ success: true, processed: totalProcessed });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

async function fetchInImap(conn: any) {
    let emailsProcessed = 0;
    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) return 0;

    const client = new ImapFlow({
        host: conn.imap_host, port: 993, secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 15000, logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        const mailbox = client.mailbox as any;
        const last = mailbox?.exists || 0;
        // 🚀 SENIOR FIX: Limit to 3 to prevent Vercel Timeouts
        const first = Math.max(1, last - 2); 
        
        const messages: any = client.fetch(`${first}:${last}`, { source: true });
        
        for await (const msg of messages) {
            if (!msg.source) continue;
            
            // Check if already processed
            const { data: exists } = await (supabase.from('messages') as any)
                .select('id')
                .eq('external_id', msg.uid.toString())
                .single();

            if (exists) continue; 

            try {
                const parsed = await simpleParser(msg.source);
                const from = parsed.from?.value[0]?.address || "";
                const body = parsed.text || "";
                const subject = parsed.subject || "";

                // A. Scout & Analyze
                const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
                const shopifyData = await getShopifyContext(store.shop_url, store.shopify_access_token, from, orderNum);
                
                // B. Claude Sonnet 4.5
                const triage = await classifyAndDraft(subject, body, store.rulebook, store.store_name, shopifyData);

                let finalStatus = triage?.path === 'IGNORE' ? 'spam' : 
                                 (triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review');

                // C. Save with full data
                await (supabase.from('messages') as any).upsert({
                    connection_id: conn.id,
                    store_id: conn.store_id,
                    sender: from,
                    subject: subject,
                    body_text: body,
                    category: triage?.category || 'General',
                    status: finalStatus, 
                    ai_draft: triage?.draft || "I'm looking into this for you.", 
                    shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                    ai_reasoning: triage?.reason || 'Proactive sync completed.',
                    external_id: msg.uid.toString()
                }, { onConflict: 'external_id' });

                emailsProcessed++;
            } catch (innerError) {
                console.error("❌ Email Skip (Error):", innerError);
                continue; // Don't let one bad email break the whole sync
            }
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}