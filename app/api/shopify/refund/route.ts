import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { decrypt } from '@/lib/encryption';

export async function POST(req: Request) {
  try {
    const { order_id, order_number, refund_percentage, refund_amount, reason, message_id } = await req.json();

    if (!order_id && !order_number) {
      return NextResponse.json({ error: 'order_id or order_number required' }, { status: 400 });
    }

    const { data: store } = await supabaseAdmin.from('stores').select('id, shopify_url, shopify_token').limit(1).single();
    if (!store?.shopify_url || !store?.shopify_token) {
      return NextResponse.json({ error: 'Shopify not connected' }, { status: 400 });
    }

    const shop = store.shopify_url.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    const token = decrypt(store.shopify_token);

    let shopifyOrderId = order_id;

    if (!shopifyOrderId && order_number) {
      const cleanNum = String(order_number).replace('#', '').trim();
      const numericOrder = parseInt(cleanNum, 10);
      const res = await fetch(`https://${shop}/admin/api/2025-07/orders.json?status=any&limit=250`, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const data = await res.json();
      const order = (data.orders || []).find((o: any) => o.order_number === numericOrder);
      if (!order) return NextResponse.json({ error: `Order #${order_number} not found` }, { status: 404 });
      shopifyOrderId = order.id;
    }

    const orderRes = await fetch(`https://${shop}/admin/api/2025-07/orders/${shopifyOrderId}.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const orderData = await orderRes.json();
    const order = orderData.order;
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    const txnRes = await fetch(`https://${shop}/admin/api/2025-07/orders/${shopifyOrderId}/transactions.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const txnData = await txnRes.json();
    order.transactions = txnData.transactions || order.transactions || [];

    const totalPrice = parseFloat(order.total_price_set?.presentment_money?.amount || order.total_price);
    let actualRefundAmount: number;

    const alreadyRefunded = order.refunds?.reduce((sum: number, r: any) =>
      sum + r.transactions?.reduce((s: number, t: any) => s + parseFloat(t.amount || 0), 0), 0) || 0;
    const maxRefundable = totalPrice - alreadyRefunded;

    if (refund_amount) {
      actualRefundAmount = Math.min(parseFloat(refund_amount), maxRefundable);
    } else if (refund_percentage) {
      actualRefundAmount = Math.round((maxRefundable * refund_percentage / 100) * 100) / 100;
    } else {
      actualRefundAmount = maxRefundable;
    }

    if (actualRefundAmount > maxRefundable) {
      return NextResponse.json({
        error: `Cannot refund ${actualRefundAmount}. Max refundable: ${maxRefundable.toFixed(2)} (already refunded: ${alreadyRefunded.toFixed(2)})`
      }, { status: 400 });
    }

    const parentTransaction = order.transactions?.find((t: any) =>
      t.kind === 'sale' && t.status === 'success'
    ) || order.transactions?.find((t: any) =>
      t.kind === 'capture' && t.status === 'success'
    ) || order.transactions?.[0];

    if (!parentTransaction) {
      return NextResponse.json({ error: 'No valid payment transaction found on this order' }, { status: 400 });
    }

    const refundCurrency = order.presentment_currency || order.currency;

    const refundRes = await fetch(`https://${shop}/admin/api/2025-07/orders/${shopifyOrderId}/refunds.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        refund: {
          currency: refundCurrency,
          notify: false,
          note: reason || 'Refund processed via Respondro',
          transactions: [{
            parent_id: parentTransaction.id,
            amount: actualRefundAmount.toFixed(2),
            kind: 'refund',
            gateway: parentTransaction.gateway
          }]
        }
      })
    });

    const refundData = await refundRes.json();

    if (!refundRes.ok) {
      console.error('Shopify refund error:', JSON.stringify(refundData));
      return NextResponse.json({
        error: refundData.errors || refundData.error || 'Shopify refund failed'
      }, { status: 400 });
    }

    await fetch(`https://${shop}/admin/api/2025-07/orders/${shopifyOrderId}.json`, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        order: {
          id: shopifyOrderId,
          note: `${order.note ? order.note + '\n' : ''}[Respondro] Refund of ${refundCurrency} ${actualRefundAmount.toFixed(2)} processed. Reason: ${reason || 'Customer request'}`
        }
      })
    });

    if (message_id) {
      await supabaseAdmin.from('messages').update({
        ai_reasoning: `Refund of ${refundCurrency} ${actualRefundAmount.toFixed(2)} (${refund_percentage ? refund_percentage + '%' : 'custom amount'}) processed via Shopify.`
      }).eq('id', message_id);
    }

    // Log AI action (fails silently, never blocks flow)
    if (store?.id) {
      try {
        const { logAiAction, extractEmail, extractName } = await import('@/lib/ai-action-logger');
        let customerEmail: string | undefined;
        let customerName: string | undefined;
        let subject: string | undefined;
        if (message_id) {
          const { data: msg } = await supabaseAdmin.from('messages').select('sender, subject').eq('id', message_id).single();
          if (msg) {
            customerEmail = extractEmail(msg.sender);
            customerName = extractName(msg.sender);
            subject = msg.subject || undefined;
          }
        }
        await logAiAction({
          storeId: store.id,
          messageId: message_id || undefined,
          actionType: 'refund_issued',
          summary: `Issued refund ${refundCurrency} ${actualRefundAmount.toFixed(2)}${order.order_number ? ` for Order #${order.order_number}` : ''}`,
          customerEmail,
          customerName,
          subject,
          details: {
            amount: actualRefundAmount,
            currency: refundCurrency,
            order_number: order.order_number || null,
            percentage: refund_percentage || null,
            reason: reason || null
          }
        });
      } catch (logErr) {
        console.error('Logging error (non-blocking):', logErr);
      }
    }

    return NextResponse.json({
      success: true,
      refund: {
        amount: actualRefundAmount.toFixed(2),
        currency: refundCurrency,
        order_number: order.order_number,
        percentage: refund_percentage || null
      }
    });

  } catch (error: any) {
    console.error('❌ Refund error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}