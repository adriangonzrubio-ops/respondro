export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanEmail = email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim();

        console.log(`📡 [SCOUT] Fetching for ${cleanEmail} at ${cleanShop}`);

        // 1. Search by Email
        const emailQuery = encodeURIComponent(`email:${cleanEmail}`);
        const response = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?query=${emailQuery}&status=any`, {
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        let orders = data.orders || [];

        // 2. Fallback: Search by Order Number (More robust search)
        if (orders.length === 0 && orderNumber) {
            const cleanNum = orderNumber.replace('#', '').trim();
            // We search for both "3296" and "#3296" to be safe
            const nameQuery = encodeURIComponent(`name:${cleanNum} OR name:#${cleanNum}`);
            const nameRes = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?query=${nameQuery}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const nameData = await nameRes.json();
            orders = nameData.orders || [];
        }

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