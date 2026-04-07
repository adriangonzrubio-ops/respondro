import { NextResponse } from 'next/server';
import { supabase } from '../../../../../lib/supabase';
import nodemailer from 'nodemailer';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const { draftText } = await req.json();

        // 1. Fetch the message and the user's email connection details
        // We use .single() to get one object back
        const { data: msg, error: msgError } = await supabase
            .from('messages')
            .select('*, user_connections(*)')
            .eq('id', id)
            .single();

        if (msgError || !msg) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }

        // TypeScript safety: check if user_connections exists
        const conn = msg.user_connections;
        if (!conn) {
            return NextResponse.json({ error: "No email connection found" }, { status: 400 });
        }

        // 2. Setup SMTP
        const transporter = nodemailer.createTransport({
            host: conn.imap_host.replace('imap', 'smtp'), 
            port: 465,
            secure: true,
            auth: { 
                user: conn.imap_user, 
                pass: conn.imap_pass 
            }
        });

        // 3. Send the Email
        await transporter.sendMail({
            from: `"Respondro Support" <${conn.imap_user}>`,
            to: msg.sender,
            subject: `Re: ${msg.subject}`,
            text: draftText
        });

        // 4. Update status to 'done'
        await supabase
            .from('messages')
            .update({ 
                status: 'done', 
                updated_at: new Date().toISOString() 
            })
            .eq('id', id);

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Mailman Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}