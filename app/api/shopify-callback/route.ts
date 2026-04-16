import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { verifyShopifyOAuth } from '@/lib/shopify-security';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop');
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    // Retrieve the state we saved in the cookie during install
    const cookieHeader = request.headers.get('cookie') || '';
    const cookieState = cookieHeader.split('shopify_state=')[1]?.split(';')[0];

    // SECURITY CHECK 1: Verify HMAC (proves Shopify sent this)
    if (!verifyShopifyOAuth(searchParams)) {
        console.error('❌ HMAC validation failed');
        return new Response('Unauthorized: HMAC validation failed', { status: 401 });
    }

    // SECURITY CHECK 2: Verify state (CSRF protection)
    if (!state || state !== cookieState) {
        console.error('❌ State validation failed');
        return new Response('Forbidden: State validation failed', { status: 403 });
    }

    // SECURITY CHECK 3: Shop domain format
    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
    if (!shop || !shopRegex.test(shop)) {
        return new Response('Invalid shop domain', { status: 400 });
    }

    if (!code) {
        return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
    }

    // 1. Exchange code for permanent access token
    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: SHOPIFY_CLIENT_ID,
            client_secret: SHOPIFY_CLIENT_SECRET,
            code,
        }),
    });

    const tokenData = await tokenResponse.json();
    const access_token = tokenData.access_token;

    if (!access_token) {
        console.error('❌ Token exchange failed:', tokenData);
        return new Response('Token exchange failed', { status: 500 });
    }

    // 2. Save or update the store record
    const { data: store, error: storeError } = await supabaseAdmin.from('stores').upsert({
        shopify_url: shop,
        shopify_token: access_token,
        plan: 'trial',
        created_at: new Date().toISOString(),
    }, {
        onConflict: 'shopify_url'
    }).select().single();

    if (storeError) {
        console.error('Store save error:', storeError.message);
        return new Response('Failed to save store', { status: 500 });
    }

    // 3. Initialize settings row with billing defaults
    if (store) {
        const now = new Date();
        const trialEnd = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

        await supabaseAdmin.from('settings').upsert({
            store_id: store.id,
            rulebook: 'Be helpful, empathetic, and professional.',
            signature: 'Best regards, Customer Service Team',
            plan_tier: 'trial',
            subscription_status: 'trialing',
            trial_started_at: now.toISOString(),
            trial_ends_at: trialEnd.toISOString(),
            billing_cycle_start: now.toISOString(),
            billing_cycle_end: trialEnd.toISOString(),
            daily_email_count: 0,
            monthly_email_count: 0
        }, { onConflict: 'store_id' });
    }

    // 4. Auto-register mandatory Shopify webhooks (app/uninstalled, GDPR)
    await registerMandatoryWebhooks(shop, access_token);

    // 5. Auto-sync Shopify policies into the rulebook
    try {
        const shopRes = await fetch(`https://${shop}/admin/api/2024-04/shop.json`, {
            headers: { 'X-Shopify-Access-Token': access_token }
        });
        const shopData = await shopRes.json();

        const policiesRes = await fetch(`https://${shop}/admin/api/2024-04/policies.json`, {
            headers: { 'X-Shopify-Access-Token': access_token }
        });
        const policies = await policiesRes.json();

        const rulebook = `STORE: ${shopData.shop?.name}
CURRENCY: ${shopData.shop?.currency}
COUNTRY: ${shopData.shop?.country_name}
TIMEZONE: ${shopData.shop?.timezone}

POLICIES FROM SHOPIFY:
${policies.policies?.map((p: any) => `- ${p.title}: ${p.body?.replace(/<[^>]*>?/gm, '').slice(0, 300)}`).join('\n\n') || 'No policies found'}

SHIPPING: Check Shopify for current shipping rates.
ALWAYS ESCALATE: Refunds over ${shopData.shop?.currency || 'USD'} 100, legal threats, chargebacks.`;

        if (store) {
            await supabaseAdmin.from('settings').update({ rulebook }).eq('store_id', store.id);
        }
    } catch (e) {
        console.error('Policies fetch failed (non-critical):', e);
    }

    // 6. Redirect merchant to billing plan picker
    // (After billing flow is built, this will go to /pricing?shop=xxx)
    // For now, go to dashboard
    return NextResponse.redirect(`${SHOPIFY_APP_URL}/respondro.html?shop=${shop}&connected=true`);
}

// Register the webhooks Shopify REQUIRES for app submission
async function registerMandatoryWebhooks(shop: string, token: string) {
    const webhooks = [
        { topic: 'app/uninstalled', address: `${SHOPIFY_APP_URL}/api/webhooks/app-uninstalled` },
        { topic: 'customers/data_request', address: `${SHOPIFY_APP_URL}/api/webhooks/gdpr/customers-data-request` },
        { topic: 'customers/redact', address: `${SHOPIFY_APP_URL}/api/webhooks/gdpr/customers-redact` },
        { topic: 'shop/redact', address: `${SHOPIFY_APP_URL}/api/webhooks/gdpr/shop-redact` },
    ];

    for (const wh of webhooks) {
        try {
            const res = await fetch(`https://${shop}/admin/api/2024-04/webhooks.json`, {
                method: 'POST',
                headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    webhook: {
                        topic: wh.topic,
                        address: wh.address,
                        format: 'json'
                    }
                })
            });

            if (!res.ok) {
                const errData = await res.json();
                console.warn(`⚠️ Webhook ${wh.topic} registration issue:`, errData);
            } else {
                console.log(`✅ Registered webhook: ${wh.topic}`);
            }
        } catch (err) {
            console.error(`❌ Failed to register ${wh.topic}:`, err);
        }
    }
}