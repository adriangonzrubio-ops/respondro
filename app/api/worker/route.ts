import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber } from "@/lib/shopify";

export const dynamic = 'force-dynamic';

export async function GET() {
    let totalProcessed = 0;
    let log = [];

    try {
        const { data: connections } = await supabase.from('user_connections').select('*');
        if (!connections || connections.length === 0) return NextResponse.json({ success: true, processed: 0, log: ["No connections found"] });

        for (const conn of connections) {
            if (!conn.store_id) {
                log.push(`⚠️ Skipping ${conn.email}: No store_id linked.`);
                continue;
            }
            try {
                const count = await fetchInImap(conn);
                totalProcessed += count;
                log.push(`✅ ${conn.email}: Processed ${count} emails.`);
            } catch (e: any) {
                log.push(`❌ ${conn.email} Error: ${e.message}`);
            }
        }
        return NextResponse.json({ success: true, processed: totalProcessed, log });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

async function fetchInImap(conn: any) {
    let emailsProcessed = 0;
    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) throw new Error("Store settings missing");

    const client = new ImapFlow({
        host: conn.imap_host,
        port: 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 7000, // Stop waiting after 7 seconds
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        // LIMIT TO TOP 3: Ensures we don't hit the Vercel 10s timeout
        const messages = client.fetch('1:3', { source: true });
        
        for await (const msg of messages) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value[0]?.address || "";
            const body = parsed.text || "";
            const subject = parsed.subject || "";

            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(store.shop_url, store.shopify_access_token, from, orderNum);

            // Use Claude Sonnet 4.5 for drafting
            const triage = await classifyAndDraft(subject, body, store.rulebook, store.store_name, shopifyData);

            await supabase.from('messages').upsert({
                connection_id: conn.id,
                store_id: conn.store_id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage?.category || 'General',
                status: triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review', 
                ai_draft: triage?.draft || null, 
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                external_id: msg.uid.toString()
            }, { onConflict: 'external_id' });

            emailsProcessed++;
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}