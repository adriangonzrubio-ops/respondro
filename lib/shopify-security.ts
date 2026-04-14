import crypto from 'crypto';

export async function verifyShopifyWebhook(request: Request) {
    const hmac = request.headers.get('x-shopify-hmac-sha256');
    const secret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!hmac || !secret) return false;

    // We must use the raw body for HMAC verification
    const rawBody = await request.clone().text();
    
    const generatedHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('base64');

    return crypto.timingSafeEqual(
        Buffer.from(hmac),
        Buffer.from(generatedHmac)
    );
}