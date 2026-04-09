// app/api/worker/route.ts
// FIXED: Auto-draft on arrival + self-healing sweep for missing drafts

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
            return NextResponse.json({ success: true, processed: 0, message: 'No connections found' });
        }

        // STEP 1: Fetch new emails from all connected inboxes
        for (const conn of connections) {
            try {
                totalProcessed += await fetchAndProcessImap(conn);
            } catch (e: any) {
                console.error(`❌ Worker IMAP Error for ${conn.email}:`, e.message);
            }
        }

        // STEP 2: Self-healing sweep — find any messages missing ai_draft and fix them
        await healMissingDrafts();

        return NextResponse.json({ success: true, processed: totalProcessed });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

// ─────────────────────────────────────────────
// IMAP FETCH + IMMEDIATE DRAFT GENERATION
// ─────────────────────────────────────────────
async function fetchAndProcessImap(conn: any): Promise<number> {
    let emailsProcessed = 0;

    // Get the store settings for this connection's store_id
    const { data: store } = await supabase
        .from('settings')
        .select('*')
        .eq('store_id', conn.store_id)
        .single();

    // Also get store info (shop URL + token) from the stores table
    const { data: storeInfo } = await supabase
        .from('stores')
        .select('*')
        .eq('id', conn.store_id)
        .single();

    if (!store && !storeInfo) {
        console.warn(`⚠️ No settings found for store_id: ${conn.store_id}`);
        return 0;
    }

    const rulebook = store?.rulebook || storeInfo?.rulebook || 'Be helpful and professional.';
    const shopUrl = storeInfo?.shopify_url || store?.shop_url || '';
    const shopToken = storeInfo?.shopify_token || store?.shopify_access_token || '';

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
        const first = Math.max(1, last - 9); // Process latest 10 emails

        const messages: any = client.fetch(`${first}:${last}`, { source: true });

        for await (const msg of messages) {
            if (!msg.source) continue;

            // Check if this email already has a draft — skip if it does
            const { data: existing } = await supabase
                .from('messages')
                .select('id, status, ai_draft')
                .eq('external_id', msg.uid.toString())
                .single();

            if (existing?.ai_draft && existing.ai_draft.length > 10) {
                // Already has a good draft, skip
                continue;
            }

            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value[0]?.address || "";
            const body = parsed.text || "";
            const subject = parsed.subject || "";

            if (!from || !body) continue;

            // ── Shopify Scout ──
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            let shopifyData = null;
            if (shopUrl && shopToken) {
                try {
                    const orders = await getShopifyContext(shopUrl, shopToken, from, orderNum);
                    shopifyData = orders && orders.length > 0 ? orders[0] : null;
                } catch (shopifyErr: any) {
                    console.warn(`⚠️ Shopify lookup failed for ${from}:`, shopifyErr.message);
                }
            }

            // ── AI Draft Generation (ALWAYS happens before save) ──
            let triage: any = null;
            try {
                triage = await classifyAndDraft(subject, body, rulebook, storeInfo?.store_name || 'Our Store', shopifyData);
            } catch (aiErr: any) {
                console.error(`❌ AI draft failed for ${subject}:`, aiErr.message);
                triage = {
                    path: 'REVIEW',
                    category: 'General',
                    priority: 'Medium',
                    draft: `Hi,\n\nThank you for reaching out. We've received your message and will get back to you shortly.\n\nBest regards,\nCustomer Service Team`,
                    reason: 'AI generation error — fallback draft used.'
                };
            }

            const finalStatus = triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            // ── Upsert to Supabase ──
            const { error: upsertError } = await (supabase.from('messages') as any).upsert({
                connection_id: conn.id,
                store_id: conn.store_id,           // ← FIXED: always set store_id
                sender: from,
                subject: subject,
                body_text: body,
                category: triage?.category || 'General',
                status: finalStatus,
                ai_draft: triage?.draft || '',     // ← FIXED: always has a draft
                shopify_data: shopifyData,          // ← FIXED: proper null vs object
                ai_reasoning: triage?.reason || '',
                priority: triage?.priority || 'Medium',
                external_id: msg.uid.toString(),
                received_at: parsed.date?.toISOString() || new Date().toISOString(),
            }, { onConflict: 'external_id' });

            if (upsertError) {
                console.error(`❌ Upsert failed for ${subject}:`, upsertError.message);
            } else {
                emailsProcessed++;
                console.log(`✅ Processed: "${subject}" → ${finalStatus}`);
            }
        }
    } finally {
        lock.release();
        await client.logout();
    }

    return emailsProcessed;
}

// ─────────────────────────────────────────────
// SELF-HEALING: Fix messages that have no draft
// ─────────────────────────────────────────────
async function healMissingDrafts(): Promise<void> {
    // Find messages that exist but are missing a draft
    const { data: broken } = await supabase
        .from('messages')
        .select('id, store_id, subject, body_text, sender, shopify_data, category')
        .or('ai_draft.is.null,ai_draft.eq.')
        .in('status', ['needs_review', 'pending'])
        .limit(10); // Heal up to 10 at a time per worker run

    if (!broken || broken.length === 0) return;

    console.log(`🔧 Healing ${broken.length} messages missing drafts...`);

    for (const msg of broken) {
        try {
            // Get store settings for this message
            const { data: store } = await supabase
                .from('settings')
                .select('rulebook')
                .eq('store_id', msg.store_id)
                .single();

            const { data: storeInfo } = await supabase
                .from('stores')
                .select('store_name')
                .eq('id', msg.store_id)
                .single();

            const rulebook = store?.rulebook || 'Be helpful and professional.';
            const storeName = storeInfo?.store_name || 'Our Store';

            const triage = await classifyAndDraft(
                msg.subject,
                msg.body_text,
                rulebook,
                storeName,
                msg.shopify_data
            );

            await supabase
                .from('messages')
                .update({
                    ai_draft: triage?.draft || '',
                    category: triage?.category || msg.category || 'General',
                    ai_reasoning: triage?.reason || '',
                    priority: triage?.priority || 'Medium',
                    status: triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review',
                })
                .eq('id', msg.id);

            console.log(`🩹 Healed draft for: "${msg.subject}"`);
        } catch (err: any) {
            console.error(`❌ Heal failed for ${msg.id}:`, err.message);
        }
    }
}