// app/api/shopify/lookup/route.ts
// New endpoint: lets the Review Board fetch live Shopify data for any customer

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getShopifyContext, extractOrderNumber } from '@/lib/shopify';

export async function POST(req: NextRequest) {
    try {
        const { email, messageId } = await req.json();

        if (!email && !messageId) {
            return NextResponse.json({ error: 'Need email or messageId' }, { status: 400 });
        }

        // Get store_id from the message (or from auth — simplified here)
        let storeId: string | null = null;
        let senderEmail = email;

        if (messageId) {
            const { data: msg } = await supabase
                .from('messages')
                .select('store_id, sender, shopify_data')
                .eq('id', messageId)
                .single();

            if (msg) {
                storeId = msg.store_id;
                senderEmail = email || msg.sender;

                // Return cached data if it exists and looks good
                if (msg.shopify_data) {
                    const cached = typeof msg.shopify_data === 'string'
                        ? JSON.parse(msg.shopify_data)
                        : msg.shopify_data;
                    const orders = Array.isArray(cached) ? cached : [cached];
                    if (orders.length > 0 && orders[0]?.order_number) {
                        return NextResponse.json({ orders, source: 'cache' });
                    }
                }
            }
        }

        if (!storeId) {
            // Fallback: get the first store (single-tenant fallback)
            const { data: stores } = await supabase.from('stores').select('id').limit(1);
            storeId = stores?.[0]?.id || null;
        }

        if (!storeId) {
            return NextResponse.json({ orders: [], error: 'No store found' });
        }

        // Get Shopify credentials
        const { data: storeInfo } = await supabase
            .from('stores')
            .select('shopify_url, shopify_token')
            .eq('id', storeId)
            .single();

        if (!storeInfo?.shopify_url || !storeInfo?.shopify_token) {
            return NextResponse.json({ orders: [], error: 'Shopify not connected' });
        }

        // Fetch live Shopify data
        const orders = await getShopifyContext(
            storeInfo.shopify_url,
            storeInfo.shopify_token,
            senderEmail || '',
            undefined
        );

        // Cache the result back to the message row
        if (messageId && orders.length > 0) {
            await supabase
                .from('messages')
                .update({ shopify_data: orders[0] })  // cache the most recent order
                .eq('id', messageId);
        }

        return NextResponse.json({ orders, source: 'live' });

    } catch (err: any) {
        console.error('❌ Shopify lookup error:', err.message);
        return NextResponse.json({ orders: [], error: err.message }, { status: 500 });
    }
}