import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { cancelCharge } from '@/lib/shopify-billing';

/**
 * POST /api/shopify/billing/cancel
 * Body: { shop: string }
 *
 * Called when merchant clicks "Cancel Subscription" in the app.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { shop } = body;

        if (!shop) {
            return NextResponse.json({ error: 'Missing shop' }, { status: 400 });
        }

        const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
        if (!shopRegex.test(shop)) {
            return NextResponse.json({ error: 'Invalid shop domain' }, { status: 400 });
        }

        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('id, shopify_token')
            .eq('shopify_url', shop)
            .single();

        if (!store?.shopify_token) {
            return NextResponse.json({ error: 'Store not found' }, { status: 404 });
        }

        const { data: settings } = await supabaseAdmin
            .from('settings')
            .select('shopify_charge_id, plan_tier')
            .eq('store_id', store.id)
            .single();

        if (!settings?.shopify_charge_id) {
            return NextResponse.json({ error: 'No active subscription' }, { status: 400 });
        }

        // Cancel with Shopify
        const result = await cancelCharge(shop, store.shopify_token, settings.shopify_charge_id);

        if (!result.success) {
            return NextResponse.json({ error: result.error }, { status: 500 });
        }

        // Mark cancelled in our DB
        await supabaseAdmin
            .from('settings')
            .update({
                subscription_status: 'cancelled',
                shopify_charge_id: null
            })
            .eq('store_id', store.id);

        // Log
        await supabaseAdmin.from('billing_events').insert({
            store_id: store.id,
            shop_domain: shop,
            event_type: 'subscription_cancelled',
            from_tier: settings.plan_tier,
            shopify_charge_id: settings.shopify_charge_id
        });

        console.log(`✅ Subscription cancelled for ${shop}`);

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('Cancel subscription error:', err);
        return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
    }
}