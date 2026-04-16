import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { encrypt } from '@/lib/encryption';

/**
 * ONE-TIME USE: Encrypts all plaintext IMAP passwords.
 * Delete this file after running it once.
 * Hit: https://www.respondro.ai/api/migrate-encrypt?key=YOUR_WORKER_SECRET
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (key !== process.env.WORKER_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: connections, error } = await supabaseAdmin
        .from('user_connections')
        .select('id, email, imap_pass');

    if (error || !connections) {
        return NextResponse.json({ error: 'Failed to fetch connections' }, { status: 500 });
    }

    let encrypted = 0;
    let skipped = 0;

    for (const conn of connections) {
        if (!conn.imap_pass) { skipped++; continue; }
        if (conn.imap_pass.startsWith('enc:')) { skipped++; continue; }

        const encryptedPass = encrypt(conn.imap_pass);
        await supabaseAdmin
            .from('user_connections')
            .update({ imap_pass: encryptedPass })
            .eq('id', conn.id);

        encrypted++;
        console.log(`🔒 Encrypted password for ${conn.email}`);
    }

    return NextResponse.json({ success: true, encrypted, skipped });
}