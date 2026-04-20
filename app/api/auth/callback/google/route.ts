import { encrypt } from '@/lib/encryption';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(new URL('/respondro.html?error=no_code', request.url));
  }

  try {
    // 1. Swap the 'code' for actual Access and Refresh tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: process.env.NEXT_PUBLIC_BASE_URL + '/api/auth/callback/google',
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) throw new Error(tokens.error_description || 'Token exchange failed');

    // 2. Get the user's email from Google
    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userData = await userResponse.json();

    // 3. Save the tokens to your Supabase table
    // Adjust 'user_connections' if your table is named differently!
    const { error } = await supabase
      .from('user_connections')
      .upsert({
        email: userData.email,
        gmail_access_token: encrypt(tokens.access_token),
        gmail_refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        gmail_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });

    if (error) throw error;

    // 4. Success! Redirect back to the dashboard
    return NextResponse.redirect(new URL('/respondro.html?gmail_connected=true', request.url));

  } catch (err) {
    console.error('OAuth Callback Error:', err);
    return NextResponse.redirect(new URL('/respondro.html?error=oauth_failed', request.url));
  }
}