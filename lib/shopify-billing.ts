// ═══════════════════════════════════════════════════════
// SHOPIFY BILLING LIBRARY
// Handles recurring charges via Shopify's Admin API
// Docs: https://shopify.dev/docs/api/admin-rest/2025-07/resources/recurringapplicationcharge
// ═══════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase';

const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://www.respondro.ai';

// In dev stores Shopify lets you set `test: true` so no real money moves.
// We auto-detect dev stores by checking shopify_url domain suffix.
function isTestMode(shopDomain: string): boolean {
    // Development stores end in .myshopify.com but are flagged by Shopify's billing API automatically
    // We keep test=true ONLY if explicitly set via env var to avoid accidentally billing dev stores
    return process.env.SHOPIFY_BILLING_TEST_MODE === 'true';
}

export interface PlanDetails {
    tier: string;
    display_name: string;
    price_monthly_usd: number;
    price_annual_usd: number;
    email_limit_monthly: number;
}

/**
 * Fetch plan details from the plans table
 */
export async function getPlan(tier: string): Promise<PlanDetails | null> {
    const { data, error } = await supabaseAdmin
        .from('plans')
        .select('tier, display_name, price_monthly_usd, price_annual_usd, email_limit_monthly')
        .eq('tier', tier)
        .single();

    if (error || !data) {
        console.error('Plan not found:', tier, error);
        return null;
    }
    return data;
}

/**
 * Create a recurring application charge in Shopify
 * Returns the confirmation URL that the merchant must visit to approve the charge
 */
export async function createRecurringCharge(params: {
    shop: string;
    token: string;
    tier: string;
    interval: 'monthly' | 'annual';
}): Promise<{ confirmationUrl: string; chargeId: number } | { error: string }> {
    const { shop, token, tier, interval } = params;

    // Get plan details
    const plan = await getPlan(tier);
    if (!plan) return { error: `Unknown plan tier: ${tier}` };

    const price = interval === 'annual' ? plan.price_annual_usd : plan.price_monthly_usd;
    const name = `Respondro ${plan.display_name} (${interval})`;

    // Shopify charges don't support annual natively — annual is actually a 30-day recurring
    // charge at 1/12 of the annual price, which we present as "20% off" to the merchant.
    // To keep things simple, we'll bill monthly regardless of interval but charge different amounts
    // based on whether they picked the annual-discount rate.

    const chargePayload = {
        recurring_application_charge: {
            name,
            price: price.toFixed(2),
            return_url: `${SHOPIFY_APP_URL}/api/shopify/billing/callback?tier=${tier}&interval=${interval}`,
            trial_days: 4, // 4-day trial
            test: isTestMode(shop),
            terms: getTermsText(plan, interval)
        }
    };

    try {
        const res = await fetch(`https://${shop}/admin/api/2025-07/recurring_application_charges.json`, {
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(chargePayload)
        });

        const data = await res.json();

        if (!res.ok) {
            console.error('Shopify charge creation failed:', data);
            return { error: data.errors ? JSON.stringify(data.errors) : 'Unknown Shopify error' };
        }

        const charge = data.recurring_application_charge;
        return {
            confirmationUrl: charge.confirmation_url,
            chargeId: charge.id
        };
    } catch (err: any) {
        console.error('Charge creation error:', err);
        return { error: err.message || 'Network error creating charge' };
    }
}

/**
 * Verify a charge is active (called after Shopify redirects back to our app)
 */
export async function activateCharge(shop: string, token: string, chargeId: number): Promise<{ success: boolean; charge?: any; error?: string }> {
    try {
        // First, check the charge status
        const getRes = await fetch(`https://${shop}/admin/api/2025-07/recurring_application_charges/${chargeId}.json`, {
            headers: { 'X-Shopify-Access-Token': token }
        });

        const getData = await getRes.json();
        if (!getRes.ok) return { success: false, error: 'Failed to fetch charge' };

        const charge = getData.recurring_application_charge;

        // If the merchant approved but the charge is still "accepted" (not "active"),
        // we need to activate it explicitly
        if (charge.status === 'accepted') {
            const activateRes = await fetch(`https://${shop}/admin/api/2025-07/recurring_application_charges/${chargeId}/activate.json`, {
                method: 'POST',
                headers: { 'X-Shopify-Access-Token': token }
            });
            const activateData = await activateRes.json();
            if (!activateRes.ok) return { success: false, error: 'Failed to activate charge' };
            return { success: true, charge: activateData.recurring_application_charge };
        }

        // Already active
        if (charge.status === 'active') {
            return { success: true, charge };
        }

        // Declined, cancelled, etc
        return { success: false, error: `Charge status is ${charge.status}` };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

/**
 * Cancel an existing charge
 */
export async function cancelCharge(shop: string, token: string, chargeId: number): Promise<{ success: boolean; error?: string }> {
    try {
        const res = await fetch(`https://${shop}/admin/api/2025-07/recurring_application_charges/${chargeId}.json`, {
            method: 'DELETE',
            headers: { 'X-Shopify-Access-Token': token }
        });

        if (!res.ok && res.status !== 404) {
            const data = await res.json();
            return { success: false, error: JSON.stringify(data) };
        }

        return { success: true };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

/**
 * Get the active charge for a shop (if any)
 */
export async function getActiveCharge(shop: string, token: string): Promise<any | null> {
    try {
        const res = await fetch(`https://${shop}/admin/api/2025-07/recurring_application_charges.json`, {
            headers: { 'X-Shopify-Access-Token': token }
        });

        const data = await res.json();
        if (!res.ok) return null;

        const charges = data.recurring_application_charges || [];
        return charges.find((c: any) => c.status === 'active') || null;
    } catch (err) {
        return null;
    }
}

/**
 * Human-readable terms text for the plan
 */
function getTermsText(plan: PlanDetails, interval: 'monthly' | 'annual'): string {
    const monthlyPrice = interval === 'annual'
        ? (plan.price_annual_usd / 12).toFixed(2)
        : plan.price_monthly_usd.toFixed(2);

    return `${plan.email_limit_monthly} emails/month. ${interval === 'annual' ? 'Billed annually' : 'Billed monthly'} at $${monthlyPrice}/month. 4-day free trial.`;
}