import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { createRecurringCharge, cancelCharge } from '@/lib/shopify-billing';

/**
 * POST /api/shopify/billing/create-charge
 * Body: { shop: string, tier: string, interval: 'monthly' | 'annual' }
 *
 * Called when a merchant picks a plan. Creates a recurring charge in Shopify
 * and returns the confirmation URL for the merchant to approve.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { shop, tier, interval } = body;

        // Validate inputs
        if (!shop || !tier || !interval) {
            return NextResponse.json({ error: 'Missing shop, tier, or interval' }, { status: 400 });
        }

        if (!['monthly', 'annual'].includes(interval)) {
            return NextResponse.json({ error: 'Invalid interval' }, { status: 400 });
        }

        const validTiers = ['starter', 'essential', 'growth', 'scale', 'enterprise'];
        if (!validTiers.includes(tier)) {
            return NextResponse.json({ error: 'Invalid tier' }, { status: 400 });
        }

        // Shop domain validation
        const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
        if (!shopRegex.test(shop)) {
            return NextResponse.json({ error: 'Invalid shop domain' }, { status: 400 });
        }

        // Fetch the store's Shopify token
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, shopify_token')
            .eq('shopify_url', shop)
            .single();

        if (storeError || !store || !store.shopify_token) {
            return NextResponse.json({ error: 'Store not found or not connected' }, { status: 404 });
        }

        // If there's an existing active charge, cancel it first
        const { data: settings } = await supabaseAdmin
            .from('settings')
            .select('shopify_charge_id')
            .eq('store_id', store.id)
            .single();

        if (settings?.shopify_charge_id) {
            await cancelCharge(shop, store.shopify_token, settings.shopify_charge_id);
            console.log(`♻️ Cancelled existing charge ${settings.shopify_charge_id} for ${shop}`);
        }

        // Create the new charge
        const result = await createRecurringCharge({
            shop,
            token: store.shopify_token,
            tier,
            interval
        });

        if ('error' in result) {
            console.error('Charge creation failed:', result.error);
            return NextResponse.json({ error: result.error }, { status: 500 });
        }

        // Log the charge creation attempt
        await supabaseAdmin.from('billing_events').insert({
            store_id: store.id,
            shop_domain: shop,
            event_type: 'charge_created',
            to_tier: tier,
            to_interval: interval,
            shopify_charge_id: result.chargeId
        });

        return NextResponse.json({
            confirmationUrl: result.confirmationUrl,
            chargeId: result.chargeId
        });
    } catch (err: any) {
        console.error('create-charge error:', err);
        return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 });
    }
}