/**
 * Generic Shopify Scout: 
 * Works for ANY store and ANY customer based on provided credentials.
 */
export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        // 1. Clean the Shop URL (SaaS Safe-Guard)
        const cleanShop = shop
            .replace(/^https?:\/\//, '') 
            .replace(/\/$/, '')          
            .trim();
        
        // 2. Clean the Email (Only declare this ONCE)
        const cleanEmail = email.includes('<') 
            ? email.split('<')[1].split('>')[0] 
            : email.trim();

        console.log(`📡 [SCOUT] Universal Fetch for: ${cleanEmail} at ${cleanShop}`);

        // 3. Primary Search: By Email
        const query = encodeURIComponent(`email:${cleanEmail}`);
        const response = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?query=${query}&status=any`, {
            headers: { 
                'X-Shopify-Access-Token': token, 
                'Content-Type': 'application/json' 
            }
        });

        const data = await response.json();
        let orders = data.orders || [];

        // 4. Fallback: Search by Order Number
        if (orders.length === 0 && orderNumber) {
            const cleanNum = orderNumber.replace('#', '').trim();
            const numResponse = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?name=${cleanNum}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const numData = await numResponse.json();
            orders = numData.orders || [];
        }

        // 5. Map results for UI
        return orders.map((o: any) => ({
            id: o.id,
            name: o.name,
            order_number: o.order_number,
            created_at: o.created_at,
            total_price: o.total_price,
            currency: o.currency,
            financial_status: o.financial_status,
            fulfillment_status: o.fulfillment_status || 'Unfulfilled',
            items: o.line_items.map((i: any) => i.title).join(', '),
            customer: { email: o.customer?.email, first_name: o.customer?.first_name }
        }));

    } catch (error) {
        console.error("❌ [SCOUT ERROR]:", error);
        return [];
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    const match = text.match(/(?:#|Order\s+)(\d{4,})/i);
    return match ? match[1] : undefined;
}