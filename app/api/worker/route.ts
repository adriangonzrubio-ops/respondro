// app/api/worker/route.ts
// FIXED v2: Handles null store_id by resolving store from connection email

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
                totalProcessed += await fetchAndProcessImap(conn);
            } catch (e: any) {
                console.error(`❌ Worker IMAP Error for ${conn.email}:`, e.message);
            }
        }

        await healMissingDrafts();

        return NextResponse.json({ success: true, processed: totalProcessed });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

// ─────────────────────────────────────────────
// RESOLVE STORE — handles null store_id
// ─────────────────────────────────────────────
async function resolveStore(conn: any): Promise<{ storeId: string; rulebook: string; storeName: string; shopUrl: string; shopToken: string } | null> {
    let storeId = conn.store_id;

    // If store_id is null on the connection, find the store another way
    if (!storeId) {
        console.warn(`⚠️ Connection ${conn.id} has null store_id — attempting auto-resolve...`);

        // Strategy 1: Get the only/first store in the database
        const { data: allStores } = await supabase
            .from('stores')
            .select('id, store_name, shopify_url, shopify_token, rulebook')
            .limit(1);

        if (allStores && allStores.length > 0) {
            storeId = allStores[0].id;
            console.log(`✅ Auto-resolved store_id: ${storeId} (${allStores[0].store_name})`);

            // Also fix the connection so this doesn't happen again
            await supabase
                .from('user_connections')
                .update({ store_id: storeId })
                .eq('id', conn.id);
            console.log(`🔧 Patched connection ${conn.id} with store_id: ${storeId}`);
        }
    }

    if (!storeId) {
        console.error(`❌ Could not resolve store for connection ${conn.id}`);
        return null;
    }

    // Get store info
    const { data: storeInfo } = await supabase
        .from('stores')
        .select('*')
        .eq('id', storeId)
        .single();

    // Get settings (rulebook, signature)
    const { data: settings } = await supabase
        .from('settings')
        .select('*')
        .eq('store_id', storeId)
        .single();

    return {
        storeId,
        rulebook: settings?.rulebook || storeInfo?.rulebook || 'Be helpful and professional.',
        storeName: storeInfo?.store_name || 'Our Store',
        shopUrl: storeInfo?.shopify_url || storeInfo?.shop_url || '',
        shopToken: storeInfo?.shopify_token || storeInfo?.shopify_access_token || '',
    };
}

// ─────────────────────────────────────────────
// IMAP FETCH + IMMEDIATE DRAFT GENERATION
// ─────────────────────────────────────────────
async function fetchAndProcessImap(conn: any): Promise<number> {
    let emailsProcessed = 0;

    const store = await resolveStore(conn);
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
        const first = Math.max(1, last - 9);

        const messages: any = client.fetch(`${first}:${last}`, { source: true });

        for await (const msg of messages) {
            if (!msg.source) continue;

            // Skip if already has a good draft
            const { data: existing } = await supabase
                .from('messages')
                .select('id, status, ai_draft')
                .eq('external_id', msg.uid.toString())
                .single();

            if (existing?.ai_draft && existing.ai_draft.length > 10) continue;

            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value[0]?.address || "";
            const body = parsed.text || "";
            const subject = parsed.subject || "";

            if (!from || !body) continue;

            // Shopify Scout
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            let shopifyData = null;
            if (store.shopUrl && store.shopToken) {
                try {
                    const orders = await getShopifyContext(store.shopUrl, store.shopToken, from, orderNum);
                    shopifyData = orders && orders.length > 0 ? orders[0] : null;
                } catch (e: any) {
                    console.warn(`⚠️ Shopify lookup failed:`, e.message);
                }
            }

            // AI Draft — ALWAYS generated before save
            let triage: any;
            try {
                triage = await classifyAndDraft(subject, body, store.rulebook, store.storeName, shopifyData);
            } catch (e: any) {
                console.error(`❌ AI draft failed:`, e.message);
                triage = {
                    path: 'REVIEW',
                    category: 'General',
                    priority: 'Medium',
                    draft: `Hi,\n\nThank you for reaching out. We've received your message and will get back to you as soon as possible.\n\nBest regards,\n${store.storeName} Support Team`,
                    reason: 'AI error — fallback draft used.'
                };
            }

            const finalStatus = triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            const { error: upsertError } = await (supabase.from('messages') as any).upsert({
                connection_id: conn.id,
                store_id: store.storeId,
                sender: from,
                subject,
                body_text: body,
                category: triage?.category || 'General',
                status: finalStatus,
                ai_draft: triage?.draft || '',
                shopify_data: shopifyData,
                ai_reasoning: triage?.reason || '',
                priority: triage?.priority || 'Medium',
                external_id: msg.uid.toString(),
                received_at: parsed.date?.toISOString() || new Date().toISOString(),
            }, { onConflict: 'external_id' });

            if (!upsertError) {
                emailsProcessed++;
                console.log(`✅ "${subject}" → ${finalStatus}`);
            } else {
                console.error(`❌ Upsert failed:`, upsertError.message);
            }
        }
    } finally {
        lock.release();
        await client.logout();
    }

    return emailsProcessed;
}

// ─────────────────────────────────────────────
// SELF-HEALING: Fix messages missing drafts
// ─────────────────────────────────────────────
async function healMissingDrafts(): Promise<void> {
    const { data: broken } = await supabase
        .from('messages')
        .select('id, store_id, subject, body_text, sender, shopify_data, category')
        .or('ai_draft.is.null,ai_draft.eq.')
        .in('status', ['needs_review', 'pending'])
        .limit(15);

    if (!broken || broken.length === 0) return;
    console.log(`🔧 Healing ${broken.length} messages without drafts...`);

    for (const msg of broken) {
        try {
            // Resolve store — may also be null here
            let storeId = msg.store_id;
            let rulebook = 'Be helpful and professional.';
            let storeName = 'Our Store';

            if (storeId) {
                const { data: s } = await supabase.from('settings').select('rulebook').eq('store_id', storeId).single();
                const { data: si } = await supabase.from('stores').select('store_name').eq('id', storeId).single();
                rulebook = s?.rulebook || rulebook;
                storeName = si?.store_name || storeName;
            } else {
                // Fallback: get first store
                const { data: allStores } = await supabase.from('stores').select('id, store_name, rulebook').limit(1);
                if (allStores?.[0]) {
                    storeId = allStores[0].id;
                    storeName = allStores[0].store_name || storeName;
                    const { data: s } = await supabase.from('settings').select('rulebook').eq('store_id', storeId).single();
                    rulebook = s?.rulebook || allStores[0].rulebook || rulebook;
                    // Patch the message with the correct store_id
                    await supabase.from('messages').update({ store_id: storeId }).eq('id', msg.id);
                }
            }

            const triage = await classifyAndDraft(msg.subject, msg.body_text, rulebook, storeName, msg.shopify_data);

            await supabase.from('messages').update({
                ai_draft: triage?.draft || '',
                category: triage?.category || msg.category || 'General',
                ai_reasoning: triage?.reason || '',
                priority: triage?.priority || 'Medium',
                status: triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review',
                store_id: storeId,
            }).eq('id', msg.id);

            console.log(`🩹 Healed: "${msg.subject}"`);
        } catch (err: any) {
            console.error(`❌ Heal failed for ${msg.id}:`, err.message);
        }
    }
}