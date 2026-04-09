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
        if (!connections || connections.length === 0) return NextResponse.json({ success: true, processed: 0 });

        console.log(`🚀 [WORKER] Starting sync for ${connections.length} connections...`);

        for (const conn of connections) {
            if (!conn.store_id) {
                console.error(`⚠️ Skipping ${conn.email}: No store_id linked.`);
                continue;
            }
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
    
    // Fetch store settings for this specific store
    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) throw new Error("Store settings missing from DB");

    const client = new ImapFlow({
        host: conn.imap_host,
        port: 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 10000,
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        // ✅ IMAP Sequence: Fetch top 5 recent emails from the inbox
        const messages: any = client.fetch('1:5', { source: true });
        
        for await (const msg of messages) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value[0]?.address || "";
            const body = parsed.text || "";
            const subject = parsed.subject || "";

            console.log(`📩 Processing: ${subject} from ${from}`);

            // A. SCOUT SHOPIFY
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(store.shop_url, store.shopify_access_token, from, orderNum);

            // B. CLAUDE SONNET 4.5 PROACTIVE DRAFTING
            const triage = await classifyAndDraft(subject, body, store.rulebook, store.store_name, shopifyData);

            // C. THE "AUTOMATIC" DELIVERY (SAVING)
            // ✅ FIX: Directly respects triage.path. If AI says 'AUTOMATE', status becomes 'automated'.
            const finalStatus = triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            const { error: upsertError } = await supabase.from('messages').upsert({
                connection_id: conn.id,
                store_id: conn.store_id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage?.category || 'General',
                priority: triage?.priority || 'Medium',
                status: finalStatus, // Saves as automatic or needs_review
                ai_draft: triage?.draft || null, 
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                ai_reasoning: triage?.reason || 'Proactive analysis generated.',
                external_id: msg.uid ? msg.uid.toString() : Buffer.from(subject + from).toString('base64')
            }, { onConflict: 'external_id' });

            if (!upsertError) {
                console.log(`✅ [${finalStatus.toUpperCase()}] Saved ticket for: ${subject}`);
                emailsProcessed++;
            } else {
                console.error(`❌ DB Save failed:`, upsertError.message);
            }
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}