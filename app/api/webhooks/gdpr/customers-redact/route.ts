import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    const shopDomain = payload.shop_domain;
    const customerEmail = payload.customer?.email;

    console.log(`🗑️ GDPR: Redacting customer data for ${customerEmail} from ${shopDomain}`);

    try {
        // Log the request
        await supabaseAdmin.from('gdpr_requests').insert({
            shop_domain: shopDomain,
            request_type: 'customers_redact',
            customer_email: customerEmail,
            payload: payload,
            status: 'received'
        });

        // Find the store
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('id')
            .eq('shopify_url', shopDomain)
            .single();

        if (store && customerEmail) {
            // Delete all messages from this customer for this specific shop only
            const { error } = await supabaseAdmin
                .from('messages')
                .delete()
                .eq('store_id', store.id)
                .ilike('sender', `%${customerEmail}%`);

            if (error) {
                console.error('Error redacting customer:', error.message);
            } else {
                await supabaseAdmin
                    .from('gdpr_requests')
                    .update({
                        status: 'completed',
                        completed_at: new Date().toISOString()
                    })
                    .eq('shop_domain', shopDomain)
                    .eq('customer_email', customerEmail)
                    .eq('request_type', 'customers_redact');
            }
        }

        return NextResponse.json({ message: 'Redaction complete' }, { status: 200 });
    } catch (error: any) {
        console.error('Customer redact error:', error);
        return NextResponse.json({ message: 'Error processing' }, { status: 200 });
    }
}