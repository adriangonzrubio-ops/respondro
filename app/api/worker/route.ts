import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { classifyEmail } from '../../../lib/ai-classifier';
import { getOrdersByEmail, getOrderByName } from '../../../lib/shopify';
import { generateAiDraft } from '../../../lib/ai-generator';
import { supabase } from '../../../lib/supabase'; // This fixes the 4 "Cannot find" errors

export const dynamic = 'force-dynamic';
export async function GET() {
    console.log("Worker started...");
    try {
        // 1. Get connections from the database
        const { data: connections, error: connError } = await supabase
            .from('user_connections')
            .select('*');

        if (connError) throw connError;

        if (!connections || connections.length === 0) {
            return NextResponse.json({ message: "No email connections found. Please connect an account first." });
        }

        // 2. Fetch emails for every connection
        for (const conn of connections) {
            if (conn.imap_host && conn.imap_user && conn.imap_pass) {
                console.log(`Checking mail for: ${conn.imap_user}`);
                await fetchImap(conn);
            }
        }

        return NextResponse.json({ success: true, message: "Sync complete" });
    } catch (error: any) {
        console.error("Worker Crash:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

async function fetchImap(conn: any) {
    const client = new ImapFlow({
        host: conn.imap_host,
        port: conn.imap_port,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        for await (let msg of client.fetch({ seen: false }, { source: true })) {
            if (msg.source) {
                const parsed = await simpleParser(msg.source);
                const subject = parsed.subject || "No Subject";
                const body = parsed.text || '';
                const from = parsed.from?.value[0]?.address || 'Unknown Sender';

                console.log(`📩 Processing email from: ${from}`);

                // 1. Fetch the store's rulebook for Sonnet 4.5 context
            const { data: storeData } = await supabase
                .from('settings')
                .select('rulebook')
                .eq('store_id', conn.store_id)
                .single();

            const rulebook = storeData?.rulebook || "Standard professional store policies.";

            // 2. AI Classification (Now with 3 arguments)
            const triage = await classifyEmail(subject, body, rulebook);

                // 2. Shopify Order Lookup (SaaS Optimized)
                let shopifyData = null;
                const needsData = ['order_status', 'shipping_update', 'refund_request', 'tracking_update'].includes(triage.category);

                if (needsData) {
                    const { data: store } = await supabase.from('stores').select('*').eq('id', conn.store_id).single();

                    if (store?.shopify_access_token) {
                        // Search by #number in text
                        const orderMatch = subject.match(/#(\d+)/) || body.match(/#(\d+)/);
                        const orderNumber = orderMatch ? orderMatch[1] : null;

                        if (orderNumber) {
                            // This calls the new function in lib/shopify.ts
                            shopifyData = await getOrderByName(store.shop_url, store.shopify_access_token, orderNumber);
                        }
                        // Fallback to email if no order number found
                        if (!shopifyData) {
                            shopifyData = await getOrdersByEmail(store.shop_url, store.shopify_access_token, from);
                        }
                    }
                }

                // 3. Path-based Status Determination
let currentStatus = 'needs_review'; // Default

if (triage.path === 'AUTOMATE') {
    currentStatus = 'automated'; 
} else {
    currentStatus = 'needs_review';
}

// Use triage.draft directly so you don't have to call the AI twice!
const finalDraft = triage.draft || "";

                // 5. Save to Database
                await supabase.from('messages').upsert({
                    connection_id: conn.id,
                    sender: from,
                    subject: subject,
                    body_text: body,
                    category: triage.category,
                    priority: triage.priority,
                    ai_reasoning: triage.reason,
                    status: currentStatus,
                    shopify_data: shopifyData,
                    ai_draft: finalDraft,
                    external_id: msg.uid.toString(),
                }, { onConflict: 'external_id' });
            }
        }
    } finally {
        if (lock) lock.release();
        await client.logout();
    }

}