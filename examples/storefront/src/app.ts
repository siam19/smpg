import { Hono } from 'hono';
import { SMPG } from 'send-money-payment-gateway';
import { OrderStore } from './db';

export function createStorefrontApp(smpgClient?: SMPG) {
  const app = new Hono();

  const smpg =
    smpgClient ||
    new SMPG(process.env.SMPG_API_KEY || 'smpg_test_mock', {
      baseUrl: process.env.SMPG_BASE_URL || 'https://smpg-core.fhasan-gch.workers.dev',
      webhookSecret: process.env.SMPG_WEBHOOK_SECRET || 'test_webhook_secret',
    });

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', service: 'reference-storefront' }));

  // 1. Initiate Checkout (Golden Rule 1: Order created BEFORE payment session)
  app.post('/api/checkout', async (c) => {
    const body = await c.req.json();
    const { customerName, customerPhone, items, method } = body;

    const totalAmount = items.reduce(
      (sum: number, item: { price: number; quantity: number }) => sum + item.price * item.quantity,
      0
    );

    const orderId = `ORD-${Date.now().toString().slice(-6)}`;

    // Create local order in PENDING_PAYMENT status
    const order = OrderStore.create({
      id: orderId,
      customerName,
      customerPhone,
      items,
      totalAmount,
    });

    // Create SMPG Payment Session
    const origin = new URL(c.req.url).origin;
    const payment = await smpg.payments.create({
      amount: totalAmount,
      method: method || undefined,
      external_order_id: order.id,
      customer: {
        name: customerName,
        phone: customerPhone,
      },
      success_url: `${origin}/orders/${order.id}/thanks`,
      cancel_url: `${origin}/cart`,
    });

    // Store payment ID with order
    OrderStore.update(order.id, {
      smpgPaymentId: payment.id,
      paymentMethod: method,
    });

    return c.json({
      orderId: order.id,
      paymentId: payment.id,
      checkoutUrl: payment.checkout_url,
      assignedWallet: payment.assigned_wallet,
      amount: payment.amount,
    }, 201);
  });

  // 2. Submit TrxID from custom embedded checkout box
  app.post('/api/checkout/submit', async (c) => {
    const { paymentId, trxId, orderId } = await c.req.json();

    const payment = await smpg.payments.submit(paymentId, {
      trx_id: trxId,
    });

    // Golden Rule 2: Move order to AWAITING_VERIFICATION (NEVER to PAID yet)
    OrderStore.update(orderId, {
      status: 'AWAITING_VERIFICATION',
      trxId,
    });

    return c.json({
      orderId,
      status: 'AWAITING_VERIFICATION',
      paymentStatus: payment.status,
    });
  });

  // 3. Order Details (Golden Rule 5: Server-side source of truth)
  app.get('/api/orders/:id', (c) => {
    const id = c.req.param('id');
    const order = OrderStore.get(id);

    if (!order) {
      return c.json({ error: 'Order not found' }, 404);
    }

    return c.json({ order });
  });

  // 4. SMPG Webhook Receiver (Golden Rules 3, 4, 5, 6)
  app.post('/api/webhooks/smpg', async (c) => {
    const signature = c.req.header('smpg-signature');

    if (!signature) {
      return c.text('Missing SMPG-Signature header', 400);
    }

    // Must verify on RAW request body string
    const rawBody = await c.req.text();

    let event;
    try {
      event = await smpg.webhooks.constructEvent(rawBody, signature);
    } catch (err: any) {
      return c.text(`Invalid webhook signature: ${err.message}`, 400);
    }

    // Golden Rule 4: Idempotent processing
    if (OrderStore.isEventProcessed(event.id)) {
      return c.json({ received: true, deduplicated: true }, 200);
    }

    const orderId = event.data.external_order_id;
    if (!orderId) {
      return c.text('Missing external_order_id in event data', 400);
    }

    const order = OrderStore.get(orderId);
    if (!order) {
      return c.text(`Order ${orderId} not found`, 404);
    }

    // Apply state transition based on verified event type
    switch (event.type) {
      case 'payment.paid':
        OrderStore.update(orderId, {
          status: 'PAID',
          paidAt: new Date(),
        });
        break;

      case 'payment.confirmed':
        OrderStore.update(orderId, {
          status: 'COD_CONFIRMED',
        });
        break;

      case 'payment.rejected':
        OrderStore.update(orderId, {
          status: 'PAYMENT_REJECTED',
          retryUrl: event.data.retry_url,
        });
        break;

      case 'payment.cancelled':
      case 'payment.expired':
        OrderStore.update(orderId, {
          status: 'CANCELLED',
        });
        break;
    }

    OrderStore.markEventProcessed(event.id);
    return c.json({ received: true }, 200);
  });

  return app;
}
