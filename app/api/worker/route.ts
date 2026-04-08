import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier'; // Ensure this matches exactly
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
            // 🛡️ Safety check
            if (!msg.source) continue;

            const sourceBuffer = Buffer.from(msg.source);
            const parsed = await simpleParser(sourceBuffer);
            
            const subject = parsed.subject || "";
            const body = parsed.text || "";
            const from = parsed.from?.value[0]?.address || "";

// 1. DYNAMIC SHOPIFY LOOKUP (Instant Context)
            const orderNumber = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(
                store.shop_url, 
                store.shopify_access_token, 
                from, 
                orderNumber
            );

            // 2. PROACTIVE DRAFTING & TRIAGE (Claude Sonnet 4.5)
            const rawTriage = await classifyAndDraft(
                subject, 
                body, 
                store.rulebook, 
                store.store_name || "The Store", 
                shopifyData
            );
            
            // Robust parsing: Strips out any extra text Claude might add
            let triage = rawTriage;
            if (typeof rawTriage === 'string') {
                try {
                    const jsonMatch = rawTriage.match(/\{[\s\S]*\}/);
                    triage = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
                } catch (e) { triage = {}; }
            }

            // 3. DECISION ENGINE
            const finalStatus = triage.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            // 4. SAVE TO DATABASE (The "Wilmo" delivery)
            const { error: upsertError } = await supabase.from('messages').upsert({
                connection_id: conn.id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage.category || 'General Inquiry',
                priority: triage.priority || 'Medium',
                status: finalStatus, 
                ai_draft: triage.draft || null, 
                // 🛠️ CRITICAL: We stringify the JSON so Supabase accepts it perfectly
                shopify_data: shopifyData ? JSON.stringify(shopifyData) : null, 
                ai_reasoning: triage.reason || 'Analyzed.',
                external_id: msg.uid.toString()
            }, { onConflict: 'external_id' });

            if (upsertError) {
                console.error("❌ Database Upsert Error:", upsertError.message);
            } else {
                console.log(`✅ ${triage.path} | Processed: ${subject}`);
            }
        
        }
        
    } finally {
        lock.release();
        await client.logout();
    }
}