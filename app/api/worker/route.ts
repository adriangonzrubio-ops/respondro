import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber } from "@/lib/shopify";

export const dynamic = 'force-dynamic';

// 1. THE MAIN TRIGGER (Triggered by "Refresh Sync")
export async function GET() {
    let processedCount = 0;
    let errors = [];

    try {
        const { data: connections } = await supabase.from('user_connections').select('*');
        
        for (const conn of connections || []) {
            try {
                // We call the background worker for this specific email connection
                const count = await fetchInImap(conn);
                processedCount += (count || 0);
            } catch (e: any) {
                errors.push(`${conn.imap_user}: ${e.message || 'Connection failed'}`);
            }
        }

        return NextResponse.json({ 
            success: true, 
            processed: processedCount, 
            errors: errors 
        });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

// 2. THE BACKGROUND WORKER (The "Brain")
async function fetchInImap(conn: any) {
    let emailsProcessed = 0;

    const { data: store } = await supabase
        .from('settings')
        .select('*')
        .eq('store_id', conn.store_id)
        .single();

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
        // Look at the last 10 emails so we don't miss anything
        for await (const msg of client.fetch('1:10', { source: true })) {
            // 🛡️ Safety check: If the email has no content, skip it
            if (!msg.source) continue; 

            const sourceBuffer = Buffer.from(msg.source);
            const parsed = await simpleParser(sourceBuffer);

            const subject = parsed.subject || "";
            const body = parsed.text || "";
            const from = parsed.from?.value[0]?.address || "";

            // A. SCOUT SHOPIFY
            const orderNumber = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(
                store.shop_url, 
                store.shopify_access_token, 
                from, 
                orderNumber
            );

            // B. AUTOMATIC AI DRAFTING (Claude Sonnet 4.5)
            const rawTriage = await classifyAndDraft(
                subject, 
                body, 
                store.rulebook, 
                store.store_name || "The Store", 
                shopifyData
            );
            
            // Handle Claude's potential JSON formatting
            let triage = rawTriage;
            if (typeof rawTriage === 'string') {
                try {
                    const jsonMatch = rawTriage.match(/\{[\s\S]*\}/);
                    triage = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
                } catch (e) { triage = {}; }
            }

            const finalStatus = triage.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            // C. SAVE TO SUPABASE (Proactive / Instant)
            const { error: upsertError } = await supabase.from('messages').upsert({
                connection_id: conn.id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage.category || 'General Inquiry',
                priority: triage.priority || 'Medium',
                status: finalStatus, 
                ai_draft: triage.draft || null, 
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                ai_reasoning: triage.reason || 'Analyzed automatically.',
                external_id: msg.uid.toString()
            }, { onConflict: 'external_id' });

            if (!upsertError) {
                emailsProcessed++;
            }
        }
    } finally {
        lock.release();
        await client.logout();
    }

    return emailsProcessed;
}