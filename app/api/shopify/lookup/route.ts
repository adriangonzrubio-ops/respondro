export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string, customerName?: string) {
    try {
        if (!shop || !token) return [];
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanEmail = email ? (email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim()) : '';

        let orders: any[] = [];

        // 1. Search by email
        if (cleanEmail) {
            const customerSearch = await fetch(`https://${cleanShop}/admin/api/2024-04/customers/search.json?query=email:${cleanEmail}`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const customerData = await customerSearch.json();
            const customerId = customerData.customers?.[0]?.id;

            if (customerId) {
                const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?customer_id=${customerId}&status=any`, {
                    headers: { 'X-Shopify-Access-Token': token }
                });
                const orderData = await orderRes.json();
                orders = orderData.orders || [];
            }
        }

        // 2. Fallback: search by customer name
        if (orders.length === 0 && customerName && customerName.length > 1) {
            const nameParts = customerName.split(' ').filter((p: string) => p.length > 1);
            if (nameParts.length > 0) {
                const nameQuery = nameParts.join(' ');
                const nameSearch = await fetch(`https://${cleanShop}/admin/api/2024-04/customers/search.json?query=${encodeURIComponent(nameQuery)}`, {
                    headers: { 'X-Shopify-Access-Token': token }
                });
                const nameData = await nameSearch.json();
                const nameCustomerId = nameData.customers?.[0]?.id;

                if (nameCustomerId) {
                    const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?customer_id=${nameCustomerId}&status=any`, {
                        headers: { 'X-Shopify-Access-Token': token }
                    });
                    const orderData = await orderRes.json();
                    orders = orderData.orders || [];
                }
            }
        }

        // 3. Fallback: search by order number from email body
        if (orders.length === 0 && orderNumber) {
            const cleanNum = String(orderNumber).replace('#', '').trim();
            const nameRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?name=${cleanNum}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const nameData = await nameRes.json();
            orders = nameData.orders || [];
        }

        // Deduplicate by order number
        const seen = new Set();
        const unique = orders.filter((o: any) => {
            if (seen.has(o.order_number)) return false;
            seen.add(o.order_number);
            return true;
        });

        return unique.map((o: any) => ({
            order_number: o.order_number,
            name: o.name,
            created_at: o.created_at,
            total_price: o.total_price,
            currency: o.currency,
            financial_status: o.financial_status || 'unknown',
            fulfillment_status: o.fulfillment_status || 'Unfulfilled',
            tracking_number: o.fulfillments?.[0]?.tracking_number || null,
            tracking_url: o.fulfillments?.[0]?.tracking_url || null,
            items: o.line_items.map((i: any) => i.title).join(', ')
        }));
    } catch (error) {
        console.error("❌ Shopify Scout Error:", error);
        return [];
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    const patterns = [
        /(?:#|order\s*#?\s*)(\d{4,})/i,
        /(?:order\s+number\s*:?\s*)(\d{4,})/i,
        /(?:ord\.?\s*#?\s*)(\d{4,})/i
    ];
    for (const p of patterns) {
        const match = text.match(p);
        if (match) return match[1];
    }
    return undefined;
}