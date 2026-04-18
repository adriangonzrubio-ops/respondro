import { NextResponse } from 'next/server';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '300936447986-8sop293gjemropbnibsqa7m9mdp4bco7.apps.googleusercontent.com';
const APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';

/**
 * GET /api/auth/google-email?shop=xxx&from=onboarding
 * Redirects to Google OAuth to get Gmail access tokens.
 * This does NOT use Supabase auth — it's a standalone OAuth flow.
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop') || '';
    const from = searchParams.get('from') || 'onboarding';

    const state = JSON.stringify({ shop, from });
    const stateEncoded = Buffer.from(state).toString('base64');

    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: `${APP_URL}/api/auth/google-email/callback`,
        response_type: 'code',
        scope: 'https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email',
        access_type: 'offline',
        prompt: 'consent',
        state: stateEncoded
    });

    return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}