import { describe, expect, test, beforeEach } from 'bun:test';
import { SMPG, type Payment, type PaymentMethod } from 'send-money-payment-gateway';
import { createStorefrontApp } from '../src/app';
import { OrderStore } from '../src/db';

describe('Reference Storefront Integration & Embedded Checkout', () => {
  const webhookSecret = 'test_secret_for_storefront_verification_12345';
  let mockPayments: Map<string, Payment>;
  let mockApp: ReturnType<typeof createStorefrontApp>;

  beforeEach(() => {
    OrderStore.reset();
    mockPayments = new Map();

    const mockSmpg = new SMPG('smpg_test_key_storefront', {
      baseUrl: 'http://mock-smpg.internal',
      webhookSecret,
    });

    // Mock payments.create
    mockSmpg.payments.create = async (params) => {
      const id = `pay_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const payment: Payment = {
        id,
        store_id: 'str_test_store',
        mode: 'test',
        external_order_id: params.external_order_id ?? null,
        method: params.method ?? null,
        available_methods: ['bkash', 'nagad', 'cod'],
        amount: params.amount,
        status: params.method === 'cod' ? 'CONFIRMED' : 'CREATED',
        assigned_wallet:
          params.method === 'bkash'
            ? {
                id: 'wal_bkash_1',
                provider: 'bkash',
                number: '01785863769',
                label: 'Personal',
              }
            : null,
        success_url: params.success_url ?? null,
        cancel_url: params.cancel_url ?? null,
        attempts: 0,
        attempts_remaining: 3,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        created_at: new Date().toISOString(),
      };
      mockPayments.set(id, payment);
      return payment;
    };

    // Mock payments.selectMethod
    mockSmpg.payments.selectMethod = async (paymentId: string, method: PaymentMethod) => {
      const payment = mockPayments.get(paymentId);
      if (!payment) throw new Error('Payment not found');
      payment.method = method;
      if (method === 'cod') {
        payment.status = 'CONFIRMED';
        payment.assigned_wallet = null;
      } else {
        payment.assigned_wallet = {
          id: `wal_${method}_1`,
          provider: method,
          number: method === 'bkash' ? '01785863769' : '01812345678',
          label: 'Primary',
        };
      }
      return payment;
    };

    // Mock payments.submit
    mockSmpg.payments.submit = async (paymentId: string, params) => {
      const payment = mockPayments.get(paymentId);
      if (!payment) throw new Error('Payment not found');
      payment.status = 'SUBMITTED';
      payment.trx_id = params.trx_id;
      payment.sender_number = params.sender_number ?? null;
      payment.attempts = (payment.attempts ?? 0) + 1;
      payment.attempts_remaining = Math.max(0, 3 - payment.attempts);
      return payment;
    };

    mockApp = createStorefrontApp(mockSmpg);
  });

  async function generateSignatureHeader(
    payload: string,
    secret: string,
    timestamp?: number
  ): Promise<string> {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const signedPayload = `${ts}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const signatureHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `t=${ts},v1=${signatureHex}`;
  }

  test('Checklist 1: Order is created BEFORE payment session with external_order_id', async () => {
    const res = await mockApp.request('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Ayesha Rahman',
        customerPhone: '01711223344',
        items: [{ id: 'item_1', name: 'Cotton Panjabi', price: 1850, quantity: 1 }],
        method: 'bkash',
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();

    const order = OrderStore.get(data.orderId);
    expect(order).toBeDefined();
    expect(order?.status).toBe('PENDING_PAYMENT');
    expect(order?.totalAmount).toBe(1850);
    expect(order?.smpgPaymentId).toBe(data.paymentId);
    expect(data.checkoutPath).toBe(`/checkout/${data.orderId}`);
    expect(data.orderPath).toBe(`/orders/${data.orderId}`);

    const payment = mockPayments.get(data.paymentId);
    expect(payment?.external_order_id).toBe(order?.id);
    expect(data.assignedWallet?.number).toBe('01785863769');
  });

  test('Checklist 2: Custom embedded checkout flow (select method -> submit TrxID -> AWAITING_VERIFICATION)', async () => {
    // 1. Create order without pre-selecting method
    const checkoutRes = await mockApp.request('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Tanvir Ahmed',
        customerPhone: '01811223344',
        items: [{ id: 'item_2', name: 'Linen Kurti', price: 1200, quantity: 1 }],
      }),
    });
    const { orderId, paymentId } = await checkoutRes.json();

    // 2. Render embedded checkout HTML page
    const pageRes = await mockApp.request(`/checkout/${orderId}`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain(orderId);
    expect(html).toContain('1200');
    expect(html).toContain('data-method="bkash"');
    expect(html).toContain('data-method="nagad"');
    expect(html).toContain('data-method="cod"');
    expect(html).toContain('/api/checkout/submit');

    // 3. Customer selects bKash via embedded checkout box
    const methodRes = await mockApp.request('/api/checkout/method', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, paymentId, method: 'bkash' }),
    });
    expect(methodRes.status).toBe(200);
    const methodData = await methodRes.json();
    expect(methodData.assignedWallet?.number).toBe('01785863769');

    // 4. Customer submits TrxID
    const submitRes = await mockApp.request('/api/checkout/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        paymentId,
        trxId: 'BK123TRX99',
        senderNumber: '01811223344',
      }),
    });

    expect(submitRes.status).toBe(200);
    const submitData = await submitRes.json();
    expect(submitData.status).toBe('AWAITING_VERIFICATION');

    const order = OrderStore.get(orderId);
    expect(order?.status).toBe('AWAITING_VERIFICATION');
    expect(order?.status).not.toBe('PAID');
    expect(order?.trxId).toBe('BK123TRX99');
  });

  test('Checklist 3 & 4: Webhook verifies x-smpg-signature on raw body and handles events idempotently', async () => {
    const order = OrderStore.create({
      id: 'ORD-WH-TEST',
      customerName: 'Fahim',
      customerPhone: '01911223344',
      items: [{ id: 'item_1', name: 'Silk Scarf', price: 950, quantity: 1 }],
      totalAmount: 950,
    });
    OrderStore.update(order.id, { status: 'AWAITING_VERIFICATION' });

    const rawPayload = JSON.stringify({
      id: 'evt_unique_101',
      type: 'payment.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        id: 'pay_wh_1',
        store_id: 'str_test_store',
        external_order_id: 'ORD-WH-TEST',
        amount: 950,
        status: 'PAID',
      },
    });

    const signature = await generateSignatureHeader(rawPayload, webhookSecret);

    const res = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': signature,
      },
      body: rawPayload,
    });

    expect(res.status).toBe(200);
    const updatedOrder = OrderStore.get('ORD-WH-TEST');
    expect(updatedOrder?.status).toBe('PAID');
    expect(updatedOrder?.paidAt).toBeDefined();

    // Idempotency replay
    const replayRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': signature,
      },
      body: rawPayload,
    });

    expect(replayRes.status).toBe(200);
    const replayData = await replayRes.json();
    expect(replayData.deduplicated).toBe(true);
  });

  test('Checklist 3 (Security): Webhook rejects missing/invalid x-smpg-signature and stale timestamps', async () => {
    const rawPayload = JSON.stringify({
      id: 'evt_stale_1',
      type: 'payment.paid',
      data: { external_order_id: 'ORD-123' },
    });

    // Missing header (or legacy header name)
    const missingRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawPayload,
    });
    expect(missingRes.status).toBe(400);

    // Invalid signature
    const invalidRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': 't=1731500000,v1=bad_signature_hash',
      },
      body: rawPayload,
    });
    expect(invalidRes.status).toBe(400);

    // Stale timestamp (10 minutes ago)
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const staleSignature = await generateSignatureHeader(rawPayload, webhookSecret, tenMinutesAgo);

    const staleRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': staleSignature,
      },
      body: rawPayload,
    });
    expect(staleRes.status).toBe(400);
  });

  test('Checklist 5: Handles payment.rejected (storefront retry page) and payment.reopened', async () => {
    const order = OrderStore.create({
      id: 'ORD-RETRY-01',
      customerName: 'Samir',
      customerPhone: '01611223344',
      items: [{ id: 'item_1', name: 'Shoes', price: 3200, quantity: 1 }],
      totalAmount: 3200,
    });
    OrderStore.update(order.id, {
      status: 'AWAITING_VERIFICATION',
      smpgPaymentId: 'pay_rej_1',
      assignedWallet: {
        id: 'wal_1',
        provider: 'bkash',
        number: '01785863769',
        label: 'Personal',
      },
    });

    // 1. payment.rejected links customer to storefront's own /orders/:orderId retry page
    const rejectedPayload = JSON.stringify({
      id: 'evt_rej_202',
      type: 'payment.rejected',
      created: Math.floor(Date.now() / 1000),
      data: {
        id: 'pay_rej_1',
        store_id: 'str_test_store',
        external_order_id: 'ORD-RETRY-01',
        amount: 3200,
        status: 'REJECTED',
        attempts: 1,
        attempts_remaining: 2,
      },
    });
    const rejSig = await generateSignatureHeader(rejectedPayload, webhookSecret);

    const rejRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': rejSig,
      },
      body: rejectedPayload,
    });

    expect(rejRes.status).toBe(200);
    const rejectedOrder = OrderStore.get('ORD-RETRY-01');
    expect(rejectedOrder?.status).toBe('PAYMENT_REJECTED');
    expect(rejectedOrder?.retryUrl).toBe('/orders/ORD-RETRY-01');

    // Verify /orders/:orderId renders the inline retry form
    const orderPageRes = await mockApp.request('/orders/ORD-RETRY-01');
    expect(orderPageRes.status).toBe(200);
    const orderHtml = await orderPageRes.text();
    expect(orderHtml).toContain('PAYMENT_REJECTED');
    expect(orderHtml).toContain('id="retry-form"');
    expect(orderHtml).toContain('01785863769');

    // 2. payment.reopened moves order back to AWAITING_VERIFICATION
    const reopenedPayload = JSON.stringify({
      id: 'evt_reopen_203',
      type: 'payment.reopened',
      created: Math.floor(Date.now() / 1000),
      data: {
        id: 'pay_rej_1',
        store_id: 'str_test_store',
        external_order_id: 'ORD-RETRY-01',
        amount: 3200,
        status: 'SUBMITTED',
      },
    });
    const reopenSig = await generateSignatureHeader(reopenedPayload, webhookSecret);

    const reopenRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': reopenSig,
      },
      body: reopenedPayload,
    });

    expect(reopenRes.status).toBe(200);
    expect(OrderStore.get('ORD-RETRY-01')?.status).toBe('AWAITING_VERIFICATION');
  });

  test('Checklist 6: COD payment.confirmed and order details endpoint', async () => {
    OrderStore.create({
      id: 'ORD-COD-99',
      customerName: 'Nadia',
      customerPhone: '01311223344',
      items: [{ id: 'item_1', name: 'Tea Set', price: 1450, quantity: 1 }],
      totalAmount: 1450,
    });

    const codPayload = JSON.stringify({
      id: 'evt_cod_301',
      type: 'payment.confirmed',
      created: Math.floor(Date.now() / 1000),
      data: {
        id: 'pay_cod_1',
        store_id: 'str_test_store',
        external_order_id: 'ORD-COD-99',
        method: 'cod',
        amount: 1450,
        status: 'CONFIRMED',
      },
    });
    const codSig = await generateSignatureHeader(codPayload, webhookSecret);

    const whRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smpg-signature': codSig,
      },
      body: codPayload,
    });
    expect(whRes.status).toBe(200);

    const res = await mockApp.request('/api/orders/ORD-COD-99');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.order.id).toBe('ORD-COD-99');
    expect(data.order.customerName).toBe('Nadia');
    expect(data.order.status).toBe('COD_CONFIRMED');
  });
});
