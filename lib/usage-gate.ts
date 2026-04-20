// ═══════════════════════════════════════════════════════
// USAGE GATE — Plan enforcement before AI processing
// Called by the worker before each email to decide what's allowed
// ═══════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase';
import { decrypt } from './encryption';

export interface UsageDecision {
    canProcess: boolean;
    canAutoReply: boolean;
    canAutoRefund: boolean;
    canAutoCancel: boolean;
    canAutoAddress: boolean;
    maxAutoRefundUsd: number | null; // null = unlimited
    plan: string;
    subscriptionStatus: string;
    usagePercent: number;
    reason?: string; // populated when something is blocked
    storeId: string;
    // Settings data that the worker needs anyway
    storeName?: string;
    rulebook?: string;
    signature?: string;
    shopifyUrl?: string;
    shopifyToken?: string;
}

/**
 * The main gate function.
 * Call this BEFORE processing each email. Respect the result.
 */
export async function checkUsageAllowed(storeId: string): Promise<UsageDecision> {
    // Default "block everything" decision for fallback cases
    const blockAll: UsageDecision = {
        canProcess: false,
        canAutoReply: false,
        canAutoRefund: false,
        canAutoCancel: false,
        canAutoAddress: false,
        maxAutoRefundUsd: 0,
        plan: 'unknown',
        subscriptionStatus: 'unknown',
        usagePercent: 0,
        storeId,
        reason: 'Default block'
    };

    // 1. Load settings
    const { data: settings, error: settingsError } = await supabaseAdmin
        .from('settings')
        .select('*')
        .eq('store_id', storeId)
        .single();

    if (settingsError || !settings) {
        return { ...blockAll, reason: 'Settings not found' };
    }

    // 2. Load store for Shopify credentials
    const { data: store } = await supabaseAdmin
        .from('stores')
        .select('shopify_url, shopify_token')
        .eq('id', storeId)
        .single();

    // Decrypt the token once — all downstream usages get the plaintext
    const decryptedShopifyToken = store?.shopify_token ? decrypt(store.shopify_token) : undefined;

    // 3. Auto-reset counters if needed
    await resetCountersIfNeeded(storeId, settings);

    // Re-fetch settings after potential resets
    const { data: freshSettings } = await supabaseAdmin
        .from('settings')
        .select('*')
        .eq('store_id', storeId)
        .single();

    const s = freshSettings || settings;

    // 4. Check subscription status
    const status = s.subscription_status || 'trialing';

    if (status === 'cancelled' || status === 'frozen') {
        return {
            ...blockAll,
            subscriptionStatus: status,
            plan: s.plan_tier || 'unknown',
            storeName: s.store_name,
            rulebook: s.rulebook,
            signature: s.signature,
            shopifyUrl: store?.shopify_url,
            shopifyToken: decryptedShopifyToken,
            reason: `Subscription is ${status}`
        };
    }

    // 5. Check trial expiry (Option 1: hard block)
    const now = new Date();
    if (status === 'trialing') {
        const trialEnd = s.trial_ends_at ? new Date(s.trial_ends_at) : null;
        const hasCharge = !!s.shopify_charge_id;

        if (trialEnd && trialEnd < now && !hasCharge) {
            return {
                ...blockAll,
                subscriptionStatus: 'trial_expired',
                plan: 'trial',
                storeName: s.store_name,
                rulebook: s.rulebook,
                signature: s.signature,
                shopifyUrl: store?.shopify_url,
                shopifyToken: decryptedShopifyToken,
                reason: 'Trial expired — no active subscription'
            };
        }
    }

    // 6. Load plan details (either current paid plan or trial defaults)
    const planTier = s.plan_tier || 'trial';
    let plan: any = null;

    if (planTier === 'trial') {
        // During trial, use Scale-level features (they picked a tier during install or get full access)
        // But with a 15/day daily cap and 60 total over 4 days
        plan = {
            tier: 'trial',
            email_limit_monthly: 60, // 15/day × 4 days
            feature_auto_reply: true,
            feature_auto_refund: true,
            feature_auto_refund_max_usd: null,
            feature_auto_cancel: true,
            feature_auto_address: true
        };
    } else {
        const { data: dbPlan } = await supabaseAdmin
            .from('plans')
            .select('*')
            .eq('tier', planTier)
            .single();

        if (!dbPlan) {
            return {
                ...blockAll,
                reason: `Unknown plan tier: ${planTier}`,
                plan: planTier,
                subscriptionStatus: status,
                storeName: s.store_name,
                rulebook: s.rulebook,
                signature: s.signature,
                shopifyUrl: store?.shopify_url,
                shopifyToken: decryptedShopifyToken
            };
        }
        plan = dbPlan;
    }

    // 7. Check monthly usage
    const monthlyUsed = s.monthly_email_count || 0;
    const monthlyLimit = plan.email_limit_monthly;
    const usagePercent = Math.round((monthlyUsed / monthlyLimit) * 100);

    // Over limit? Block AI but still allow import
    if (monthlyUsed >= monthlyLimit) {
        return {
            canProcess: false,
            canAutoReply: false,
            canAutoRefund: false,
            canAutoCancel: false,
            canAutoAddress: false,
            maxAutoRefundUsd: 0,
            plan: planTier,
            subscriptionStatus: status,
            usagePercent,
            storeId,
            reason: `Monthly limit reached (${monthlyUsed}/${monthlyLimit})`,
            storeName: s.store_name,
            rulebook: s.rulebook,
            signature: s.signature,
            shopifyUrl: store?.shopify_url,
            shopifyToken: decryptedShopifyToken
        };
    }

    // 8. Check daily limit for trial only
    if (planTier === 'trial') {
        const dailyUsed = s.daily_email_count || 0;
        if (dailyUsed >= 15) {
            return {
                canProcess: false,
                canAutoReply: false,
                canAutoRefund: false,
                canAutoCancel: false,
                canAutoAddress: false,
                maxAutoRefundUsd: 0,
                plan: 'trial',
                subscriptionStatus: status,
                usagePercent,
                storeId,
                reason: 'Daily trial limit reached (15/day)',
                storeName: s.store_name,
                rulebook: s.rulebook,
                signature: s.signature,
                shopifyUrl: store?.shopify_url,
                shopifyToken: decryptedShopifyToken
            };
        }
    }

    // 9. Send 90% usage warning (once per billing cycle)
    await maybeSendUsageWarning(storeId, s, usagePercent, monthlyUsed, monthlyLimit);

    // 10. Respect merchant's own auto-* toggles (they can disable features even if plan allows)
    const merchantAllowsAutoReply = s.auto_reply_enabled !== false;
    const merchantAllowsAutoRefund = s.auto_refund_enabled === true;
    const merchantAllowsAutoCancel = s.auto_cancel_enabled === true;
    const merchantAllowsAutoAddress = s.auto_address_change_enabled === true;

    // Final decision: plan permits AND merchant hasn't disabled
    return {
        canProcess: true,
        canAutoReply: plan.feature_auto_reply && merchantAllowsAutoReply,
        canAutoRefund: plan.feature_auto_refund && merchantAllowsAutoRefund,
        canAutoCancel: plan.feature_auto_cancel && merchantAllowsAutoCancel,
        canAutoAddress: plan.feature_auto_address && merchantAllowsAutoAddress,
        maxAutoRefundUsd: plan.feature_auto_refund_max_usd, // null = unlimited
        plan: planTier,
        subscriptionStatus: status,
        usagePercent,
        storeId,
        storeName: s.store_name,
        rulebook: s.rulebook,
        signature: s.signature,
        shopifyUrl: store?.shopify_url,
        shopifyToken: decryptedShopifyToken
    };
}

/**
 * Increment usage counters after a successful AI draft (Option B — draft counts as processed)
 */
export async function incrementUsage(storeId: string): Promise<void> {
    try {
        // Atomic increment via SQL to avoid race conditions
        await supabaseAdmin.rpc('increment_email_usage', { p_store_id: storeId });
    } catch (err) {
        // RPC might not exist — fall back to read + update
        const { data: s } = await supabaseAdmin
            .from('settings')
            .select('daily_email_count, monthly_email_count')
            .eq('store_id', storeId)
            .single();

        if (s) {
            await supabaseAdmin
                .from('settings')
                .update({
                    daily_email_count: (s.daily_email_count || 0) + 1,
                    monthly_email_count: (s.monthly_email_count || 0) + 1
                })
                .eq('store_id', storeId);
        }
    }
}

/**
 * Reset daily/monthly counters if their reset window has passed
 */
async function resetCountersIfNeeded(storeId: string, settings: any): Promise<void> {
    const now = new Date();
    const updates: any = {};

    // Daily reset: 24 hours since last reset
    if (settings.daily_email_count_reset_at) {
        const lastDailyReset = new Date(settings.daily_email_count_reset_at);
        const hoursSinceReset = (now.getTime() - lastDailyReset.getTime()) / (1000 * 60 * 60);
        if (hoursSinceReset >= 24) {
            updates.daily_email_count = 0;
            updates.daily_email_count_reset_at = now.toISOString();
        }
    } else {
        // Initialize if never set
        updates.daily_email_count = 0;
        updates.daily_email_count_reset_at = now.toISOString();
    }

    // Monthly reset: past billing_cycle_end
    if (settings.billing_cycle_end) {
        const cycleEnd = new Date(settings.billing_cycle_end);
        if (now > cycleEnd) {
            updates.monthly_email_count = 0;
            updates.billing_cycle_start = now.toISOString();
            // Next cycle is 30 days from now
            updates.billing_cycle_end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
            updates.usage_warning_sent_at = null; // allow warning to fire again next cycle
        }
    }

    if (Object.keys(updates).length > 0) {
        await supabaseAdmin
            .from('settings')
            .update(updates)
            .eq('store_id', storeId);
    }
}

/**
 * Fire 90% usage warning notification once per billing cycle
 */
async function maybeSendUsageWarning(
    storeId: string,
    settings: any,
    usagePercent: number,
    used: number,
    limit: number
): Promise<void> {
    if (usagePercent < 90) return;

    // Check if warning already sent this cycle
    if (settings.usage_warning_sent_at) {
        const cycleStart = settings.billing_cycle_start ? new Date(settings.billing_cycle_start) : new Date(0);
        const warningSent = new Date(settings.usage_warning_sent_at);
        if (warningSent > cycleStart) return; // already sent this cycle
    }

    // Log the warning in billing_events (visible in merchant's notification feed)
    await supabaseAdmin.from('billing_events').insert({
        store_id: storeId,
        event_type: 'usage_warning_90_percent',
        raw_webhook_payload: {
            used,
            limit,
            percent: usagePercent,
            message: `You've used ${usagePercent}% of your monthly email quota (${used}/${limit}). Upgrade to avoid interruption.`
        }
    });

    // Mark as sent
    await supabaseAdmin
        .from('settings')
        .update({ usage_warning_sent_at: new Date().toISOString() })
        .eq('store_id', storeId);

    console.log(`⚠️ 90% usage warning logged for store ${storeId}`);
}