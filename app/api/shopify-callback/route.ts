import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { verifyShopifyOAuth } from '@/lib/shopify-security';
import crypto from 'crypto';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop');
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    // Retrieve state cookie
    const cookieHeader = request.headers.get('cookie') || '';
    const cookieState = cookieHeader.split('shopify_state=')[1]?.split(';')[0];

    // SECURITY: Verify HMAC
    if (!verifyShopifyOAuth(searchParams)) {
        console.error('❌ HMAC validation failed');
        return new Response('Unauthorized: HMAC validation failed', { status: 401 });
    }

    // SECURITY: Verify state (CSRF)
    if (!state || state !== cookieState) {
        console.error('❌ State validation failed');
        return new Response('Forbidden: State validation failed', { status: 403 });
    }

    // SECURITY: Shop domain format
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

    // 2. Fetch the shop owner's email from Shopify
    let shopOwnerEmail = '';
    let shopName = '';
    let shopCurrency = 'USD';

    try {
        const shopRes = await fetch(`https://${shop}/admin/api/2024-04/shop.json`, {
            headers: { 'X-Shopify-Access-Token': access_token }
        });
        const shopData = await shopRes.json();
        shopOwnerEmail = shopData.shop?.email || '';
        shopName = shopData.shop?.name || shop;
        shopCurrency = shopData.shop?.currency || 'USD';
        console.log(`🏪 Shop: ${shopName} (${shopOwnerEmail})`);
    } catch (e) {
        console.error('Failed to fetch shop info:', e);
    }

    if (!shopOwnerEmail) {
        console.error('❌ No shop owner email found');
        return new Response('Could not retrieve shop owner email from Shopify', { status: 500 });
    }

    // 3. Create or find the Supabase Auth user
    let authUserId: string | null = null;

    // Check if user already exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
        u => u.email?.toLowerCase() === shopOwnerEmail.toLowerCase()
    );

    if (existingUser) {
        authUserId = existingUser.id;
        console.log(`👤 Existing auth user found: ${shopOwnerEmail}`);
    } else {
        // Create new user with random password (they'll use magic link or password reset to set their own)
        const randomPassword = crypto.randomBytes(20).toString('hex');

        const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
            email: shopOwnerEmail,
            password: randomPassword,
            email_confirm: true, // Auto-confirm — no verification email needed
            user_metadata: {
                store_name: shopName,
                shop_domain: shop
            }
        });

        if (createError) {
            console.error('❌ Auth user creation failed:', createError);
            // Non-fatal — continue with store setup, they can sign up manually later
        } else {
            authUserId = newUser?.user?.id || null;
            console.log(`👤 New auth user created: ${shopOwnerEmail}`);
        }
    }

    // 4. Save or update the store record
    const { data: store, error: storeError } = await supabaseAdmin.from('stores').upsert({
        shopify_url: shop,
        shopify_token: access_token,
        email: shopOwnerEmail, // Link store to auth user by email
        store_name: shopName,
        plan: 'trial',
        created_at: new Date().toISOString(),
    }, {
        onConflict: 'shopify_url'
    }).select().single();

    if (storeError) {
        console.error('Store save error:', storeError.message);
        return new Response('Failed to save store', { status: 500 });
    }

    // 5. Initialize settings row with billing defaults
    if (store) {
        const now = new Date();
        const trialEnd = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

        await supabaseAdmin.from('settings').upsert({
            store_id: store.id,
            store_name: shopName,
            rulebook: 'Be helpful, empathetic, and professional.',
            signature: `Best regards,\n${shopName} Support`,
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

    // 6. Auto-register mandatory webhooks
    await registerMandatoryWebhooks(shop, access_token);

    // 7. Auto-sync Shopify store policies into the rulebook
    try {
        const policiesRes = await fetch(`https://${shop}/admin/api/2024-04/policies.json`, {
            headers: { 'X-Shopify-Access-Token': access_token }
        });
        const policies = await policiesRes.json();

        const rulebook = `STORE: ${shopName}
CURRENCY: ${shopCurrency}
COUNTRY: ${shop}

POLICIES FROM SHOPIFY:
${policies.policies?.map((p: any) => `- ${p.title}: ${p.body?.replace(/<[^>]*>?/gm, '').slice(0, 300)}`).join('\n\n') || 'No policies found'}

SHIPPING: Check Shopify for current shipping rates.
ALWAYS ESCALATE: Refunds over ${shopCurrency} 100, legal threats, chargebacks.`;

        if (store) {
            await supabaseAdmin.from('settings').update({ rulebook }).eq('store_id', store.id);
        }
    } catch (e) {
        console.error('Policies fetch failed (non-critical):', e);
    }

    // 8. Generate a magic link to auto-login the merchant
    let redirectUrl = `${SHOPIFY_APP_URL}/pricing.html?shop=${shop}&connected=true`;

    if (authUserId && shopOwnerEmail) {
        try {
            const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
                type: 'magiclink',
                email: shopOwnerEmail,
                options: {
                    redirectTo: `${SHOPIFY_APP_URL}/pricing.html?shop=${shop}&connected=true`
                }
            });

            if (linkData?.properties?.action_link) {
                // The action_link goes through Supabase auth, sets the session cookie, then redirects
                redirectUrl = linkData.properties.action_link;
                console.log(`🔑 Magic link generated for ${shopOwnerEmail}`);
            } else if (linkError) {
                console.error('Magic link generation failed:', linkError);
                // Fall through to manual redirect — user will need to log in manually
            }
        } catch (e) {
            console.error('Magic link error:', e);
        }
    }

    // 9. Redirect merchant (either via magic link auto-login, or directly to pricing)
    return NextResponse.redirect(redirectUrl);
}

// Register the webhooks Shopify REQUIRES for app submission
async function registerMandatoryWebhooks(shop: string, token: string) {
    const webhooks = [
        { topic: 'app/uninstalled', address: `${SHOPIFY_APP_URL}/api/webhooks/app-uninstalled` },
        { topic: 'app_subscriptions/update', address: `${SHOPIFY_APP_URL}/api/webhooks/app-subscriptions-update` },
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
                console.warn(`⚠️ Webhook ${wh.topic}:`, errData);
            } else {
                console.log(`✅ Registered webhook: ${wh.topic}`);
            }
        } catch (err) {
            console.error(`❌ Failed to register ${wh.topic}:`, err);
        }
    }
}