import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const { error } = await supabase
      .from('user_connections')
      .upsert({
        email: body.email,
        imap_host: body.imap_host,
        imap_port: body.imap_port,
        imap_user: body.imap_user,
        imap_pass: body.imap_pass,
        smtp_host: body.smtp_host,
        smtp_port: body.smtp_port,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}