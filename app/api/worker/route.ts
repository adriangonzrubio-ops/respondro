import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { classifyEmail } from '../../../lib/ai-classifier';
import { getOrdersByEmail } from '../../../lib/shopify';

// Initialize Supabase at the top level so all functions can see it
const supabase = createClient(
    process.env.SUPABASE_URL!, 
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const { data: connections } = await supabase.from('user_connections').select('*');
        if (!connections) return NextResponse.json({ message: "No connections" });

        for (const conn of connections) {
            if (conn.imap_host) {
                await fetchImap(conn);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
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
        // Fetch unseen messages
        for await (let msg of client.fetch({ seen: false }, { source: true })) {
            if (!msg.source) continue;

            const parsed = await simpleParser(msg.source);
            const subject = parsed.subject || 'No Subject';
            const body = parsed.text || '';
            const from = parsed.from?.value[0]?.address || 'Unknown Sender';

            console.log(`📡 Processing email from: ${from}`);

            // 1. AI Classification (The "Sorter")
            const triage = await classifyEmail(subject, body);

            // 2. Shopify Order Lookup (The "Detective")
            let shopifyData = null;
            const needsData = ['order_status', 'shipping_update', 'refund_request'].includes(triage.category);

            if (needsData) {
                const { data: store } = await supabase.from('stores').select('*').single();
                if (store?.shopify_token) {
                    shopifyData = await getOrdersByEmail(store.shopify_url, store.shopify_token, from);
                    console.log("📦 Shopify Data Found:", shopifyData ? "Yes" : "No");
                }
            }

            // 3. Status Determination (Triage)
            let initialStatus = 'pending';
            const reviewNeeded = ['refund_request', 'customer_complaint', 'cancellation'];
            
            // Send to Review Board if complex or if data is missing for an order inquiry
            if (reviewNeeded.includes(triage.category) || (needsData && !shopifyData)) {
                initialStatus = 'needs_review';
            } else if (['spam', 'marketing'].includes(triage.category)) {
                initialStatus = 'archived';
            }

            // 4. Save to Database
            await supabase.from('messages').upsert({
                connection_id: conn.id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage.category,
                priority: triage.priority,
                ai_reasoning: triage.reason,
                status: initialStatus,
                shopify_data: shopifyData, // Critical for AI drafting later
                external_id: msg.uid.toString(),
            }, { onConflict: 'external_id' });
        }
    } finally {
        lock.release();
        await client.logout();
    }
}