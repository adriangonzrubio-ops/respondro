import { NextResponse } from 'next/server';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createClient } from '@supabase/supabase-js';
import { classifyAndDraft } from '@/lib/ai-classifier';
import { getShopifyContext, extractOrderNumber } from "@/lib/shopify";

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  let totalProcessed = 0;
  try {
    // 1. Load store directly
    const { data: stores } = await supabase.from('stores').select('*').limit(1);
    const store = stores?.[0];
    if (!store) return NextResponse.json({ success: false, error: 'No store found' });

    // 2. Load settings (rulebook + signature)
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('store_id', store.id)
      .single();

    const rulebook = settings?.rulebook || store.rulebook || 'Be helpful and professional.';
    const signature = settings?.signature || '';
    const storeName = store.store_name || 'Our Store';
    const shopUrl = store.shopify_url || store.shop_url || '';
    const shopToken = store.shopify_token || store.shopify_access_token || '';

    console.log(`✅ Store loaded: ${storeName}`);

    // 3. Load connections
    const { data: connections } = await supabase.from('user_connections').select('*');
    if (!connections || connections.length === 0) {
      await healMissingDrafts(store.id, rulebook, storeName, signature);
      return NextResponse.json({ success: true, processed: 0 });
    }

    // 4. Process each inbox
    for (const conn of connections) {
      if (!conn.store_id) {
        await supabase.from('user_connections').update({ store_id: store.id }).eq('id', conn.id);
      }
      try {
        totalProcessed += await fetchAndDraft(conn, store.id, rulebook, storeName, shopUrl, shopToken, signature);
      } catch (e: any) {
        console.error(`❌ IMAP error:`, e.message);
      }
    }

    // 5. Self-healing sweep
    await healMissingDrafts(store.id, rulebook, storeName, signature);

    return NextResponse.json({ success: true, processed: totalProcessed });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

async function fetchAndDraft(
  conn: any,
  storeId: string,
  rulebook: string,
  storeName: string,
  shopUrl: string,
  shopToken: string,
  signature: string
): Promise<number> {
  let count = 0;

  const client = new ImapFlow({
    host: conn.imap_host,
    port: 993,
    secure: true,
    auth: { user: conn.imap_user, pass: conn.imap_pass },
    connectionTimeout: 15000,
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const mailbox = client.mailbox as any;
    const last = mailbox?.exists || 0;
    const first = Math.max(1, last - 9);
    const messages: any = client.fetch(`${first}:${last}`, { source: true });

    for await (const msg of messages) {
      if (!msg.source) continue;

      // Skip if already has a real draft
      const { data: existing } = await supabase
        .from('messages')
        .select('id, ai_draft')
        .eq('external_id', msg.uid.toString())
        .single();

      if (existing?.ai_draft && existing.ai_draft.length > 10) continue;

      const parsed = await simpleParser(msg.source);
      const from = parsed.from?.value[0]?.address || '';
      const body = parsed.text || '';
      const subject = parsed.subject || '';
      if (!from || !body) continue;

      // Shopify lookup
      const orderNum = extractOrderNumber(body) || extractOrderNumber(subject);
      let shopifyData = null;
      if (shopUrl && shopToken) {
        try {
          const orders = await getShopifyContext(shopUrl, shopToken, from, orderNum);
          shopifyData = orders?.[0] || null;
        } catch (e: any) {
          console.warn(`⚠️ Shopify lookup failed:`, e.message);
        }
      }

      // AI Draft with signature
      let triage: any;
      try {
        triage = await classifyAndDraft(subject, body, rulebook, storeName, shopifyData, signature);
      } catch (e: any) {
        const fallback = `Hi,\n\nThank you for reaching out. We have received your message and will get back to you as soon as possible.${signature ? '\n\n' + signature : ''}`;
        triage = { path: 'REVIEW', category: 'General', priority: 'Medium', draft: fallback, reason: 'AI error — fallback used.' };
      }

      const { error } = await (supabase.from('messages') as any).upsert({
        connection_id: conn.id,
        store_id: storeId,
        sender: from,
        subject,
        body_text: body,
        category: triage?.category || 'General',
        status: triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review',
        ai_draft: triage?.draft || '',
        shopify_data: shopifyData,
        ai_reasoning: triage?.reason || '',
        priority: triage?.priority || 'Medium',
        external_id: msg.uid.toString(),
        received_at: parsed.date?.toISOString() || new Date().toISOString(),
      }, { onConflict: 'external_id' });

      if (!error) {
        count++;
        console.log(`✅ "${subject}" → ${triage?.path}`);
      } else {
        console.error(`❌ Upsert failed:`, error.message);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  return count;
}

async function healMissingDrafts(
  storeId: string,
  rulebook: string,
  storeName: string,
  signature: string
): Promise<void> {
  const { data: broken } = await supabase
    .from('messages')
    .select('id, subject, body_text, shopify_data, category')
    .or('ai_draft.is.null,ai_draft.eq.,ai_draft.eq.Generating draft...,ai_draft.eq.Manual check required.')
    .in('status', ['needs_review', 'pending'])
    .limit(5);

  if (!broken?.length) return;
  console.log(`🔧 Healing ${broken.length} messages...`);

  for (const msg of broken) {
    try {
      const triage = await classifyAndDraft(
        msg.subject,
        msg.body_text,
        rulebook,
        storeName,
        msg.shopify_data,
        signature
      );

      await supabase.from('messages').update({
        ai_draft: triage?.draft || '',
        store_id: storeId,
        category: triage?.category || msg.category || 'General',
        ai_reasoning: triage?.reason || '',
        priority: triage?.priority || 'Medium',
        status: triage?.path === 'AUTOMATE' ? 'automated' : 'needs_review',
      }).eq('id', msg.id);

      console.log(`🩹 Healed: "${msg.subject}"`);
    } catch (e: any) {
      console.error(`❌ Heal failed:`, e.message);
    }
  }
}