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
                console.error(`❌ Worker Error for ${conn.imap_user}:`, e.message);
            }
        }
        return NextResponse.json({ success: true, processed: totalProcessed });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

async function fetchInImap(conn: any) {
    let emailsProcessed = 0;
    if (!conn.store_id) return 0;

    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) return 0;

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
        for await (const msg of client.fetch('1:10', { source: true })) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value[0]?.address || "";
            const body = parsed.text || "";
            const subject = parsed.subject || "";

            // A. SCOUT SHOPIFY
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(store.shop_url, store.shopify_access_token, from, orderNum);

            // B. CLAUDE SONNET 4.5 DRAFTING
            const triage = await classifyAndDraft(subject, body, store.rulebook, store.store_name, shopifyData);

            // C. PROACTIVE SAVE
            const { error: upsertError } = await supabase.from('messages').upsert({
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

            if (!upsertError) emailsProcessed++;
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}