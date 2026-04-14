import { NextResponse } from 'next/server';
import { verifyShopifyWebhook } from '@/lib/shopify-security';

export async function POST(req: Request) {
    const isValid = await verifyShopifyWebhook(req);
    if (!isValid) return new Response('Unauthorized', { status: 401 });

    const payload = await req.json();
    console.log('📦 GDPR: Customer Data Request received', payload.customer.email);

    // TODO: If you store specific customer notes in your DB, 
    // you would fetch them here and send them to the merchant's email.
    
    return NextResponse.json({ message: "Data request received" }, { status: 200 });
}