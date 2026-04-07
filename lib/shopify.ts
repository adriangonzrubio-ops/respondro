export async function getOrderData(
  shopifyUrl: string,
  accessToken: string,
  orderNumber: string
) {
  try {
    const response = await fetch(
      `https://${shopifyUrl}/admin/api/2024-01/orders.json?name=%23${orderNumber}&status=any`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    )

    const data = await response.json()
    const order = data.orders?.[0]

    if (!order) return null

    return {
      orderNumber: order.name,
      status: order.fulfillment_status || 'unfulfilled',
      financialStatus: order.financial_status,
      createdAt: order.created_at,
      customer: {
        name: order.customer?.first_name + ' ' + order.customer?.last_name,
        email: order.customer?.email,
      },
      items: order.line_items?.map((item: any) => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price,
      })),
      tracking: order.fulfillments?.map((f: any) => ({
        company: f.tracking_company,
        number: f.tracking_number,
        url: f.tracking_url,
        status: f.shipment_status,
      })),
      shippingAddress: order.shipping_address,
      totalPrice: order.total_price,
      currency: order.currency,
    }
  } catch (error) {
    return null
  }
}

export function extractOrderNumber(emailBody: string): string | null {
  const patterns = [
    /#(\d{4,6})/,
    /order\s+#?(\d{4,6})/i,
    /bestelling\s+#?(\d{4,6})/i,
    /bestellung\s+#?(\d{4,6})/i,
    /commande\s+#?(\d{4,6})/i,
    /pedido\s+#?(\d{4,6})/i,
  ]

  for (const pattern of patterns) {
    const match = emailBody.match(pattern)
    if (match) return match[1]
  }

  return null
}
export async function getOrdersByEmail(shopifyUrl: string, accessToken: string, email: string) {
  try {
    // Search for orders matching the customer's email address
    const response = await fetch(
      `https://${shopifyUrl}/admin/api/2024-01/orders.json?email=${encodeURIComponent(email)}&status=any&limit=1`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    const order = data.orders?.[0];

    if (!order) return null;

    // Clean up the data for the AI to read easily
    return {
      orderNumber: order.name,
      status: order.fulfillment_status || 'unfulfilled',
      financialStatus: order.financial_status,
      total: `${order.total_price} ${order.currency}`,
      tracking: order.fulfillments?.map((f: any) => ({
        number: f.tracking_number,
        url: f.tracking_url,
        company: f.tracking_company
      })) || [],
      items: order.line_items.map((i: any) => i.name).join(', '),
      shippingAddress: `${order.shipping_address?.address1}, ${order.shipping_address?.city}`
    };
  } catch (error) {
    console.error("Shopify Lookup Error:", error);
    return null;
  }
}