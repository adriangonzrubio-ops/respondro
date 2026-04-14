import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
// 🛡️ IMPORT THE SECURITY UTILITY
import { verifyShopifyOAuth } from '@/lib/shopify-security';

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const shop = searchParams.get('shop');
    const code = searchParams.get('code');
    const state = searchParams.get('state'); // The state sent back by Shopify
    
    // Retrieve the state we saved in the cookie during the install step
    const cookieHeader = request.headers.get('cookie') || '';
    const cookieState = cookieHeader.split('shopify_state=')[1]?.split(';')[0];

    // 🛡️ SECURITY CHECK 1: VERIFY HMAC
    // This proves the request actually came from Shopify.
    if (!verifyShopifyOAuth(searchParams)) {
        console.error("❌ HMAC validation failed. Request may be fraudulent.");
        return new Response('Unauthorized: HMAC validation failed', { status: 401 });
    }

    // 🛡️ SECURITY CHECK 2: VERIFY STATE (NONCE)
    // This prevents Cross-Site Request Forgery (CSRF) attacks.
    if (!state || state !== cookieState) {
        console.error("❌ State validation failed. Possible CSRF attack.");
        return new Response('Forbidden: State validation failed', { status: 403 });
    }

    if (!shop || !code) {
        return NextResponse.json({ error: 'Missing params' }, { status: 400 });
    }

    // 1. Exchange the temporary code for a permanent access token
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

    if (access_token) {
        // 2. Save the shop and capture the store ID
        const { data: store, error: storeError } = await supabase.from('stores').upsert({
            shopify_url: shop,
            shopify_token: access_token,
            plan: 'trial',
            created_at: new Date().toISOString(),
        }, {
            onConflict: 'shopify_url'
        }).select().single();

        if (storeError) console.error("Store Save Error:", storeError.message);

        // 3. SaaS AUTO-INSTALL: Create the default settings row
        if (store) {
            await supabase.from('settings').upsert({ 
                store_id: store.id, 
                rulebook: "Be helpful, empathetic, and professional.", 
                signature: "Best regards, Customer Service Team" 
            }, { onConflict: 'store_id' });
        }

        // 4. Auto-sync Shopify store policies
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
                await supabase.from('settings').update({ rulebook }).eq('store_id', store.id);
            }
        } catch (e) {
            console.error("Policies fetch failed - not critical", e);
        }
    }

    // 6. Redirect to Respondro dashboard
    return NextResponse.redirect(`https://respondro.vercel.app/respondro.html?shop=${shop}&connected=true`);
}