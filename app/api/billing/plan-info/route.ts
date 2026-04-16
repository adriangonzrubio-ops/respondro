import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/billing/plan-info?tier=starter
 * Returns public-facing plan details (features, limits, pricing).
 * Used by the dashboard to render usage meters and feature badges.
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const tier = searchParams.get('tier');

        if (!tier) {
            return NextResponse.json({ error: 'Missing tier' }, { status: 400 });
        }

        // Trial is a virtual plan, not in the plans table
        if (tier === 'trial') {
            return NextResponse.json({
                plan: {
                    tier: 'trial',
                    display_name: 'Free Trial',
                    email_limit_monthly: 60,
                    daily_limit: 15,
                    feature_auto_reply: true,
                    feature_auto_refund: true,
                    feature_auto_refund_max_usd: null,
                    feature_auto_cancel: true,
                    feature_auto_address: true
                }
            });
        }

        const { data: plan, error } = await supabaseAdmin
            .from('plans')
            .select('*')
            .eq('tier', tier)
            .single();

        if (error || !plan) {
            return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
        }

        return NextResponse.json({ plan });
    } catch (err: any) {
        console.error('plan-info error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}