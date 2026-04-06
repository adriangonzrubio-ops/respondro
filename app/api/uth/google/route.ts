import { NextResponse } from 'next/server';

export async function GET() {
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';

  const options = {
    // This uses your Vercel URL + the callback path we set in Google Cloud
    redirect_uri: process.env.NEXT_PUBLIC_BASE_URL + '/api/auth/callback/google',
    client_id: process.env.GOOGLE_CLIENT_ID!,
    access_type: 'offline', // Crucial: gets a Refresh Token so the AI stays logged in
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options);
  return NextResponse.redirect(`${rootUrl}?${qs.toString()}`);
}