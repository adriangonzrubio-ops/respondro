import { NextResponse } from 'next/server';
import crypto from 'crypto';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';
// Full scope list matching what we configured in Shopify Partner Dashboard
const SCOPES = 'read_orders,write_orders,read_customers,write_customers,read_products,read_fulfillments,read_inventory';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop');

    if (!shop) return NextResponse.json({ error: 'Missing shop parameter' }, { status: 400 });

    // Validate shop domain format (prevents open redirect attacks)
    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!shopRegex.test(shop)) {
        return NextResponse.json({ error: 'Invalid shop domain' }, { status: 400 });
    }

    // Redirect URI must match what's configured in Shopify Partner Dashboard
    const REDIRECT_URI = `${SHOPIFY_APP_URL}/api/shopify-callback`;

    // Generate state for CSRF protection
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = `https://${shop}/admin/oauth/authorize?` +
        `client_id=${SHOPIFY_CLIENT_ID}&` +
        `scope=${SCOPES}&` +
        `state=${state}&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const response = NextResponse.redirect(authUrl);

    // Save state in httpOnly cookie for verification in callback
    response.cookies.set('shopify_state', state, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 3600
    });

    return response;
}