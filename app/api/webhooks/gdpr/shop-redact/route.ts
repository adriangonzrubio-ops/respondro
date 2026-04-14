import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    const shopDomain = payload.shop_domain;

    console.log('🚨 GDPR: Full Shop Redaction for', shopDomain);

    // 1. Find the store ID
    const { data: store } = await supabase
        .from('stores')
        .select('id')
        .eq('shopify_url', shopDomain)
        .single();

    if (store) {
        // 2. Wipe everything linked to this store
        await supabase.from('messages').delete().eq('store_id', store.id);
        await supabase.from('settings').delete().eq('store_id', store.id);
        await supabase.from('stores').delete().eq('id', store.id);
    }

    return NextResponse.json({ message: "Shop data wiped" }, { status: 200 });
}