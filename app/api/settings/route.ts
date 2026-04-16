import { NextResponse } from 'next/server';
import { supabase, supabaseAdmin } from '@/lib/supabase';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

/**
 * Helper: Get the current logged-in user's store.
 * Uses the Authorization header from the request to identify the user.
 */
async function getCurrentStore(request: Request): Promise<{ store: any; error?: string }> {
    try {
        const authHeader = request.headers.get('authorization');
        const cookieHeader = request.headers.get('cookie') || '';

        // Try to get session from Authorization header (preferred) or cookies
        let userEmail: string | null = null;

        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.replace('Bearer ', '');
            // Create a temporary client with the user's JWT to identify them
            const tempClient = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                { global: { headers: { Authorization: `Bearer ${token}` } } }
            );
            const { data: { user } } = await tempClient.auth.getUser();
            userEmail = user?.email || null;
        }

        // Fallback: try to extract from Supabase session cookies
        if (!userEmail) {
            const sbCookieMatch = cookieHeader.match(/sb-[a-z0-9]+-auth-token=([^;]+)/);
            if (sbCookieMatch) {
                try {
                    const cookieValue = decodeURIComponent(sbCookieMatch[1]);
                    const parsed = JSON.parse(cookieValue.replace(/^base64-/, ''));
                    userEmail = parsed?.user?.email || null;
                } catch (e) { /* ignore */ }
            }
        }

        if (!userEmail) {
            return { store: null, error: 'Not authenticated' };
        }

        // Find store by email
        const { data: store, error } = await supabaseAdmin
            .from('stores')
            .select('*')
            .eq('email', userEmail)
            .single();

        if (error || !store) {
            return { store: null, error: 'Store not found for user' };
        }

        return { store };
    } catch (err: any) {
        return { store: null, error: err.message };
    }
}

export async function GET(request: Request) {
    try {
        const { store, error: authError } = await getCurrentStore(request);
        if (!store) {
            return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
        }

        // Load settings scoped to this store
        const { data: settings } = await supabaseAdmin
            .from('settings')
            .select('*')
            .eq('store_id', store.id)
            .single();

        // Load email connection scoped to this store
        const { data: connections } = await supabaseAdmin
            .from('user_connections')
            .select('*')
            .eq('store_id', store.id);
        const emailConn = connections?.find(c => c.imap_host || c.gmail_access_token);

        const responseData = {
            // Branding
            rulebook: settings?.rulebook || store?.rulebook || '',
            signature: settings?.signature || '',
            logo_url: settings?.logo_url || '',
            logo_width: settings?.logo_width || '120',
            store_name: settings?.store_name || store?.store_name || '',
            sidebar_logo_dark: settings?.sidebar_logo_dark || '',
            sidebar_logo_light: settings?.sidebar_logo_light || '',

            // Connections
            has_shopify: !!store?.shopify_token,
            shop_url: store?.shopify_url || '',
            has_email: !!emailConn,
            connected_email: emailConn?.email || '',
            imap_host: emailConn?.imap_host || '',
            store_id: store?.id || null,

            // Autonomy settings
            auto_reply_enabled: settings?.auto_reply_enabled || false,
            auto_refund_enabled: settings?.auto_refund_enabled || false,
            auto_cancel_enabled: settings?.auto_cancel_enabled || false,
            auto_address_change_enabled: settings?.auto_address_change_enabled || false,
            auto_reply_delay_minutes: settings?.auto_reply_delay_minutes || 5,
            max_auto_refund_amount: settings?.max_auto_refund_amount || 50,

            // Billing/subscription data (new — required for trial banner + usage meter)
            plan_tier: settings?.plan_tier || 'trial',
            plan_interval: settings?.plan_interval || 'monthly',
            subscription_status: settings?.subscription_status || 'trialing',
            trial_started_at: settings?.trial_started_at || null,
            trial_ends_at: settings?.trial_ends_at || null,
            shopify_charge_id: settings?.shopify_charge_id || null,
            billing_cycle_start: settings?.billing_cycle_start || null,
            billing_cycle_end: settings?.billing_cycle_end || null,
            daily_email_count: settings?.daily_email_count || 0,
            monthly_email_count: settings?.monthly_email_count || 0
        };

        return NextResponse.json(responseData);
    } catch (error: any) {
        console.error('GET /api/settings error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const { store, error: authError } = await getCurrentStore(request);
        if (!store) {
            return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();

        // Build update object — scoped to this store's settings only
        const updateData: any = { store_id: store.id };

        // Branding fields
        if (body.rulebook !== undefined) updateData.rulebook = body.rulebook;
        if (body.logo_url !== undefined) updateData.logo_url = body.logo_url;
        if (body.logo_width !== undefined) updateData.logo_width = body.logo_width;
        if (body.signature !== undefined) updateData.signature = body.signature;
        if (body.store_name !== undefined) updateData.store_name = body.store_name;

        // Autonomy fields
        if (body.auto_reply_enabled !== undefined) updateData.auto_reply_enabled = body.auto_reply_enabled;
        if (body.auto_refund_enabled !== undefined) updateData.auto_refund_enabled = body.auto_refund_enabled;
        if (body.auto_cancel_enabled !== undefined) updateData.auto_cancel_enabled = body.auto_cancel_enabled;
        if (body.auto_address_change_enabled !== undefined) updateData.auto_address_change_enabled = body.auto_address_change_enabled;
        if (body.auto_reply_delay_minutes !== undefined) updateData.auto_reply_delay_minutes = body.auto_reply_delay_minutes;
        if (body.max_auto_refund_amount !== undefined) updateData.max_auto_refund_amount = body.max_auto_refund_amount;
        if (body.sidebar_logo_dark !== undefined) updateData.sidebar_logo_dark = body.sidebar_logo_dark;
        if (body.sidebar_logo_light !== undefined) updateData.sidebar_logo_light = body.sidebar_logo_light;

        // IMPORTANT: Billing fields (plan_tier, subscription_status, etc.) are NOT allowed via this endpoint.
        // Those can only be set by the Shopify billing callback or webhooks.

        const { data, error } = await supabaseAdmin
            .from('settings')
            .upsert(updateData, { onConflict: 'store_id' })
            .select();

        if (error) throw error;
        return NextResponse.json({ message: 'Settings saved!', data });
    } catch (error: any) {
        console.error('POST /api/settings error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}