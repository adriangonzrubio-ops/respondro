import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getShopifyContext, extractOrderNumber } from '@/lib/shopify';

export async function POST(req: Request) {
    try {
        const { email, messageId, subject, body } = await req.json();

        if (!email && !messageId) {
            return NextResponse.json({ error: 'Need email or messageId' }, { status: 400 });
        }

        let storeId: string | null = null;
        let senderEmail = email;
        let senderName = '';
        let emailBody = (body || '') + ' ' + (subject || '');

        if (messageId) {
            const { data: msg } = await supabaseAdmin
                .from('messages')
                .select('store_id, sender, body_text, subject, shopify_data')
                .eq('id', messageId)
                .single();

            if (msg) {
                storeId = msg.store_id;
                senderEmail = email || msg.sender;
                emailBody = (msg.body_text || body || '') + ' ' + (msg.subject || subject || '');
                senderName = (msg.sender || '').split('<')[0].replace(/"/g, '').trim();

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
            const { data: stores } = await supabaseAdmin.from('stores').select('id').limit(1);
            storeId = stores?.[0]?.id || null;
        }

        if (!storeId) {
            return NextResponse.json({ orders: [], error: 'No store found' });
        }

        const { data: storeInfo } = await supabaseAdmin
            .from('stores')
            .select('shopify_url, shopify_token')
            .eq('id', storeId)
            .single();

        if (!storeInfo?.shopify_url || !storeInfo?.shopify_token) {
            return NextResponse.json({ orders: [], error: 'Shopify not connected' });
        }

        const orderNumber = extractOrderNumber(emailBody);
        console.log('🔍 Shopify Lookup:', { email: senderEmail, name: senderName, orderNumber });

        const orders = await getShopifyContext(
            storeInfo.shopify_url,
            storeInfo.shopify_token,
            senderEmail || '',
            orderNumber,
            senderName
        );

        if (messageId && orders.length > 0) {
            await supabaseAdmin
                .from('messages')
                .update({ shopify_data: orders })
                .eq('id', messageId);
        }

        return NextResponse.json({ orders, source: 'live' });

    } catch (err: any) {
        console.error('❌ Shopify lookup error:', err.message);
        return NextResponse.json({ orders: [], error: err.message }, { status: 500 });
    }
}