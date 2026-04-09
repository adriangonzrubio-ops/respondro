export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        if (!shop || !token || !email) return [];
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanEmail = email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim();

        // 1. Search for Customer
        const customerSearch = await fetch(`https://${cleanShop}/admin/api/2024-04/customers/search.json?query=email:${cleanEmail}`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const customerData = await customerSearch.json();
        const customerId = customerData.customers?.[0]?.id;

        let orders = [];
        if (customerId) {
            const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?customer_id=${customerId}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const orderData = await orderRes.json();
            orders = orderData.orders || [];
        }

        // 2. Fallback by Order Number
        if (orders.length === 0 && orderNumber) {
            const cleanNum = String(orderNumber).replace('#', '').trim();
            const nameRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?name=${cleanNum}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const nameData = await nameRes.json();
            orders = nameData.orders || [];
        }

        return orders.map((o: any) => ({
            order_number: o.order_number,
            name: o.name,
            created_at: o.created_at,
            total_price: o.total_price,
            currency: o.currency,
            fulfillment_status: o.fulfillment_status || 'Unfulfilled',
            items: o.line_items.map((i: any) => i.title).join(', ')
        }));
    } catch (error) {
        console.error("❌ Shopify Scout Error:", error);
        return [];
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    const match = text.match(/(?:#|Order\s+)(\d{4,})/i);
    return match ? match[1] : undefined;
}