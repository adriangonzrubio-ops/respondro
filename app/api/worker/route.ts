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

    const { data: store } = await supabase.from('settings').select('*').eq('store_id', conn.store_id).single();
    if (!store) return 0;

    // Get all external_ids already in DB
    const { data: existingMsgs } = await supabase
        .from('messages')
        .select('external_id')
        .eq('connection_id', conn.id)
        .not('external_id', 'is', null);
    
    const processedUids = new Set((existingMsgs || []).map(m => m.external_id));

    const client = new ImapFlow({
        host: conn.imap_host,
        port: conn.imap_port || 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 30000,
        socketTimeout: 120000,
        greetingTimeout: 15000,
        logger: false
    } as any);

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
        const unseenUids = await client.search({ seen: false }, { uid: true });
        
        if (!unseenUids || unseenUids.length === 0) {
            lock.release();
            await client.logout();
            return 0;
        }

        // STEP 1: Separate already-processed from truly new
        const alreadyInDb: number[] = [];
        const trulyNew: number[] = [];

        for (const uid of unseenUids) {
            if (processedUids.has(uid.toString())) {
                alreadyInDb.push(uid);
            } else {
                trulyNew.push(uid);
            }
        }

        // STEP 2: Mark already-processed emails as READ on IMAP (no download needed)
        if (alreadyInDb.length > 0) {
            console.log(`📭 Marking ${alreadyInDb.length} already-processed emails as read...`);
            for (let i = 0; i < alreadyInDb.length; i += 50) {
                const chunk = alreadyInDb.slice(i, i + 50);
                try {
                    await client.messageFlagsAdd(chunk, ['\\Seen'], { uid: true });
                } catch (e) {}
            }
        }

        if (trulyNew.length === 0) {
            console.log(`📬 ${unseenUids.length} unseen, all already in DB. Cleaned up.`);
            lock.release();
            await client.logout();
            return 0;
        }

        // STEP 3: Only fetch truly new emails (max 8 per run)
        const batch = trulyNew.slice(0, 8);
        console.log(`📬 ${unseenUids.length} unseen, ${trulyNew.length} new, processing ${batch.length}`);

        // Pre-load rulebooks and policies ONCE
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

        // STEP 4: Fetch and process only the new batch
        const messages: any = client.fetch(batch, { source: true, uid: true }, { uid: true });

        for await (const msg of messages) {
            if (!msg.source) continue;

            const parsed = await simpleParser(msg.source);
            const fromAddress = parsed.from?.value[0]?.address || "";
            const fromName = parsed.from?.value[0]?.name || "";
            const from = fromName ? `"${fromName}" <${fromAddress}>` : fromAddress;
            const body = parsed.text || "";
            const subject = parsed.subject || "";
            const inReplyTo = parsed.inReplyTo || "";
            const references = (parsed.references || []) as string[];

            // Check for reply to previous ticket
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

                    if (prevMsg && ['done', 'closed', 'automated'].includes(prevMsg.status)) {
                        reopenedTicketId = prevMsg.id;
                        previousCategory = prevMsg.category;
                        previousStatus = prevMsg.status;
                        break;
                    }
                }

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
                            const prev = (m.subject || '').replace(/^(Re:|Fwd:|Fw:)\s*/gi, '').trim().toLowerCase();
                            return prev === cleanSubject;
                        });
                        if (match) {
                            reopenedTicketId = match.id;
                            previousCategory = match.category;
                            previousStatus = match.status;
                        }
                    }
                }
            }

            // Shopify Context
            const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
            const shopifyData = await getShopifyContext(
                store.shop_url, store.shopify_access_token,
                fromAddress, orderNum, fromName
            );

            // AI Classification
            const triage = await classifyAndDraft(
                subject, body, fullRulebook,
                store.store_name || 'Our Store',
                shopifyData, store.signature,
                previousCategory, previousStatus
            );

            // Determine status
            let finalStatus: string;
            if (triage.path === 'SPAM') {
                finalStatus = 'spam';
            } else if (triage.path === 'AUTOMATE') {
                finalStatus = 'automated';
            } else {
                finalStatus = 'needs_review';
            }

            if (reopenedTicketId && finalStatus !== 'spam') {
                finalStatus = 'needs_review';
                triage.reason = (triage.reason || '') + ' [Reopened from previous thread]';
                
                const escalationCats = ['refund_request', 'cancellation', 'complaint', 'damaged_item', 'missing_item'];
                if (previousCategory && !escalationCats.includes(previousCategory) && escalationCats.includes(triage.category)) {
                    triage.priority = 'High';
                    triage.reason += ` [ESCALATED: ${previousCategory} → ${triage.category}]`;
                }
            }

            // Upsert
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
                ai_reasoning: triage.reason || 'Processed.',
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                external_id: msg.uid.toString(),
                received_at: parsed.date?.toISOString() || new Date().toISOString()
            }, { onConflict: 'external_id' }).select('id');

            // Auto-send if AUTOMATE
            if (finalStatus === 'automated' && triage.draft && upserted?.[0]?.id) {
                try {
                    const msgId = upserted[0].id;
                    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://respondro.vercel.app';
                    const sendRes = await fetch(`${appUrl}/api/messages/${msgId}/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: triage.draft, customerEmail: fromAddress })
                    });

                    if (sendRes.ok) {
                        await supabase.from('messages').update({
                            status: 'automated',
                            sent_reply: triage.draft,
                            sent_at: new Date().toISOString()
                        }).eq('id', msgId);
                        console.log(`✅ Auto-sent to ${fromAddress}: ${subject}`);
                    } else {
                        await supabase.from('messages').update({ status: 'needs_review' }).eq('id', msgId);
                    }
                } catch (sendErr: any) {
                    console.error(`❌ Auto-send error: ${sendErr.message}`);
                }
            }

            // Mark as read on IMAP
            try { await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }); } catch(e) {}

            emailsProcessed++;
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}