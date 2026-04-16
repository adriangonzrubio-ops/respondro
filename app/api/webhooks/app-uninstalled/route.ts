import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: Request) {
    // Verify HMAC before doing anything
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    const shopDomain = req.headers.get('x-shopify-shop-domain') || payload.domain;

    console.log(`🚨 App uninstalled: ${shopDomain}`);

    if (!shopDomain) {
        return new Response('Missing shop domain', { status: 400 });
    }

    try {
        // Find the store
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('id')
            .eq('shopify_url', shopDomain)
            .single();

        if (store) {
            // Mark subscription as cancelled (don't delete immediately — merchant may reinstall within 48h)
            await supabaseAdmin
                .from('settings')
                .update({
                    subscription_status: 'cancelled',
                    shopify_charge_id: null,
                    shopify_charge_activated_at: null
                })
                .eq('store_id', store.id);

            // Revoke the Shopify token (can't use it anymore anyway)
            await supabaseAdmin
                .from('stores')
                .update({
                    shopify_token: null,
                    plan: 'cancelled'
                })
                .eq('id', store.id);

            // Log the uninstall event
            await supabaseAdmin.from('billing_events').insert({
                store_id: store.id,
                shop_domain: shopDomain,
                event_type: 'app_uninstalled',
                raw_webhook_payload: payload
            });

            console.log(`✅ Cleaned up data for uninstalled shop: ${shopDomain}`);
        }

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (error: any) {
        console.error('App uninstall error:', error);
        // Still return 200 so Shopify doesn't retry — we log the error server-side
        return NextResponse.json({ success: true }, { status: 200 });
    }
}