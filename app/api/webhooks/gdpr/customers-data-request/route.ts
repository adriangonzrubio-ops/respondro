import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    const shopDomain = payload.shop_domain;
    const customerEmail = payload.customer?.email;

    console.log(`📦 GDPR data request from ${shopDomain} for customer ${customerEmail}`);

    try {
        // Log the request in the audit table
        await supabaseAdmin.from('gdpr_requests').insert({
            shop_domain: shopDomain,
            request_type: 'customers_data_request',
            customer_email: customerEmail,
            payload: payload,
            status: 'received'
        });

        // Find all messages from this customer for this shop
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('id')
            .eq('shopify_url', shopDomain)
            .single();

        if (store && customerEmail) {
            // Gather all data we have on this customer
            const { data: messages } = await supabaseAdmin
                .from('messages')
                .select('subject, body_text, received_at, sent_reply, sent_at')
                .eq('store_id', store.id)
                .ilike('sender', `%${customerEmail}%`);

            // Mark as complete with the data gathered
            await supabaseAdmin
                .from('gdpr_requests')
                .update({
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    payload: { ...payload, data_found: messages }
                })
                .eq('shop_domain', shopDomain)
                .eq('customer_email', customerEmail)
                .eq('request_type', 'customers_data_request');

            console.log(`✅ GDPR data request processed: ${messages?.length || 0} records found`);
        }

        return NextResponse.json({ message: 'Data request received' }, { status: 200 });
    } catch (error: any) {
        console.error('GDPR data request error:', error);
        return NextResponse.json({ message: 'Error processing request' }, { status: 200 });
    }
}