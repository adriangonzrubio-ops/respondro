import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * POST /api/webhooks/app-subscriptions-update
 *
 * Shopify sends this webhook when ANY subscription status changes:
 *  - Charge approved by merchant
 *  - Charge declined
 *  - Payment failed
 *  - Merchant cancelled from Shopify admin
 *  - Frozen (e.g. shop closed)
 *
 * Docs: https://shopify.dev/docs/api/webhooks?reference=admin-rest#list-of-topics-app_subscriptions-update
 */
export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    try {
        const payload = await req.json();
        const shopDomain = req.headers.get('x-shopify-shop-domain');

        console.log(`💳 Subscription update from ${shopDomain}:`, payload);

        if (!shopDomain) {
            return NextResponse.json({ success: true }, { status: 200 });
        }

        // Find the store
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('id')
            .eq('shopify_url', shopDomain)
            .single();

        if (!store) {
            console.log(`Store not found for domain: ${shopDomain}`);
            return NextResponse.json({ success: true }, { status: 200 });
        }

        const subscription = payload.app_subscription;
        if (!subscription) {
            return NextResponse.json({ success: true }, { status: 200 });
        }

        const status = subscription.status?.toLowerCase();
        const subscriptionId = subscription.admin_graphql_api_id?.split('/').pop(); // Extract numeric ID

        // Map Shopify status to our internal status
        let internalStatus = 'active';
        if (status === 'cancelled' || status === 'expired') internalStatus = 'cancelled';
        else if (status === 'frozen') internalStatus = 'frozen';
        else if (status === 'pending') internalStatus = 'trialing';
        else if (status === 'declined') internalStatus = 'cancelled';
        else if (status === 'active') internalStatus = 'active';

        // Update settings
        const updateData: any = {
            subscription_status: internalStatus
        };

        // If cancelled, clear the charge_id
        if (internalStatus === 'cancelled') {
            updateData.shopify_charge_id = null;
        }

        await supabaseAdmin
            .from('settings')
            .update(updateData)
            .eq('store_id', store.id);

        // Log the event
        await supabaseAdmin.from('billing_events').insert({
            store_id: store.id,
            shop_domain: shopDomain,
            event_type: `subscription_${status}`,
            shopify_charge_id: subscriptionId ? parseInt(subscriptionId, 10) : null,
            raw_webhook_payload: payload
        });

        console.log(`✅ Subscription status updated to ${internalStatus} for ${shopDomain}`);

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (error: any) {
        console.error('Subscription webhook error:', error);
        // Still return 200 so Shopify doesn't retry
        return NextResponse.json({ success: true }, { status: 200 });
    }
}