import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { order_id, order_number, refund_percentage, refund_amount, reason, message_id } = await req.json();

    if (!order_id && !order_number) {
      return NextResponse.json({ error: 'order_id or order_number required' }, { status: 400 });
    }

    // 1. Get store settings
    const { data: settings } = await supabase.from('settings').select('*').limit(1).single();
    if (!settings?.shop_url || !settings?.shopify_access_token) {
      return NextResponse.json({ error: 'Shopify not connected' }, { status: 400 });
    }

    const shop = settings.shop_url.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    const token = settings.shopify_access_token;

    // 2. Get the order (we need the full order data for refund calculation)
    let shopifyOrderId = order_id;
    
    if (!shopifyOrderId && order_number) {
      // Find order by order_number
      const cleanNum = String(order_number).replace('#', '').trim();
      const numericOrder = parseInt(cleanNum, 10);
      const res = await fetch(`https://${shop}/admin/api/2024-04/orders.json?status=any&limit=250`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const data = await res.json();
      const order = (data.orders || []).find((o: any) => o.order_number === numericOrder);
      if (!order) return NextResponse.json({ error: `Order #${order_number} not found` }, { status: 404 });
      shopifyOrderId = order.id;
    }

    // 3. Get full order details
    const orderRes = await fetch(`https://${shop}/admin/api/2024-04/orders/${shopifyOrderId}.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const orderData = await orderRes.json();
    const order = orderData.order;
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    // 4. Calculate refund amount
    const totalPrice = parseFloat(order.total_price);
    let actualRefundAmount: number;

    if (refund_percentage) {
      actualRefundAmount = Math.round((totalPrice * refund_percentage / 100) * 100) / 100;
    } else if (refund_amount) {
      actualRefundAmount = parseFloat(refund_amount);
    } else {
      // Full refund
      actualRefundAmount = totalPrice;
    }

    // Check if already refunded
    const alreadyRefunded = order.refunds?.reduce((sum: number, r: any) =>
      sum + r.transactions?.reduce((s: number, t: any) => s + parseFloat(t.amount || 0), 0), 0) || 0;

    const maxRefundable = totalPrice - alreadyRefunded;
    if (actualRefundAmount > maxRefundable) {
      return NextResponse.json({ 
        error: `Cannot refund ${actualRefundAmount}. Max refundable: ${maxRefundable.toFixed(2)} (already refunded: ${alreadyRefunded.toFixed(2)})` 
      }, { status: 400 });
    }

    // 5. Process the refund via Shopify API
    const refundPayload: any = {
      refund: {
        currency: order.currency,
        notify: false, // We'll send our own notification
        note: reason || `Refund processed via Respondro`,
        transactions: [{
          parent_id: order.transactions?.[0]?.id,
          amount: actualRefundAmount.toFixed(2),
          kind: 'refund',
          gateway: order.transactions?.[0]?.gateway || 'manual'
        }]
      }
    };

    const refundRes = await fetch(`https://${shop}/admin/api/2024-04/orders/${shopifyOrderId}/refunds.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(refundPayload)
    });

    const refundData = await refundRes.json();

    if (!refundRes.ok) {
      console.error('Shopify refund error:', JSON.stringify(refundData));
      return NextResponse.json({ 
        error: refundData.errors || refundData.error || 'Shopify refund failed' 
      }, { status: 400 });
    }

    // 6. Add a note to the Shopify order timeline
    const notePayload = {
      order: {
        id: shopifyOrderId,
        note: `${order.note ? order.note + '\n' : ''}[Respondro] Refund of ${order.currency} ${actualRefundAmount.toFixed(2)} processed. Reason: ${reason || 'Customer request'}`
      }
    };

    await fetch(`https://${shop}/admin/api/2024-04/orders/${shopifyOrderId}.json`, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(notePayload)
    });

    // 7. Update message if provided
    if (message_id) {
      await supabase.from('messages').update({
        ai_reasoning: `Refund of ${order.currency} ${actualRefundAmount.toFixed(2)} (${refund_percentage ? refund_percentage + '%' : 'custom amount'}) processed via Shopify.`
      }).eq('id', message_id);
    }

    return NextResponse.json({
      success: true,
      refund: {
        amount: actualRefundAmount.toFixed(2),
        currency: order.currency,
        order_number: order.order_number,
        percentage: refund_percentage || null
      }
    });

  } catch (error: any) {
    console.error('❌ Refund error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}