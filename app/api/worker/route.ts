import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabaseAdmin } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber, executeRefund, cancelOrder, updateShippingAddress } from '@/lib/shopify';
import { checkUsageAllowed, incrementUsage } from '@/lib/usage-gate';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const origin = request.headers.get('origin') || request.headers.get('referer') || '';
    const isSameOrigin = origin.includes('respondro.vercel.app') || origin.includes('respondro.ai') || origin.includes('localhost');

    if (!isSameOrigin && key !== process.env.WORKER_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let totalProcessed = 0;
    let totalSent = 0;

    try {
        const { data: connections } = await supabaseAdmin.from('user_connections').select('*');
        if (!connections || connections.length === 0) {
            return NextResponse.json({ success: true, processed: 0, sent: 0 });
        }

        // PHASE A: Fetch and process new emails
        for (const conn of connections) {
            try {
                totalProcessed += await fetchAndProcess(conn);
            } catch (e: any) {
                console.error(`❌ Worker Error for ${conn.id}:`, e.message);
            }
        }

        // PHASE B: Send queued emails past their delay window
        totalSent = await sendQueuedEmails();

        return NextResponse.json({ success: true, processed: totalProcessed, sent: totalSent });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

interface DownloadedEmail {
    uid: number;
    from: string;
    fromAddress: string;
    fromName: string;
    subject: string;
    body: string;
    date: string;
    inReplyTo: string;
    references: string[];
}

// ═══════════════════════════════════════════════
// PHASE A: Fetch + classify + enforce limits + execute actions
// ═══════════════════════════════════════════════
async function fetchAndProcess(conn: any) {
    // Check usage/plan/subscription before doing anything expensive
    const decision = await checkUsageAllowed(conn.store_id);

    if (!decision.storeName) {
        console.log(`⚠️ Skipping connection ${conn.id} — no store found`);
        return 0;
    }

    // Get already-processed UIDs from DB
    const { data: existingMsgs } = await supabaseAdmin
        .from('messages')
        .select('external_id')
        .eq('connection_id', conn.id)
        .not('external_id', 'is', null);
    const processedUids = new Set((existingMsgs || []).map(m => m.external_id));

    // ── IMAP PHASE ──
    const downloaded: DownloadedEmail[] = [];

    const client = new ImapFlow({
        host: conn.imap_host,
        port: conn.imap_port || 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 15000,
        logger: false
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const unseenUids = await client.search({ seen: false }, { uid: true });
            if (!unseenUids || unseenUids.length === 0) { lock.release(); await client.logout(); return 0; }

            const alreadyInDb: number[] = [];
            const trulyNew: number[] = [];
            for (const uid of unseenUids) {
                if (processedUids.has(uid.toString())) { alreadyInDb.push(uid); } else { trulyNew.push(uid); }
            }

            if (alreadyInDb.length > 0) {
                console.log(`📭 Marking ${alreadyInDb.length} as read...`);
                for (let i = 0; i < alreadyInDb.length; i += 50) {
                    try { await client.messageFlagsAdd(alreadyInDb.slice(i, i + 50), ['\\Seen'], { uid: true }); } catch (e) { }
                }
            }

            if (trulyNew.length === 0) { lock.release(); await client.logout(); return 0; }

            const batch = trulyNew.slice(0, 6);
            console.log(`📬 ${unseenUids.length} unseen, ${trulyNew.length} new, downloading ${batch.length}`);

            const messages: any = client.fetch(batch, { source: true, uid: true }, { uid: true });
            for await (const msg of messages) {
                if (!msg.source) continue;
                const parsed = await simpleParser(msg.source);
                const fromAddress = parsed.from?.value[0]?.address || '';
                const fromName = parsed.from?.value[0]?.name || '';

                let emailDate = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
                if (parsed.date && parsed.date.getTime() > Date.now() + 3600000) {
                    emailDate = new Date().toISOString();
                }

                downloaded.push({
                    uid: msg.uid,
                    from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
                    fromAddress, fromName,
                    subject: parsed.subject || '',
                    body: parsed.text || '',
                    date: emailDate,
                    inReplyTo: (parsed.inReplyTo as string) || '',
                    references: (parsed.references || []) as string[]
                });
                try { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); } catch (e) { }
            }
        } finally { lock.release(); }
        await client.logout();
    } catch (imapErr: any) {
        console.error(`❌ IMAP error: ${imapErr.message}`);
        try { await client.logout(); } catch (e) { }
        if (downloaded.length === 0) return 0;
    }

    console.log(`📥 Downloaded ${downloaded.length} emails for ${decision.storeName}. Plan: ${decision.plan} (${decision.usagePercent}% used)`);

    // ── Pre-load agents + policies ONCE ──
    const { data: agents } = await supabaseAdmin.from('support_agents').select('agent_type, rulebook, is_enabled').eq('store_id', conn.store_id);
    const { data: policies } = await supabaseAdmin.from('store_policies').select('policy_type, policy_content').eq('store_id', conn.store_id);

    let fullRulebook = decision.rulebook || '';
    if (agents && agents.length > 0) {
        const agentRules = agents.filter((a: any) => a.is_enabled && a.rulebook).map((a: any) => `[${a.agent_type.toUpperCase()} AGENT]:\n${a.rulebook}`).join('\n\n');
        if (agentRules) fullRulebook += '\n\n' + agentRules;
    }
    if (policies && policies.length > 0) {
        const policyText = policies.filter((p: any) => p.policy_content).map((p: any) => `[${p.policy_type.replace(/_/g, ' ').toUpperCase()}]:\n${p.policy_content.substring(0, 3000)}`).join('\n\n');
        if (policyText) fullRulebook += '\n\nSTORE POLICIES:\n' + policyText;
    }

    // ── PROCESS EACH EMAIL ──
    let emailsProcessed = 0;

    for (const email of downloaded) {
        try {
            // Check for merge target
            let mergeTargetId: string | null = null;
            let previousCategory: string | null = null;
            let previousStatus: string | null = null;

            if (email.fromAddress) {
                const { data: openTicket } = await supabaseAdmin.from('messages')
                    .select('id, category, priority, status')
                    .ilike('sender', `%${email.fromAddress}%`)
                    .in('status', ['needs_review', 'pending', 'automated', 'queued'])
                    .eq('store_id', conn.store_id)
                    .order('received_at', { ascending: false })
                    .limit(1)
                    .single();

                if (openTicket) {
                    mergeTargetId = openTicket.id;
                    previousCategory = openTicket.category;
                    previousStatus = openTicket.status;
                }
            }

            if (!mergeTargetId && (email.inReplyTo || email.references.length > 0) && email.fromAddress) {
                const { data: prevByEmail } = await supabaseAdmin.from('messages')
                    .select('id, status, subject, category')
                    .ilike('sender', `%${email.fromAddress}%`)
                    .in('status', ['done', 'closed', 'automated'])
                    .order('received_at', { ascending: false })
                    .limit(5);
                if (prevByEmail) {
                    const cleanSubject = email.subject.replace(/^(Re:|Fwd:|Fw:)\s*/gi, '').trim().toLowerCase();
                    const match = prevByEmail.find(m => (m.subject || '').replace(/^(Re:|Fwd:|Fw:)\s*/gi, '').trim().toLowerCase() === cleanSubject);
                    if (match) { previousCategory = match.category; previousStatus = match.status; }
                }
            }

            // ═══ USAGE GATE: BLOCK PATH ═══
            // If plan/subscription blocks AI processing, import as needs_review with no AI work
            if (!decision.canProcess) {
                const blockedRecord = {
                    connection_id: conn.id,
                    store_id: conn.store_id,
                    sender: email.from,
                    subject: email.subject,
                    body_text: email.body,
                    category: 'general',
                    priority: 'Medium',
                    status: 'needs_review',
                    ai_draft: '',
                    ai_reasoning: `[AI PAUSED] ${decision.reason}. Emails are being imported but not processed by AI.`,
                    external_id: email.uid.toString(),
                    received_at: email.date
                };

                if (mergeTargetId) {
                    await supabaseAdmin.from('messages').update(blockedRecord).eq('id', mergeTargetId);
                } else {
                    await (supabaseAdmin.from('messages') as any).upsert(blockedRecord, { onConflict: 'external_id' });
                }

                emailsProcessed++;
                console.log(`⏸️ Imported (AI blocked): ${email.subject} — ${decision.reason}`);
                continue;
            }

            // ═══ AI PROCESSING (usage gate passed) ═══

            // Shopify context (now uses correct shop_url/token from stores table)
            const orderNum = extractOrderNumber(email.body) || extractOrderNumber(email.subject);
            const shopifyData = decision.shopifyUrl && decision.shopifyToken
                ? await getShopifyContext(decision.shopifyUrl, decision.shopifyToken, email.fromAddress, orderNum, email.fromName)
                : [];

            const triage = await classifyAndDraft(
                email.subject, email.body, fullRulebook,
                decision.storeName, shopifyData, decision.signature,
                previousCategory, previousStatus
            );

            // ═══ Apply plan gating on top of AI's decision ═══
            let finalStatus: string;
            let aiAction: string | null = null;
            let aiActionResult: any = null;
            let finalDraft = triage.draft;

            if (triage.path === 'SPAM') {
                finalStatus = 'spam';
                finalDraft = '';
            } else if (triage.path === 'AUTOMATE') {
                // Plan check 1: does the plan even allow auto-reply?
                if (!decision.canAutoReply) {
                    finalStatus = 'needs_review';
                    triage.reason = (triage.reason || '') + ` [Plan "${decision.plan}" requires manual send — draft ready for review]`;
                }
                // If action needed, check plan permissions per action
                else if (triage.required_action !== 'none' && triage.action_parameters) {
                    const actionOrderNum = triage.action_parameters.order_number || orderNum;

                    if (triage.required_action === 'refund' && actionOrderNum) {
                        if (!decision.canAutoRefund) {
                            finalStatus = 'needs_review';
                            triage.reason = (triage.reason || '') + ` [Plan "${decision.plan}" does not allow auto-refunds]`;
                        } else {
                            // Check refund amount vs plan cap
                            const orderData = shopifyData?.find((o: any) => String(o.order_number) === String(actionOrderNum).replace('#', ''));
                            const orderTotal = orderData ? parseFloat(orderData.total_price) : 0;
                            const refundAmt = triage.action_parameters.refund_type === 'partial' ? (triage.action_parameters.refund_amount || 0) : orderTotal;

                            const planCap = decision.maxAutoRefundUsd; // null = unlimited

                            if (planCap !== null && refundAmt > planCap) {
                                finalStatus = 'needs_review';
                                triage.reason = (triage.reason || '') + ` [Refund ${refundAmt} exceeds plan cap of ${planCap}]`;
                            } else if (decision.shopifyUrl && decision.shopifyToken) {
                                const result = await executeRefund(decision.shopifyUrl, decision.shopifyToken, actionOrderNum, triage.action_parameters.refund_type === 'partial' ? triage.action_parameters.refund_amount : undefined);
                                aiAction = 'refund';
                                aiActionResult = result;
                                if (result.success) { finalStatus = 'queued'; triage.reason = (triage.reason || '') + ` [AI ACTION: ${result.details}]`; }
                                else { finalStatus = 'needs_review'; triage.reason = (triage.reason || '') + ` [AI ACTION FAILED: ${result.details}]`; }
                            } else {
                                finalStatus = 'needs_review';
                                triage.reason = (triage.reason || '') + ' [No Shopify credentials]';
                            }
                        }
                    } else if (triage.required_action === 'cancel' && actionOrderNum) {
                        if (!decision.canAutoCancel) {
                            finalStatus = 'needs_review';
                            triage.reason = (triage.reason || '') + ` [Plan "${decision.plan}" does not allow auto-cancel]`;
                        } else if (decision.shopifyUrl && decision.shopifyToken) {
                            const result = await cancelOrder(decision.shopifyUrl, decision.shopifyToken, actionOrderNum);
                            aiAction = 'cancel';
                            aiActionResult = result;
                            if (result.success) { finalStatus = 'queued'; triage.reason = (triage.reason || '') + ` [AI ACTION: ${result.details}]`; }
                            else { finalStatus = 'needs_review'; triage.reason = (triage.reason || '') + ` [AI ACTION FAILED: ${result.details}]`; }
                        } else {
                            finalStatus = 'needs_review';
                            triage.reason = (triage.reason || '') + ' [No Shopify credentials]';
                        }
                    } else if (triage.required_action === 'address_change' && actionOrderNum && triage.action_parameters.new_address) {
                        if (!decision.canAutoAddress) {
                            finalStatus = 'needs_review';
                            triage.reason = (triage.reason || '') + ` [Plan "${decision.plan}" does not allow auto-address change]`;
                        } else if (decision.shopifyUrl && decision.shopifyToken) {
                            const result = await updateShippingAddress(decision.shopifyUrl, decision.shopifyToken, actionOrderNum, triage.action_parameters.new_address);
                            aiAction = 'address_change';
                            aiActionResult = result;
                            if (result.success) { finalStatus = 'queued'; triage.reason = (triage.reason || '') + ` [AI ACTION: ${result.details}]`; }
                            else { finalStatus = 'needs_review'; triage.reason = (triage.reason || '') + ` [AI ACTION FAILED: ${result.details}]`; }
                        } else {
                            finalStatus = 'needs_review';
                            triage.reason = (triage.reason || '') + ' [No Shopify credentials]';
                        }
                    } else {
                        finalStatus = 'needs_review';
                        triage.reason = (triage.reason || '') + ' [Action requested but missing data]';
                    }
                } else {
                    // Simple auto-reply (no action)
                    finalStatus = 'queued';
                }
            } else {
                finalStatus = 'needs_review';
            }

            // Reopened threads always go to review
            if (previousStatus && ['done', 'closed', 'automated'].includes(previousStatus) && finalStatus === 'queued') {
                finalStatus = 'needs_review';
                triage.reason = (triage.reason || '') + ' [Reopened thread — moved to review]';
            }

            // Delay for scheduled send
            const delayMinutes = 5; // Fixed 5-min delay for all plans (feels human)
            const scheduledAt = finalStatus === 'queued'
                ? new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()
                : null;

            // ── SAVE TO DATABASE ──
            if (mergeTargetId) {
                await supabaseAdmin.from('messages').update({
                    subject: email.subject,
                    body_text: email.body,
                    category: triage.category || 'general',
                    priority: triage.priority || 'Medium',
                    status: finalStatus,
                    ai_draft: finalDraft || '',
                    ai_reasoning: triage.reason || '',
                    ai_action: aiAction,
                    ai_action_result: aiActionResult,
                    scheduled_send_at: scheduledAt,
                    external_id: email.uid.toString()
                }).eq('id', mergeTargetId);
            } else {
                await (supabaseAdmin.from('messages') as any).upsert({
                    connection_id: conn.id,
                    store_id: conn.store_id,
                    sender: email.from,
                    subject: email.subject,
                    body_text: email.body,
                    category: triage.category || 'general',
                    priority: triage.priority || 'Medium',
                    status: finalStatus,
                    ai_draft: finalDraft || '',
                    ai_reasoning: triage.reason || '',
                    ai_action: aiAction,
                    ai_action_result: aiActionResult,
                    shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                    external_id: email.uid.toString(),
                    received_at: email.date,
                    scheduled_send_at: scheduledAt
                }, { onConflict: 'external_id' });
            }

            // Increment usage (Option B — draft generated = 1 email counted)
            // Skip counting for spam and skip counting if blocked
            if (triage.path !== 'SPAM') {
                await incrementUsage(conn.store_id);
            }

            emailsProcessed++;
            const actionLabel = aiAction ? ` [ACTION: ${aiAction} ${aiActionResult?.success ? '✅' : '❌'}]` : '';
            console.log(`✅ ${emailsProcessed}/${downloaded.length}: ${email.subject} → ${triage.category} (${finalStatus})${actionLabel}`);

        } catch (procErr: any) {
            console.error(`❌ Processing error for ${email.subject}: ${procErr.message}`);
        }
    }

    return emailsProcessed;
}

// ═══════════════════════════════════════════════
// PHASE B: Send queued emails past their delay
// ═══════════════════════════════════════════════
async function sendQueuedEmails(): Promise<number> {
    const now = new Date().toISOString();

    const { data: queued } = await supabaseAdmin
        .from('messages')
        .select('id, sender, subject, ai_draft, store_id, ai_action')
        .eq('status', 'queued')
        .not('ai_draft', 'is', null)
        .lte('scheduled_send_at', now)
        .limit(5);

    if (!queued || queued.length === 0) return 0;

    let sent = 0;
    const appUrl = process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.respondro.ai';

    for (const msg of queued) {
        try {
            const cleanEmail = msg.sender?.includes('<') ? msg.sender.split('<')[1].replace('>', '').trim() : msg.sender;
            if (!cleanEmail || !msg.ai_draft) continue;

            const sendRes = await fetch(`${appUrl}/api/messages/${msg.id}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: msg.ai_draft, customerEmail: cleanEmail })
            });

            if (sendRes.ok) {
                await supabaseAdmin.from('messages').update({
                    status: 'automated',
                    sent_reply: msg.ai_draft,
                    sent_at: new Date().toISOString()
                }).eq('id', msg.id);
                sent++;
                const actionTag = msg.ai_action ? ` [${msg.ai_action}]` : '';
                console.log(`📤 Auto-sent${actionTag}: ${msg.subject} → ${cleanEmail}`);
            } else {
                await supabaseAdmin.from('messages').update({ status: 'needs_review' }).eq('id', msg.id);
                console.warn(`⚠️ Send failed for ${msg.id}, moved to review`);
            }
        } catch (err: any) {
            console.error(`❌ Queue send error for ${msg.id}: ${err.message}`);
        }
    }

    if (sent > 0) console.log(`📤 Sent ${sent} queued emails`);
    return sent;
}