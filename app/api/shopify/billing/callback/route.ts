import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { activateCharge } from '@/lib/shopify-billing';

const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';

/**
 * GET /api/shopify/billing/callback
 *
 * Shopify redirects here after the merchant approves (or declines) the charge.
 * Query params include: shop, charge_id, tier (from our return_url), interval
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const shop = searchParams.get('shop');
        const chargeId = searchParams.get('charge_id');
        const tier = searchParams.get('tier');
        const interval = searchParams.get('interval') as 'monthly' | 'annual';

        if (!shop || !chargeId || !tier || !interval) {
            return NextResponse.redirect(`${SHOPIFY_APP_URL}/onboarding.html?billing_error=missing_params`);
        }

        // Shop domain validation
        const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;
        if (!shopRegex.test(shop)) {
            return NextResponse.redirect(`${SHOPIFY_APP_URL}/onboarding.html?billing_error=invalid_shop`);
        }

        // Fetch the store's token
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, shopify_token')
            .eq('shopify_url', shop)
            .single();

        if (storeError || !store?.shopify_token) {
            return NextResponse.redirect(`${SHOPIFY_APP_URL}/onboarding.html?billing_error=store_not_found`);
        }

        // Verify and activate the charge
        const result = await activateCharge(shop, store.shopify_token, parseInt(chargeId, 10));

        if (!result.success) {
            console.error('Charge activation failed:', result.error);

            await supabaseAdmin.from('billing_events').insert({
                store_id: store.id,
                shop_domain: shop,
                event_type: 'charge_activation_failed',
                shopify_charge_id: parseInt(chargeId, 10),
                raw_webhook_payload: { error: result.error }
            });

            return NextResponse.redirect(`${SHOPIFY_APP_URL}/onboarding.html?billing_error=activation_failed`);
        }

        const charge = result.charge;
        const now = new Date();

        // Parse dates from Shopify's response
        const trialEndsAt = charge.trial_ends_on ? new Date(charge.trial_ends_on) : new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
        const billingCycleEnd = charge.billing_on ? new Date(charge.billing_on) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        // Update settings with the active subscription
        const { error: updateError } = await supabaseAdmin
            .from('settings')
            .update({
                plan_tier: tier,
                plan_interval: interval,
                subscription_status: charge.trial_ends_on && new Date(charge.trial_ends_on) > now ? 'trialing' : 'active',
                shopify_charge_id: charge.id,
                shopify_charge_activated_at: now.toISOString(),
                trial_started_at: charge.activated_on || now.toISOString(),
                trial_ends_at: trialEndsAt.toISOString(),
                billing_cycle_start: now.toISOString(),
                billing_cycle_end: billingCycleEnd.toISOString(),
                daily_email_count: 0,
                monthly_email_count: 0,
                usage_warning_sent_at: null
            })
            .eq('store_id', store.id);

        if (updateError) {
            console.error('Settings update failed:', updateError);
        }

        // Also update the stores.plan column for backwards compat
        await supabaseAdmin
            .from('stores')
            .update({ plan: tier })
            .eq('id', store.id);

        // Log the successful activation
        await supabaseAdmin.from('billing_events').insert({
            store_id: store.id,
            shop_domain: shop,
            event_type: 'charge_activated',
            to_tier: tier,
            to_interval: interval,
            shopify_charge_id: charge.id,
            amount_usd: parseFloat(charge.price),
            raw_webhook_payload: charge
        });

        console.log(`✅ Charge activated for ${shop}: ${tier} (${interval})`);

        // Redirect merchant to dashboard
        return NextResponse.redirect(`${SHOPIFY_APP_URL}/onboarding.html?shop=${shop}&billing_success=true&tier=${tier}`);
    } catch (err: any) {
        console.error('Billing callback error:', err);
        return NextResponse.redirect(`${SHOPIFY_APP_URL}/onboarding.html?billing_error=server_error`);
    }
}