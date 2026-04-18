import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { encrypt } from '@/lib/encryption';

export async function POST(request: Request) {
    try {
        const body = await request.json();

        if (!body.email || !body.imap_pass) {
            return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
        }

        const connectionData: any = {
            email: body.email,
            imap_host: body.imap_host,
            imap_port: body.imap_port,
            imap_user: body.imap_user,
            imap_pass: encrypt(body.imap_pass),
            smtp_host: body.smtp_host,
            smtp_port: body.smtp_port,
            updated_at: new Date().toISOString(),
        };
        if (body.store_id) connectionData.store_id = body.store_id;

        const { error } = await supabaseAdmin
            .from('user_connections')
            .upsert(connectionData, { onConflict: 'email' });

        if (error) throw error;
        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('IMAP save error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}