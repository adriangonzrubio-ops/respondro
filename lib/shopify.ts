export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanEmail = email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim();

        console.log(`📡 [SCOUT] Universal Fetch for: ${cleanEmail} at ${cleanShop}`);

        let orders = [];

        // 1. Search for Customer by Email to get their unique ID
        const customerSearch = await fetch(`https://${cleanShop}/admin/api/2024-01/customers/search.json?query=email:${cleanEmail}`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const customerData = await customerSearch.json();
        const customerId = customerData.customers?.[0]?.id;

        // 2. If customer exists, fetch ALL their orders
        if (customerId) {
            const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?customer_id=${customerId}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const orderData = await orderRes.json();
            orders = orderData.orders || [];
        }

        // 3. FALLBACK: Search by Order Name if email found nothing (e.g. #3296)
        if (orders.length === 0 && orderNumber) {
            const cleanNum = orderNumber.replace('#', '').trim();
            // Search for both "3296" and "#3296"
            const nameQuery = encodeURIComponent(`name:${cleanNum} OR name:#${cleanNum}`);
            const nameRes = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?query=${nameQuery}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const nameData = await nameRes.json();
            orders = nameData.orders || [];
        }

        // 4. Map for the UI
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
        console.error("❌ [SHOPIFY ERROR]:", error);
        return [];
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    const match = text.match(/(?:#|Order\s+)(\d{4,})/i);
    return match ? match[1] : undefined;
}