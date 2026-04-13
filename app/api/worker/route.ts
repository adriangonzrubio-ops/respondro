import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber } from "@/lib/shopify";

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const origin = request.headers.get('origin') || request.headers.get('referer') || '';
    const isSameOrigin = origin.includes('respondro.vercel.app') || origin.includes('localhost');
    
    if (!isSameOrigin && key !== process.env.WORKER_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let totalProcessed = 0;
    try {
        const { data: connections } = await supabase.from('user_connections').select('*');
        if (!connections || connections.length === 0) {
            return NextResponse.json({ success: true, processed: 0 });
        }

        for (const conn of connections) {
            try {
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

    // 1. Load Store Settings
    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) return 0;

    const client = new ImapFlow({
        host: conn.imap_host,
        port: conn.imap_port || 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 15000,
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        // Fetch ALL unseen emails
        const unseenUids = await client.search({ seen: false }, { uid: true });
        
        if (!unseenUids || unseenUids.length === 0) {
            lock.release();
            await client.logout();
            return 0;
        }

        // Process in batches of 20 to avoid Vercel timeout
        const batch = unseenUids.slice(0, 20);
        console.log(`📬 Found ${unseenUids.length} unseen emails for ${conn.imap_user}, processing batch of ${batch.length}`);

        const messages: any = client.fetch(batch, { source: true, uid: true, flags: true }, { uid: true });

        for await (const msg of messages) {
            if (!msg.source) continue;

            const parsed = await simpleParser(msg.source);
            const fromAddress = parsed.from?.value[0]?.address || "";
            const fromName = parsed.from?.value[0]?.name || "";
            const from = fromName ? `"${fromName}" <${fromAddress}>` : fromAddress;
            const body = parsed.text || "";
            const subject = parsed.subject || "";
            const messageId = parsed.messageId || "";
            const inReplyTo = parsed.inReplyTo || "";
            const references = (parsed.references || []) as string[];

            // 2. Check if this email already exists
            const { data: existing } = await supabase.from('messages')
                .select('id, status, ai_draft')
                .eq('external_id', msg.uid.toString())
                .single();

            if (existing && (existing.status === 'automated' || existing.status === 'spam' || (existing.ai_draft && existing.ai_draft.length > 10))) {
                // Mark as read on the IMAP server so we don't fetch it again
                try { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); } catch(e) {}
                continue;
            }

            // 3. CHECK FOR REPLY TO PREVIOUS TICKET (re-labeling logic)
            let reopenedTicketId: string | null = null;
            let previousCategory: string | null = null;
            let previousStatus: string | null = null;

            if (inReplyTo || references.length > 0) {
                const refIds = [inReplyTo, ...references].filter(Boolean);
                for (const refId of refIds) {
                    const { data: prevMsg } = await supabase.from('messages')
                        .select('id, status, category, sender')
                        .or(`message_id.eq.${refId}`)
                        .limit(1)
                        .single();

                    if (prevMsg && (prevMsg.status === 'done' || prevMsg.status === 'closed' || prevMsg.status === 'automated')) {
                        reopenedTicketId = prevMsg.id;
                        previousCategory = prevMsg.category;
                        previousStatus = prevMsg.status;
                        break;
                    }
                }

                // Fallback: check by sender email + similar subject
                if (!reopenedTicketId && fromAddress) {
                    const { data: prevByEmail } = await supabase.from('messages')
                        .select('id, status, subject, category')
                        .ilike('sender', `%${fromAddress}%`)
                        .in('status', ['done', 'closed', 'automated'])
                        .order('received_at', { ascending: false })
                        .limit(5);

                    if (prevByEmail) {
                        const cleanSubject = subject.replace(/^(Re:|Fwd:|Fw:)\s*/gi, '').trim().toLowerCase();
                        const match = prevByEmail.find(m => {
                            const prevSubject = (m.subject || '').replace(/^(Re:|Fwd:|Fw:)\s*/gi, '').trim().toLowerCase();
                            return prevSubject === cleanSubject;
                        });
                        if (match) {
                            reopenedTicketId = match.id;
                            previousCategory = match.category;
                            previousStatus = match.status;
                        }
                    }
                }
            }

            // 4. Shopify Context
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(
                store.shop_url,
                store.shopify_access_token,
                fromAddress,
                orderNum,
                fromName
            );

            // 5. Fetch agent rulebooks and store policies
            const { data: agents } = await supabase
                .from('support_agents')
                .select('agent_type, rulebook, is_enabled')
                .eq('store_id', conn.store_id);

            const { data: policies } = await supabase
                .from('store_policies')
                .select('policy_type, policy_content')
                .eq('store_id', conn.store_id);

            let fullRulebook = store.rulebook || '';
            
            if (agents && agents.length > 0) {
                const agentRules = agents
                    .filter((a: any) => a.is_enabled && a.rulebook)
                    .map((a: any) => `[${a.agent_type.toUpperCase()} AGENT RULES]:\n${a.rulebook}`)
                    .join('\n\n');
                if (agentRules) fullRulebook += '\n\n' + agentRules;
            }

            if (policies && policies.length > 0) {
                const policyText = policies
                    .filter((p: any) => p.policy_content)
                    .map((p: any) => `[${p.policy_type.replace(/_/g, ' ').toUpperCase()}]:\n${p.policy_content.substring(0, 3000)}`)
                    .join('\n\n');
                if (policyText) fullRulebook += '\n\nSTORE POLICIES:\n' + policyText;
            }

            // 6. AI Classification (with previous context for re-labeling)
            const triage = await classifyAndDraft(
                subject, body, fullRulebook, store.store_name || 'Our Store', shopifyData, store.signature,
                previousCategory,
                previousStatus
            );

            // 7. Determine final status based on AI path
            let finalStatus: string;
            
            if (triage.path === 'SPAM') {
                finalStatus = 'spam';
            } else if (triage.path === 'AUTOMATE') {
                finalStatus = 'automated';
            } else {
                finalStatus = 'needs_review';
            }

            // If this is a reply to an archived ticket, always flag for review (unless spam)
            if (reopenedTicketId && finalStatus !== 'spam') {
                finalStatus = 'needs_review';
                triage.reason = (triage.reason || '') + ' [Customer replied to previous thread — reopened for review]';
                
                // Check if category escalated (e.g., order_status → refund_request)
                const escalationCategories = ['refund_request', 'cancellation', 'complaint', 'damaged_item', 'missing_item'];
                if (previousCategory && !escalationCategories.includes(previousCategory) && escalationCategories.includes(triage.category)) {
                    triage.priority = 'High';
                    triage.reason = (triage.reason || '') + ` [ESCALATED: changed from "${previousCategory}" to "${triage.category}"]`;
                }
            }

            // 8. Upsert the message
            const { data: upserted } = await (supabase.from('messages') as any).upsert({
                connection_id: conn.id,
                store_id: conn.store_id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage.category || 'general',
                priority: triage.priority || 'Medium',
                status: finalStatus,
                ai_draft: triage.draft || '',
                ai_reasoning: triage.reason || 'Sync cycle completed.',
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                external_id: msg.uid.toString(),
                received_at: parsed.date?.toISOString() || new Date().toISOString()
            }, { onConflict: 'external_id' }).select('id');

            // 9. AUTO-SEND if classified as AUTOMATE
            if (finalStatus === 'automated' && triage.draft && upserted?.[0]?.id) {
                try {
                    const msgId = upserted[0].id;
                    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://respondro.vercel.app';
                    const sendRes = await fetch(`${appUrl}/api/messages/${msgId}/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            text: triage.draft,
                            customerEmail: fromAddress
                        })
                    });

                    if (sendRes.ok) {
                        await supabase.from('messages').update({
                            status: 'automated',
                            sent_reply: triage.draft,
                            sent_at: new Date().toISOString()
                        }).eq('id', msgId);
                        console.log(`✅ Auto-sent reply to ${fromAddress} for: ${subject}`);
                    } else {
                        await supabase.from('messages').update({ status: 'needs_review' }).eq('id', msgId);
                        console.error(`⚠️ Auto-send failed for ${fromAddress}, moved to review`);
                    }
                } catch (sendErr: any) {
                    console.error(`❌ Auto-send error: ${sendErr.message}`);
                }
            }

            // 10. Mark email as read on IMAP server after processing
            try {
                await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
            } catch (flagErr) {
                // Non-critical — email will just be re-fetched next cycle
            }

            emailsProcessed++;
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}