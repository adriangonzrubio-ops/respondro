import crypto from 'crypto';

/**
 * Verifies Webhook HMAC (for GDPR and other events)
 */
export async function verifyShopifyWebhook(request: Request) {
    const hmac = request.headers.get('x-shopify-hmac-sha256');
    const secret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!hmac || !secret) return false;

    const rawBody = await request.clone().text();
    const generatedHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('base64');

    // Both buffers must be base64-decoded bytes with identical length,
    // otherwise timingSafeEqual throws.
    try {
        const hmacBuffer = Buffer.from(hmac, 'base64');
        const generatedBuffer = Buffer.from(generatedHmac, 'base64');
        if (hmacBuffer.length !== generatedBuffer.length) return false;
        return crypto.timingSafeEqual(hmacBuffer, generatedBuffer);
    } catch {
        return false;
    }
}

/**
 * Verifies OAuth HMAC (for the initial install/callback)
 */
export function verifyShopifyOAuth(queryParams: URLSearchParams) {
    const hmac = queryParams.get('hmac');
    const secret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!hmac || !secret) return false;

    const map = new Map(queryParams);
    map.delete('hmac');
    map.delete('signature');

    const sortedKeys = Array.from(map.keys()).sort();
    const message = sortedKeys
        .map(key => `${key}=${map.get(key)}`)
        .join('&');

    const generatedHmac = crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('hex');

    // 🛡️ SENIOR FIX: timingSafeEqual requires buffers of identical length
    const hmacBuffer = Buffer.from(hmac);
    const generatedBuffer = Buffer.from(generatedHmac);

    if (hmacBuffer.length !== generatedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(hmacBuffer, generatedBuffer);
}