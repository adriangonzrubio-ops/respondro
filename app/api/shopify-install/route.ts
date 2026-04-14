import { NextResponse } from 'next/server';
import crypto from 'crypto';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const SCOPES = 'read_orders,write_orders,read_customers,read_products';
const REDIRECT_URI = 'https://respondro.vercel.app/api/shopify-callback';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop');

    if (!shop) return NextResponse.json({ error: 'Missing shop' }, { status: 400 });

    // 🛡️ GENERATE STATE (NONCE)
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = `https://${shop}/admin/oauth/authorize?` +
        `client_id=${SHOPIFY_CLIENT_ID}&` +
        `scope=${SCOPES}&` +
        `state=${state}&` + // <-- Mandatory for public apps
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const response = NextResponse.redirect(authUrl);

    // 🛡️ SAVE STATE IN SECURE COOKIE
    response.cookies.set('shopify_state', state, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 3600 // 1 hour
    });

    return response;
}