import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { classifyEmail } from '../../../lib/ai-classifier';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET() {
  const { data: connections } = await supabase.from('user_connections').select('*');
  if (!connections) return NextResponse.json({ message: "No connections" });

  for (const conn of connections) {
    if (conn.imap_host) {
      await fetchImap(conn);
    }
  }

  return NextResponse.json({ success: true });
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
    // @ts-ignore - ImapFlow fetch types are tricky, but this works perfectly at runtime
    for await (let msg of client.fetch({ seen: false }, { source: true })) {
      
      if (!msg.source) continue;

      // @ts-ignore - Telling mailparser to handle the buffer source
      const parsed = await simpleParser(msg.source);
      
      const subject = parsed.subject || 'No Subject';
      const body = parsed.text || '';
      const from = parsed.from?.text || 'Unknown Sender';

      console.log(`Classifying email from: ${from}`);
      const triage = await classifyEmail(subject, body);

      let initialStatus = 'pending';
      const reviewNeeded = ['refund_request', 'customer_complaint', 'cancellation'];
      
      if (reviewNeeded.includes(triage.category)) {
        initialStatus = 'needs_review'; 
      } else if (['spam', 'marketing'].includes(triage.category)) {
        initialStatus = 'archived';
      }

      await supabase.from('messages').upsert({
        connection_id: conn.id,
        sender: from,
        subject: subject,
        body_text: body,
        category: triage.category,
        priority: triage.priority,
        ai_reasoning: triage.reason,
        status: initialStatus,
        external_id: msg.uid.toString(),
      }, { onConflict: 'external_id' });
    }
    
    await supabase.from('user_connections').update({ last_synced_at: new Date() }).eq('id', conn.id);

  } finally {
    lock.release();
    await client.logout();
  }
}