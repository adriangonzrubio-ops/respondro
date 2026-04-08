// 1. Extract Order Number from text (Helper)
export function extractOrderNumber(text: string): string | null {
    const patterns = [
        /#(\d{4,7})/,
        /order #(\d{4,7})/i,
        /bestilling #(\d{4,7})/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// 🛍️ Unified Scale-Ready Lookup (Replaces specific lookup functions)
export async function getShopifyContext(shopUrl: string, accessToken: string, email: string, orderNumber?: string | null) {
    try {
        let order = null;

        // 1. Try searching by Order Number first (High Precision)
        if (orderNumber) {
            // Shopify search is best when using the 'name' field with the prefix
            const cleanNumber = orderNumber.startsWith('#') ? orderNumber : `#${orderNumber}`;
            const response = await fetch(`https://${shopUrl}/admin/api/2024-04/orders.json?name=${encodeURIComponent(cleanNumber)}&status=any`, {
                headers: { 
                    'X-Shopify-Access-Token': accessToken, 
                    'Content-Type': 'application/json' 
                }
            });
            const data = await response.json();
            order = data.orders?.[0];
        }

        // 2. Fallback: Search by Email if no order found (The Safety Net)
        if (!order && email) {
            const response = await fetch(`https://${shopUrl}/admin/api/2024-04/orders.json?email=${encodeURIComponent(email)}&status=any&limit=1`, {
                headers: { 
                    'X-Shopify-Access-Token': accessToken, 
                    'Content-Type': 'application/json' 
                }
            });
            const data = await response.json();
            order = data.orders?.[0];
        }

        if (!order) return null;

        // Return standardized data for the Review Board sidebar
        return {
            order_number: order.name,
            total_price: order.total_price,
            currency: order.currency,
            fulfillment_status: order.fulfillment_status || 'Paid',
            created_at: order.created_at,
            tracking_number: order.fulfillments?.[0]?.tracking_number || 'No tracking yet',
            customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
            items: order.line_items.map((item: any) => item.name).join(', ')
        };
    } catch (error) {
        console.error("Shopify Unified Lookup Error:", error);
        return null;
    }
}