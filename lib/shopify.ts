export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        // 1. UNIVERSAL SaaS Clean: Standardize any URL input to the store domain
        const cleanShop = shop
            .replace(/^https?:\/\//, '') // Remove protocols
            .replace(/\/$/, '')          // Remove trailing slash
            .trim();
        
        // 2. Extract clean email (Handles "Name <email@address.com>")
        const cleanEmail = email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim();

        console.log(`📡 [SCOUT] Attempting fetch for ${cleanEmail} at https://${cleanShop}/admin/`);

        // 3. Robust Customer Search
        const customerSearchRes = await fetch(`https://${cleanShop}/admin/api/2024-01/customers/search.json?query=email:${cleanEmail}`, {
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
        });
        
        // Logging the response code is key to finding the error
        console.log(`📡 [SCOUT] Customer Search Status: ${customerSearchRes.status}`);
        
        const customerData = await customerSearchRes.json();
        const customer = customerData.customers?.[0];

        let orders = [];

        // 4. If customer found, fetch ALL their orders
        if (customer?.id) {
            const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?customer_id=${customer.id}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            console.log(`📡 [SCOUT] Orders Search Status: ${orderRes.status}`);
            const orderData = await orderRes.json();
            orders = orderData.orders || [];
        }

        // 5. Robust Fallback: Search by Order Name (e.g. #3296)
        if (orders.length === 0 && orderNumber) {
            console.log(`📡 [SCOUT] No customer found, attempting fallback search for: ${orderNumber}`);
            // Search by exact name.
            const nameRes = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?name=${orderNumber}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            console.log(`📡 [SCOUT] Fallback Search Status: ${nameRes.status}`);
            const nameData = await nameRes.json();
            orders = nameData.orders || [];
        }

        // 6. Return mapped results for UI
        if (orders.length > 0) {
            console.log(`✅ [SCOUT] Found ${orders.length} orders for ${cleanEmail}`);
        } else {
            console.warn(`⚠️ [SCOUT] No orders found for ${cleanEmail}`);
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

    } catch (error: any) {
        console.error("❌ [SHOPIFY ERROR]:", error.message || error);
        return []; // Return empty array to prevent application crash
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    // Looking for a # followed by numbers, or "Order" followed by numbers
    const match = text.match(/(?:#|Order\s+)(\d{4,})/i);
    // Return the whole string with the # if it exists
    return match ? match[0] : undefined;
}