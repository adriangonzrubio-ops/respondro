import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    const shopDomain = payload.shop_domain;

    console.log(`🚨 GDPR: Full Shop Redaction for ${shopDomain}`);

    try {
        // Log the request FIRST (before deleting the store)
        await supabaseAdmin.from('gdpr_requests').insert({
            shop_domain: shopDomain,
            request_type: 'shop_redact',
            payload: payload,
            status: 'received'
        });

        // Find the store
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('id')
            .eq('shopify_url', shopDomain)
            .single();

        if (store) {
            // Wipe everything belonging to this store
            await supabaseAdmin.from('messages').delete().eq('store_id', store.id);
            await supabaseAdmin.from('support_agents').delete().eq('store_id', store.id);
            await supabaseAdmin.from('settings').delete().eq('store_id', store.id);
            await supabaseAdmin.from('billing_events').delete().eq('store_id', store.id);
            await supabaseAdmin.from('stores').delete().eq('id', store.id);

            console.log(`✅ Shop data fully wiped for ${shopDomain}`);
        }

        // Mark audit log as complete
        await supabaseAdmin
            .from('gdpr_requests')
            .update({
                status: 'completed',
                completed_at: new Date().toISOString()
            })
            .eq('shop_domain', shopDomain)
            .eq('request_type', 'shop_redact');

        return NextResponse.json({ message: 'Shop data wiped' }, { status: 200 });
    } catch (error: any) {
        console.error('Shop redact error:', error);
        return NextResponse.json({ message: 'Error processing' }, { status: 200 });
    }
}