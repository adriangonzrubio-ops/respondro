import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '300936447986-8sop293gjemropbnibsqa7m9mdp4bco7.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';

/**
 * GET /api/auth/google-email/callback
 * Google redirects here after the user approves Gmail access.
 * Exchanges the code for tokens and saves to user_connections.
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const code = searchParams.get('code');
        const stateParam = searchParams.get('state');
        const error = searchParams.get('error');

        // Parse state
        let shop = '';
        let from = 'onboarding';
        if (stateParam) {
            try {
                const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString());
                shop = decoded.shop || '';
                from = decoded.from || 'onboarding';
            } catch (e) { /* ignore */ }
        }

        const redirectBase = from === 'settings'
            ? `${APP_URL}/respondro.html`
            : `${APP_URL}/onboarding.html`;

        if (error || !code) {
            return NextResponse.redirect(`${redirectBase}?shop=${shop}&email_error=denied`);
        }

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: `${APP_URL}/api/auth/google-email/callback`,
                grant_type: 'authorization_code'
            })
        });

        const tokens = await tokenRes.json();

        if (!tokens.access_token) {
            console.error('Google token exchange failed:', tokens);
            return NextResponse.redirect(`${redirectBase}?shop=${shop}&email_error=token_failed`);
        }

        // Get the user's email address from Google
        const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const profile = await profileRes.json();
        const gmailAddress = profile.email;

        if (!gmailAddress) {
            return NextResponse.redirect(`${redirectBase}?shop=${shop}&email_error=no_email`);
        }

        // Find the store by shop URL
        let storeId: string | null = null;
        if (shop) {
            const { data: store } = await supabaseAdmin
                .from('stores')
                .select('id')
                .eq('shopify_url', shop)
                .single();
            storeId = store?.id || null;
        }

        // Save to user_connections
        const connectionData: any = {
            email: gmailAddress,
            imap_host: 'imap.gmail.com',
            imap_port: 993,
            imap_user: gmailAddress,
            smtp_host: 'smtp.gmail.com',
            smtp_port: 465,
            gmail_access_token: tokens.access_token,
            gmail_refresh_token: tokens.refresh_token || null,
            updated_at: new Date().toISOString()
        };

        if (storeId) {
            connectionData.store_id = storeId;
        }

        const { error: upsertError } = await supabaseAdmin
            .from('user_connections')
            .upsert(connectionData, { onConflict: 'email' });

        if (upsertError) {
            console.error('Failed to save Gmail connection:', upsertError);
            return NextResponse.redirect(`${redirectBase}?shop=${shop}&email_error=save_failed`);
        }

        console.log(`✅ Gmail connected: ${gmailAddress} for shop ${shop}`);

        // Redirect back with success
        const step = from === 'onboarding' ? '&step=4' : '';
        return NextResponse.redirect(`${redirectBase}?shop=${shop}&email_connected=true&email=${encodeURIComponent(gmailAddress)}${step}`);

    } catch (err: any) {
        console.error('Google email callback error:', err);
        return NextResponse.redirect(`${APP_URL}/onboarding.html?email_error=server_error`);
    }
}