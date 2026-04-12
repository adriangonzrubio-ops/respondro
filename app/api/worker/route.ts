import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabase } from '@/lib/supabase';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber } from "@/lib/shopify";
import { generateAiDraft } from '@/lib/ai-generator';

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
        port: 993,
        secure: true,
        auth: { user: conn.imap_user, pass: conn.imap_pass },
        connectionTimeout: 15000,
        logger: false
    });

    await client.connect();
    let lock = await client.getMailboxLock('INBOX');

    try {
// Search for all UNSEEN (unread) emails instead of just last 5
        const unseenUids = await client.search({ seen: false }, { uid: true });
        
        if (!unseenUids || unseenUids.length === 0) {
            lock.release();
            await client.logout();
            return 0;
        }

        console.log(`📬 Found ${unseenUids.length} unseen emails for ${conn.imap_user}`);

        const messages: any = client.fetch(unseenUids, { source: true, uid: true }, { uid: true });

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

            if (existing && (existing.status === 'automated' || (existing.ai_draft && existing.ai_draft.length > 10))) {
                continue;
            }

            // 3. CHECK FOR REPLY TO ARCHIVED TICKET
            // If this is a reply to an email we already handled, reopen that thread
            let reopenedTicketId: string | null = null;
            if (inReplyTo || references.length > 0) {
                const refIds = [inReplyTo, ...references].filter(Boolean);
                // Look for any of our sent messages that match
                for (const refId of refIds) {
                    const { data: prevMsg } = await supabase.from('messages')
                        .select('id, status, sender')
                        .or(`message_id.eq.${refId}`)
                        .limit(1)
                        .single();

                    if (prevMsg && (prevMsg.status === 'done' || prevMsg.status === 'closed' || prevMsg.status === 'automated')) {
                        reopenedTicketId = prevMsg.id;
                        break;
                    }
                }

                // Fallback: check by sender email + similar subject
                if (!reopenedTicketId && fromAddress) {
                    const { data: prevByEmail } = await supabase.from('messages')
                        .select('id, status, subject')
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
                        if (match) reopenedTicketId = match.id;
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

            // 5. AI Classification
            const triage = await classifyAndDraft(
                subject, body, store.rulebook, store.store_name, shopifyData, store.signature
            );

            // 6. Determine status
            let finalStatus = triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review';

            // If this is a reply to an archived ticket, always flag for review
            if (reopenedTicketId) {
                finalStatus = 'needs_review';
                if (triage) triage.reason = (triage.reason || '') + ' [Customer replied to previous thread — reopened for review]';
            }

            // 7. Upsert the message
            const { data: upserted } = await (supabase.from('messages') as any).upsert({
                connection_id: conn.id,
                store_id: conn.store_id,
                sender: from,
                subject: subject,
                body_text: body,
                category: triage?.category || 'General',
                priority: triage?.priority || 'Medium',
                status: finalStatus,
                ai_draft: triage?.draft || "Analyzing context...",
                ai_reasoning: triage?.reason || 'Sync cycle completed.',
                shopify_data: shopifyData && shopifyData.length > 0 ? shopifyData : null,
                external_id: msg.uid.toString(),
                received_at: parsed.date?.toISOString() || new Date().toISOString()
            }, { onConflict: 'external_id' }).select('id');

            // 8. AUTO-SEND if classified as AUTOMATE
            if (finalStatus === 'automated' && triage?.draft && upserted?.[0]?.id) {
                try {
                    const msgId = upserted[0].id;
                    // Send the email
                    const sendRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'https://respondro.vercel.app'}/api/messages/${msgId}/send`, {
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
                        // If send fails, move to review so human can handle it
                        await supabase.from('messages').update({ status: 'needs_review' }).eq('id', msgId);
                        console.error(`⚠️ Auto-send failed for ${fromAddress}, moved to review`);
                    }
                } catch (sendErr: any) {
                    console.error(`❌ Auto-send error: ${sendErr.message}`);
                }
            }

            emailsProcessed++;
        }
    } finally {
        lock.release();
        await client.logout();
    }
    return emailsProcessed;
}