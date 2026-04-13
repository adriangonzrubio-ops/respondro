import { NextResponse } from 'next/server';
import * as nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { text } = await req.json();
    const { id } = await params;
    
    // Fetch settings for logo
    let logoHtml = '';
    const { data: settings } = await supabase.from('settings').select('logo_url, logo_width').limit(1).single();
    if (settings?.logo_url && !settings.logo_url.startsWith('data:')) {
      logoHtml = `<br><img src="${settings.logo_url}" width="${settings.logo_width || 120}" alt="Store Logo" style="max-width:100%;">`;
    }

    const { data: msg } = await supabase.from('messages').select('*').eq('id', id).single();
    if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 });

    const { data: conn } = await supabase.from('user_connections').select('*').not('imap_host', 'is', null).single();
    if (!conn) return NextResponse.json({ error: 'No email connection found' }, { status: 400 });

    const transporter = nodemailer.createTransport({
      host: 'mail.privateemail.com',
      port: 465,
      secure: true,
      auth: { user: conn.imap_user, pass: conn.imap_pass },
    });

    // Convert plain text to HTML paragraphs
    const htmlBody = text.split('\n').map((line: string) => line.trim() === '' ? '<br>' : `<p style="margin:0 0 8px 0;font-family:Arial,sans-serif;font-size:14px;color:#333;">${line}</p>`).join('') + logoHtml;

    await transporter.sendMail({
      from: `"Xhale Support" <${conn.imap_user}>`,
      to: msg.sender,
      subject: msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`,
      text: text,
      html: htmlBody,
    });

    await supabase.from('messages').update({ 
  status: 'done',
  sent_reply: text,
  sent_at: new Date().toISOString()
}).eq('id', id);
    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('❌ Send failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}