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

// 2. Lookup by Order Number (REST API)
export async function getOrderData(shopUrl: string, accessToken: string, orderNumber: string) {
    try {
        const cleanNumber = orderNumber.replace('#', '');
        const response = await fetch(`https://${shopUrl}/admin/api/2024-04/orders.json?name=${cleanNumber}&status=any`, {
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
            },
        });

        const data = await response.json();
        const order = data.orders?.[0];

        if (!order) return null;

        return {
            order_number: order.name,
            total_price: order.total_price,
            fulfillment_status: order.fulfillment_status || 'Unfulfilled',
            financial_status: order.financial_status,
            created_at: order.created_at,
            tracking_number: order.fulfillments?.[0]?.tracking_number || 'No tracking yet',
            customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
            items: order.line_items.map((item: any) => item.name).join(', ')
        };
    } catch (error) {
        console.error("Shopify Order Lookup Error:", error);
        return null;
    }
}

// 3. Lookup by Customer Email (REST API)
export async function getCustomerOrders(shopUrl: string, accessToken: string, email: string) {
    try {
        const response = await fetch(`https://${shopUrl}/admin/api/2024-04/orders.json?email=${encodeURIComponent(email)}&status=any&limit=1`, {
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
            },
        });

        const data = await response.json();
        const order = data.orders?.[0];

        if (!order) return null;

        return {
            order_number: order.name,
            total_price: order.total_price,
            fulfillment_status: order.fulfillment_status || 'Paid',
            created_at: order.created_at,
            tracking_number: order.fulfillments?.[0]?.tracking_number || 'No tracking yet',
            customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim()
        };
    } catch (error) {
        console.error("Shopify Email Lookup Error:", error);
        return null;
    }
}