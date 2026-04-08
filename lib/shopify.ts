/**
 * Ultra-Scout: Fetches customer order context from Shopify.
 * Handles email sanitization and provides a fallback search by Order Number.
 */
export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string) {
    try {
        // 1. Clean the Inputs (Crucial for API success)
        const cleanShop = shop.replace('https://', '').replace('http://', '').replace(/\/$/, '');
        
        // Extract "robert@example.com" from "Robert Pettit <robert@example.com>"
        const cleanEmail = email.includes('<') 
            ? email.split('<')[1].split('>')[0] 
            : email.trim();

        console.log(`📡 Scout: Searching ${cleanShop} for ${cleanEmail}...`);

        // 2. Primary Search: Look up orders by Email
        const query = encodeURIComponent(`email:${cleanEmail}`);
        const response = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?query=${query}&status=any`, {
            headers: { 
                'X-Shopify-Access-Token': token, 
                'Content-Type': 'application/json' 
            }
        });

        const data = await response.json();
        let orders = data.orders || [];

        // 3. Fallback Search: If email found nothing, try the Order Number (e.g., #3259)
        if (orders.length === 0 && orderNumber) {
            const cleanNum = orderNumber.replace('#', '').trim();
            console.log(`🔍 Scout Fallback: Searching for Order #${cleanNum}...`);
            
            const numResponse = await fetch(`https://${cleanShop}/admin/api/2024-01/orders.json?name=${cleanNum}&status=any`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const numData = await numResponse.json();
            orders = numData.orders || [];
        }

        // 4. Transform Data: Return exactly what the Respondro UI needs
        return orders.map((o: any) => ({
            id: o.id,
            name: o.name,
            order_number: o.order_number,
            created_at: o.created_at,
            total_price: o.total_price,
            currency: o.currency,
            financial_status: o.financial_status,
            fulfillment_status: o.fulfillment_status || 'Unfulfilled',
            // Combines all items into one readable string
            items: o.line_items.map((i: any) => i.title).join(', '),
            customer: { 
                email: o.customer?.email, 
                first_name: o.customer?.first_name 
            }
        }));

    } catch (error) {
        console.error("❌ Scout Failed:", error);
        return []; // Return empty array so the app doesn't crash
    }
}
export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    // Look for a hash followed by numbers, or the word "Order" followed by numbers
    const match = text.match(/(?:#|Order\s+)(\d{4,})/i);
    return match ? match[1] : undefined;
}