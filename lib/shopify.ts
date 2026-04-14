// ═══════════════════════════════════════════════
// SHOPIFY LIBRARY — READ + WRITE (MUTATIONS)
// ═══════════════════════════════════════════════

// ── READ FUNCTIONS (existing) ──

export async function getShopifyContext(shop: string, token: string, email: string, orderNumber?: string, customerName?: string) {
    try {
        if (!shop || !token) return [];
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanEmail = email ? (email.includes('<') ? email.split('<')[1].split('>')[0] : email.trim()) : '';

        let orders: any[] = [];
        console.log('🛍️ Shopify Search:', { cleanShop, cleanEmail, orderNumber, customerName });

        // 1. Search by order number FIRST (most specific)
        if (orderNumber) {
            const cleanNum = String(orderNumber).replace('#', '').trim();
            const numericOrder = parseInt(cleanNum, 10);
            
            const allRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?status=any&limit=250`, {
                headers: { 'X-Shopify-Access-Token': token }
            });
            const allData = await allRes.json();
            const allOrders = allData.orders || [];
            orders = allOrders.filter((o: any) => o.order_number === numericOrder || o.name === `#${cleanNum}` || o.name === cleanNum);
            console.log('🔎 Order number search result:', orders.length, 'orders found for number:', orderNumber, 'out of', allOrders.length, 'total orders');
        }

        // 2. Search by email
        if (orders.length === 0 && cleanEmail) {
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

        // 3. Fallback: search by customer name
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

        // Deduplicate by order number
        const seen = new Set();
        const unique = orders.filter((o: any) => {
            if (seen.has(o.order_number)) return false;
            seen.add(o.order_number);
            return true;
        });

        return unique.map((o: any) => {
            const isCancelled = !!o.cancelled_at;
            const totalRefunded = o.refunds?.reduce((sum: number, r: any) =>
                sum + r.transactions?.reduce((s: number, t: any) => s + parseFloat(t.amount || 0), 0), 0) || 0;

            let displayStatus = o.fulfillment_status || 'Unfulfilled';
            if (isCancelled) displayStatus = 'Cancelled';

            return {
                id: o.id,
                order_number: o.order_number,
                name: o.name,
                created_at: o.created_at,
                total_price: o.total_price_set?.presentment_money?.amount || o.total_price,
                currency: o.presentment_currency || o.currency,
                financial_status: o.financial_status || 'unknown',
                fulfillment_status: displayStatus,
                cancelled: isCancelled,
                cancelled_at: o.cancelled_at || null,
                refunded_amount: totalRefunded > 0 ? totalRefunded.toFixed(2) : null,
                tracking_number: o.fulfillments?.[0]?.tracking_number || null,
                tracking_url: o.fulfillments?.[0]?.tracking_url || null,
                items: o.line_items.map((i: any) => i.title).join(', ')
            };
        });
    } catch (error) {
        console.error("❌ Shopify Scout Error:", error);
        return [];
    }
}

export function extractOrderNumber(text: string): string | undefined {
    if (!text) return undefined;
    const patterns = [
        /(?:#)(\d{3,})/i,
        /(?:order\s*#?\s*)(\d{3,})/i,
        /(?:order\s+\w+\s*)(\d{3,})/i,
        /(?:order\s+number\s*:?\s*)(\d{3,})/i,
        /(?:ord\.?\s*#?\s*)(\d{3,})/i,
        /\b(\d{4,})\b/
    ];
    for (const p of patterns) {
        const match = text.match(p);
        if (match) return match[1];
    }
    return undefined;
}


// ═══════════════════════════════════════════════
// MUTATION FUNCTIONS — Shopify Write Operations
// ═══════════════════════════════════════════════

export interface ActionResult {
    success: boolean;
    action: string;
    details: string;
    data?: any;
}

/**
 * Execute a refund on a Shopify order
 */
export async function executeRefund(shop: string, token: string, orderNumber: string, amount?: number): Promise<ActionResult> {
    try {
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanNum = String(orderNumber).replace('#', '').trim();
        const numericOrder = parseInt(cleanNum, 10);

        // Find the order
        const allRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?status=any&limit=250`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const allData = await allRes.json();
        const order = (allData.orders || []).find((o: any) => o.order_number === numericOrder);
        if (!order) return { success: false, action: 'refund', details: `Order #${orderNumber} not found in Shopify` };

        // Get full order with transactions
        const orderRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders/${order.id}.json`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const orderData = await orderRes.json();
        const fullOrder = orderData.order;

        const txnRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders/${order.id}/transactions.json`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const txnData = await txnRes.json();
        fullOrder.transactions = txnData.transactions || [];

        // Calculate refund amount
        const totalPrice = parseFloat(fullOrder.total_price_set?.presentment_money?.amount || fullOrder.total_price);
        const alreadyRefunded = fullOrder.refunds?.reduce((sum: number, r: any) =>
            sum + r.transactions?.reduce((s: number, t: any) => s + parseFloat(t.amount || 0), 0), 0) || 0;
        const maxRefundable = totalPrice - alreadyRefunded;

        let refundAmount = amount || maxRefundable; // Default to full remaining
        if (refundAmount > maxRefundable) refundAmount = maxRefundable;
        if (refundAmount <= 0) return { success: false, action: 'refund', details: `Order #${orderNumber} has already been fully refunded` };

        // Find parent transaction
        const parentTransaction = fullOrder.transactions?.find((t: any) => t.kind === 'sale' && t.status === 'success')
            || fullOrder.transactions?.find((t: any) => t.kind === 'capture' && t.status === 'success')
            || fullOrder.transactions?.[0];

        if (!parentTransaction) return { success: false, action: 'refund', details: 'No valid payment transaction found' };

        const currency = fullOrder.presentment_currency || fullOrder.currency;

        // Execute refund
        const refundRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders/${order.id}/refunds.json`, {
            method: 'POST',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                refund: {
                    currency,
                    notify: false,
                    note: 'Refund processed by Respondro AI',
                    transactions: [{
                        parent_id: parentTransaction.id,
                        amount: refundAmount.toFixed(2),
                        kind: 'refund',
                        gateway: parentTransaction.gateway
                    }]
                }
            })
        });

        const refundData = await refundRes.json();
        if (!refundRes.ok) {
            return { success: false, action: 'refund', details: `Shopify refund failed: ${JSON.stringify(refundData.errors || refundData.error)}` };
        }

        // Add note to order
        await fetch(`https://${cleanShop}/admin/api/2024-04/orders/${order.id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: { id: order.id, note: `${fullOrder.note ? fullOrder.note + '\n' : ''}[Respondro AI] Refund of ${currency} ${refundAmount.toFixed(2)} processed automatically.` } })
        });

        console.log(`✅ AI Refund: ${currency} ${refundAmount.toFixed(2)} on order #${orderNumber}`);
        return {
            success: true,
            action: 'refund',
            details: `Refunded ${currency} ${refundAmount.toFixed(2)} on order #${orderNumber}`,
            data: { amount: refundAmount.toFixed(2), currency, order_number: orderNumber }
        };
    } catch (err: any) {
        return { success: false, action: 'refund', details: `Refund error: ${err.message}` };
    }
}

/**
 * Cancel a Shopify order (only works on unfulfilled orders)
 */
export async function cancelOrder(shop: string, token: string, orderNumber: string): Promise<ActionResult> {
    try {
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanNum = String(orderNumber).replace('#', '').trim();
        const numericOrder = parseInt(cleanNum, 10);

        // Find the order
        const allRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?status=any&limit=250`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const allData = await allRes.json();
        const order = (allData.orders || []).find((o: any) => o.order_number === numericOrder);
        if (!order) return { success: false, action: 'cancel', details: `Order #${orderNumber} not found` };

        // Check if already cancelled
        if (order.cancelled_at) return { success: false, action: 'cancel', details: `Order #${orderNumber} is already cancelled` };

        // Check if fulfilled (can't cancel fulfilled orders)
        if (order.fulfillment_status === 'fulfilled') {
            return { success: false, action: 'cancel', details: `Order #${orderNumber} is already fulfilled and cannot be cancelled. Customer needs to request a return instead.` };
        }

        // Cancel the order
        const cancelRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders/${order.id}/cancel.json`, {
            method: 'POST',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'customer', email: true })
        });

        const cancelData = await cancelRes.json();
        if (!cancelRes.ok) {
            return { success: false, action: 'cancel', details: `Shopify cancel failed: ${JSON.stringify(cancelData.errors || cancelData.error)}` };
        }

        const currency = order.presentment_currency || order.currency;
        const totalPrice = order.total_price_set?.presentment_money?.amount || order.total_price;

        console.log(`✅ AI Cancel: Order #${orderNumber} cancelled`);
        return {
            success: true,
            action: 'cancel',
            details: `Order #${orderNumber} has been cancelled. Refund of ${currency} ${totalPrice} will be processed automatically by Shopify.`,
            data: { order_number: orderNumber, total: totalPrice, currency }
        };
    } catch (err: any) {
        return { success: false, action: 'cancel', details: `Cancel error: ${err.message}` };
    }
}

/**
 * Update the shipping address on a Shopify order (only unfulfilled)
 */
export async function updateShippingAddress(shop: string, token: string, orderNumber: string, newAddress: any): Promise<ActionResult> {
    try {
        const cleanShop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        const cleanNum = String(orderNumber).replace('#', '').trim();
        const numericOrder = parseInt(cleanNum, 10);

        // Find the order
        const allRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders.json?status=any&limit=250`, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        const allData = await allRes.json();
        const order = (allData.orders || []).find((o: any) => o.order_number === numericOrder);
        if (!order) return { success: false, action: 'address_change', details: `Order #${orderNumber} not found` };

        // Check if already fulfilled
        if (order.fulfillment_status === 'fulfilled') {
            return { success: false, action: 'address_change', details: `Order #${orderNumber} is already shipped. Address cannot be changed after fulfillment.` };
        }

        // Build the address object
        const addressPayload: any = {
            shipping_address: {}
        };

        // If newAddress is a string, parse it into components
        if (typeof newAddress === 'string') {
            addressPayload.shipping_address.address1 = newAddress;
        } else {
            // Structured address object
            if (newAddress.address1) addressPayload.shipping_address.address1 = newAddress.address1;
            if (newAddress.address2) addressPayload.shipping_address.address2 = newAddress.address2;
            if (newAddress.city) addressPayload.shipping_address.city = newAddress.city;
            if (newAddress.province) addressPayload.shipping_address.province = newAddress.province;
            if (newAddress.zip) addressPayload.shipping_address.zip = newAddress.zip;
            if (newAddress.country) addressPayload.shipping_address.country = newAddress.country;
            if (newAddress.name) addressPayload.shipping_address.name = newAddress.name;
            if (newAddress.first_name) addressPayload.shipping_address.first_name = newAddress.first_name;
            if (newAddress.last_name) addressPayload.shipping_address.last_name = newAddress.last_name;
        }

        // Update the order
        const updateRes = await fetch(`https://${cleanShop}/admin/api/2024-04/orders/${order.id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: { id: order.id, ...addressPayload, note: `${order.note ? order.note + '\n' : ''}[Respondro AI] Shipping address updated per customer request.` } })
        });

        const updateData = await updateRes.json();
        if (!updateRes.ok) {
            return { success: false, action: 'address_change', details: `Address update failed: ${JSON.stringify(updateData.errors || updateData.error)}` };
        }

        const newAddr = typeof newAddress === 'string' ? newAddress : `${newAddress.address1 || ''}, ${newAddress.city || ''}, ${newAddress.zip || ''}, ${newAddress.country || ''}`;
        console.log(`✅ AI Address Change: Order #${orderNumber} → ${newAddr}`);
        return {
            success: true,
            action: 'address_change',
            details: `Shipping address for order #${orderNumber} updated to: ${newAddr}`,
            data: { order_number: orderNumber, new_address: newAddr }
        };
    } catch (err: any) {
        return { success: false, action: 'address_change', details: `Address change error: ${err.message}` };
    }
}