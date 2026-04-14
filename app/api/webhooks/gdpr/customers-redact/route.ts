import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    const customerEmail = payload.customer.email;

    console.log('🗑️ GDPR: Redacting customer data for', customerEmail);

    // Delete messages associated with this customer
    const { error } = await supabase
        .from('messages')
        .delete()
        .eq('sender', customerEmail);

    if (error) console.error('Error redacting customer:', error.message);

    return NextResponse.json({ message: "Redaction complete" }, { status: 200 });
}