import { describe, expect, test, beforeEach } from 'bun:test';
import { SMPG } from '@smpg/sdk';
import { createStorefrontApp } from '../src/app';
import { OrderStore } from '../src/db';

describe('Milestone M4: Storefront Integration Acceptance Checklist', () => {
  const webhookSecret = 'test_secret_for_m4_verification_12345';
  let mockPayments: Map<string, any>;
  let mockApp: any;

  beforeEach(() => {
    OrderStore.reset();
    mockPayments = new Map();

    const mockSmpg = new SMPG('smpg_test_key_m4', {
      baseUrl: 'http://mock-smpg.internal',
      webhookSecret,
    });

    // Mock payments.create
    mockSmpg.payments.create = async (params: any) => {
      const id = `pay_mock_${Date.now()}`;
      const payment = {
        id,
        merchant_id: 'mrc_test',
        mode: 'test',
        external_order_id: params.external_order_id,
        method: params.method || null,
        amount: params.amount,
        status: params.method === 'cod' ? 'CONFIRMED' : 'CREATED',
        assigned_wallet: params.method === 'bkash' ? {
          id: 'wal_1',
          provider: 'bkash',
          number: '01785863769',
          label: 'Personal',
        } : null,
        checkout_url: `https://checkout.example/c/${id}`,
        success_url: params.success_url,
        cancel_url: params.cancel_url,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        created_at: new Date().toISOString(),
      };
      mockPayments.set(id, payment);
      return payment as any;
    };

    // Mock payments.submit
    mockSmpg.payments.submit = async (paymentId: string, params: any) => {
      const payment = mockPayments.get(paymentId);
      if (!payment) throw new Error('Payment not found');
      payment.status = 'SUBMITTED';
      payment.trx_id = params.trx_id;
      return payment;
    };

    mockApp = createStorefrontApp(mockSmpg);
  });

  async function generateSignatureHeader(payload: string, secret: string, timestamp?: number): Promise<string> {
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

    // Verify order exists in DB in PENDING_PAYMENT status
    const order = OrderStore.get(data.orderId);
    expect(order).toBeDefined();
    expect(order?.status).toBe('PENDING_PAYMENT');
    expect(order?.totalAmount).toBe(1850);
    expect(order?.smpgPaymentId).toBe(data.paymentId);

    // Verify payment was passed order.id
    const payment = mockPayments.get(data.paymentId);
    expect(payment.external_order_id).toBe(order?.id);
    expect(data.assignedWallet?.number).toBe('01785863769');
  });

  test('Checklist 2: Submission moves order to AWAITING_VERIFICATION (never PAID)', async () => {
    // 1. Create order & payment
    const checkoutRes = await mockApp.request('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Tanvir Ahmed',
        customerPhone: '01811223344',
        items: [{ id: 'item_2', name: 'Linen Kurti', price: 1200, quantity: 1 }],
        method: 'bkash',
      }),
    });
    const { orderId, paymentId } = await checkoutRes.json();

    // 2. Customer submits TrxID
    const submitRes = await mockApp.request('/api/checkout/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId,
        paymentId,
        trxId: 'BK123TRX99',
      }),
    });

    expect(submitRes.status).toBe(200);
    const submitData = await submitRes.json();
    expect(submitData.status).toBe('AWAITING_VERIFICATION');

    // Verify order is strictly AWAITING_VERIFICATION, NOT PAID
    const order = OrderStore.get(orderId);
    expect(order?.status).toBe('AWAITING_VERIFICATION');
    expect(order?.status).not.toBe('PAID');
    expect(order?.trxId).toBe('BK123TRX99');
  });

  test('Checklist 3 & 4: Webhook verifies signature on raw body and handles events idempotently', async () => {
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
        external_order_id: 'ORD-WH-TEST',
        amount: 950,
        status: 'PAID',
      },
    });

    const signature = await generateSignatureHeader(rawPayload, webhookSecret);

    // 1. Process valid webhook
    const res = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'smpg-signature': signature,
      },
      body: rawPayload,
    });

    expect(res.status).toBe(200);
    const updatedOrder = OrderStore.get('ORD-WH-TEST');
    expect(updatedOrder?.status).toBe('PAID');
    expect(updatedOrder?.paidAt).toBeDefined();

    // 2. Idempotency: replay the same event
    const replayRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'smpg-signature': signature,
      },
      body: rawPayload,
    });

    expect(replayRes.status).toBe(200);
    const replayData = await replayRes.json();
    expect(replayData.deduplicated).toBe(true);
  });

  test('Checklist 3 (Security): Webhook rejects invalid signatures and stale timestamps (> 5 min)', async () => {
    const rawPayload = JSON.stringify({
      id: 'evt_stale_1',
      type: 'payment.paid',
      data: { external_order_id: 'ORD-123' },
    });

    // 1. Invalid signature
    const invalidRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'smpg-signature': 't=1731500000,v1=bad_signature_hash',
      },
      body: rawPayload,
    });
    expect(invalidRes.status).toBe(400);

    // 2. Stale timestamp (10 minutes ago)
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const staleSignature = await generateSignatureHeader(rawPayload, webhookSecret, tenMinutesAgo);

    const staleRes = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'smpg-signature': staleSignature,
      },
      body: rawPayload,
    });
    expect(staleRes.status).toBe(400);
  });

  test('Checklist 5: Handles payment.rejected event with customer retry_url', async () => {
    const order = OrderStore.create({
      id: 'ORD-RETRY-01',
      customerName: 'Samir',
      customerPhone: '01611223344',
      items: [{ id: 'item_1', name: 'Shoes', price: 3200, quantity: 1 }],
      totalAmount: 3200,
    });
    OrderStore.update(order.id, { status: 'AWAITING_VERIFICATION' });

    const rawPayload = JSON.stringify({
      id: 'evt_rej_202',
      type: 'payment.rejected',
      created: Math.floor(Date.now() / 1000),
      data: {
        id: 'pay_rej_1',
        external_order_id: 'ORD-RETRY-01',
        amount: 3200,
        status: 'REJECTED',
        retry_url: 'https://checkout.example/c/pay_rej_1?retry=true',
      },
    });

    const signature = await generateSignatureHeader(rawPayload, webhookSecret);

    const res = await mockApp.request('/api/webhooks/smpg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'smpg-signature': signature,
      },
      body: rawPayload,
    });

    expect(res.status).toBe(200);
    const updatedOrder = OrderStore.get('ORD-RETRY-01');
    expect(updatedOrder?.status).toBe('PAYMENT_REJECTED');
    expect(updatedOrder?.retryUrl).toBe('https://checkout.example/c/pay_rej_1?retry=true');
  });

  test('Checklist 6: Order details endpoint provides server-side source of truth', async () => {
    OrderStore.create({
      id: 'ORD-FETCH-99',
      customerName: 'Nadia',
      customerPhone: '01311223344',
      items: [{ id: 'item_1', name: 'Tea Set', price: 1450, quantity: 1 }],
      totalAmount: 1450,
    });

    const res = await mockApp.request('/api/orders/ORD-FETCH-99');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.order.id).toBe('ORD-FETCH-99');
    expect(data.order.customerName).toBe('Nadia');
    expect(data.order.status).toBe('PENDING_PAYMENT');
  });
});
