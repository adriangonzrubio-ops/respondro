export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanEmail = email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim();

        console.log(`📡 [SCOUT] Searching ${cleanShop} for ${cleanEmail}`);

        // 1. Find the Customer ID first
        const customerSearch = await fetch(`https://${cleanShop}/admin/api/2024-04/customers/search.json?query=email:${cleanEmail}`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const customerData = await customerSearch.json();
        const customerId = customerData.customers?.[0]?.id;

        let orders = [];

        // 2. Fetch orders by Customer ID
        if (customerId) {
            const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?customer_id=${customerId}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const orderData = await orderRes.json();
            orders = orderData.orders || [];
        }

        // 3. Fallback: Search by Order Name (e.g., #3296)
        if (orders.length === 0 && orderNumber) {
            const cleanNum = orderNumber.replace('#', '').trim();
            const nameRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?name=${cleanNum}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const nameData = await nameRes.json();
            orders = nameData.orders || [];
        }

        // 4. Return formatted data for the AI and UI
        return orders.map((o: any) => ({
            id: o.id,
            name: o.name,
            order_number: o.order_number,
            created_at: o.created_at,
            total_price: o.total_price,
            currency: o.currency,
            fulfillment_status: o.fulfillment_status || 'Unfulfilled',
            items: o.line_items.map((i: any) => i.title).join(', '),
            customer: { email: o.customer?.email, first_name: o.customer?.first_name }
        }));
    } catch (error) {
        console.error("Shopify Error:", error);
        return [];
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    const match = text.match(/(?:#|Order\s+)(\d{4,})/i);
    return match ? match[1] : undefined;
}