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
        if (!connections || connections.length === 0) {
            return NextResponse.json({ success: true, processed: 0 });
        }

        for (const conn of connections) {
            try {
                // ✅ Name synchronized with the function below
                totalProcessed += await fetchAndDraft(conn);
            } catch (e: any) {
                console.error(`❌ Worker Error for connection ${conn.id}:`, e.message);
            }
        }
        return NextResponse.json({ success: true, processed: totalProcessed });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

async function fetchAndDraft(conn: any) {
    let emailsProcessed = 0;
    
    // 1. Load Store Settings for this specific connection
    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) return 0;

    const client = new ImapFlow({
        host: conn.imap_host,
        port: 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 15000,
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        const mailbox = client.mailbox as any;
        const last = mailbox?.exists || 0;
        const first = Math.max(1, last - 4); // Process latest 5
        
        const messages: any = client.fetch(`${first}:${last}`, { source: true });
        
        for await (const msg of messages) {
            if (!msg.source) continue;
            
            // 2. Recovery Check: Skip if already has a draft/automated status
            const { data: existing } = await supabase.from('messages')
                .select('id, status, ai_draft')
                .eq('external_id', msg.uid.toString())
                .single();

            if (existing && (existing.status === 'automated' || (existing.ai_draft && existing.ai_draft.length > 10))) {
                continue; 
            }

            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value[0]?.address || "";
            const body = parsed.text || "";
            const subject = parsed.subject || "";

            // 3. Shopify Context
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(store.shop_url, store.shopify_access_token, from, orderNum);
            
            // 4. AI Intelligence (Sonnet 4.5)
            const triage = await classifyAndDraft(subject, body, store.rulebook, store.store_name, shopifyData);
            const finalStatus = triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            // 5. Secure Upsert (Forcing store_id for multi-tenant isolation)
            await (supabase.from('messages') as any).upsert({
                connection_id: conn.id,
                store_id: conn.store_id, 
                sender: from,
                subject: subject,
                body_text: body,
                category: triage?.category || 'General',
                status: finalStatus, 
                ai_draft: triage?.draft || "Analyzing context...", 
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                ai_reasoning: triage?.reason || 'Sync cycle completed.',
                external_id: msg.uid.toString(),
                received_at: parsed.date?.toISOString() || new Date().toISOString()
            }, { onConflict: 'external_id' });

            emailsProcessed++;
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}