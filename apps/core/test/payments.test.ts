import { describe, expect, test, beforeEach } from 'bun:test';
import { app } from '../src/index';
import { createTestD1 } from './helpers/mock-d1';
import { apiKeys, merchants, merchantWallets, payments, webhookDeliveries } from '../src/db/schema';
import { generateApiKey, sha256 } from '../src/services/crypto';
import type { Env } from '../src/types';

describe('Sprint 2: Core Payments REST API', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;

  const testMerchantId = 'mrc_test123';
  const testChatId = 12345678;
  let liveKey: string;
  let testKey: string;

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      BUCKET: {} as any,
      TELEGRAM_BOT_TOKEN: 'mock_token',
      TELEGRAM_WEBHOOK_SECRET: 'mock_webhook_secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PUBLIC_BASE_URL: 'https://smpg-core.workers.dev',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);

    // 1. Seed merchant
    await db.insert(merchants).values({
      id: testMerchantId,
      telegramChatId: testChatId,
      storeName: 'Test Store',
      brandColor: '#10B981',
      codEnabled: 1,
      rotationStrategy: 'balanced',
      webhookUrl: 'https://store.example/api/webhook',
      webhookSecret: 'mock_secret_enc',
      testMode: 1,
      paused: 0,
      createdAt: now,
    });

    // 2. Seed API Keys
    const liveKeyData = generateApiKey('live');
    liveKey = liveKeyData.key;
    const liveHash = await sha256(liveKey);

    await db.insert(apiKeys).values({
      id: 'key_live_1',
      merchantId: testMerchantId,
      keyHash: liveHash,
      prefix: liveKeyData.prefix,
      mode: 'live',
      revokedAt: null,
      createdAt: now,
    });

    const testKeyData = generateApiKey('test');
    testKey = testKeyData.key;
    const testHash = await sha256(testKey);

    await db.insert(apiKeys).values({
      id: 'key_test_1',
      merchantId: testMerchantId,
      keyHash: testHash,
      prefix: testKeyData.prefix,
      mode: 'test',
      revokedAt: null,
      createdAt: now,
    });

    // 3. Seed bKash and Nagad wallets
    await db.insert(merchantWallets).values([
      {
        id: 'wal_bkash_1',
        merchantId: testMerchantId,
        provider: 'bkash',
        number: '01711223344',
        label: 'Primary bKash',
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      },
      {
        id: 'wal_nagad_1',
        merchantId: testMerchantId,
        provider: 'nagad',
        number: '01811223344',
        label: 'Primary Nagad',
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      },
    ]);
  });

  describe('Authentication Middleware', () => {
    test('rejects request without Authorization header', async () => {
      const res = await app.request('/v1/payments', { method: 'GET' }, env as any);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('unauthorized');
    });

    test('rejects request with invalid key prefix', async () => {
      const res = await app.request(
        '/v1/payments',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer invalid_prefix_key' },
        },
        env as any
      );
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('unauthorized');
    });

    test('rejects revoked API key', async () => {
      const now = Math.floor(Date.now() / 1000);
      const revokedKeyData = generateApiKey('live');
      const revokedHash = await sha256(revokedKeyData.key);

      await db.insert(apiKeys).values({
        id: 'key_revoked_1',
        merchantId: testMerchantId,
        keyHash: revokedHash,
        prefix: revokedKeyData.prefix,
        mode: 'live',
        revokedAt: now,
        createdAt: now,
      });

      const res = await app.request(
        '/v1/payments',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${revokedKeyData.key}` },
        },
        env as any
      );
      expect(res.status).toBe(401);
    });

    test('rejects paused merchant with 403', async () => {
      await db.update(merchants).set({ paused: 1 });

      const res = await app.request(
        '/v1/payments',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe('merchant_paused');
    });

    test('allows valid API key', async () => {
      const res = await app.request(
        '/v1/payments',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('POST /v1/payments', () => {
    test('creates payment with bkash method and assigns wallet', async () => {
      const res = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 1500,
            method: 'bkash',
            external_order_id: 'ORD-101',
            customer: { name: 'Rahim', phone: '01712345678' },
            success_url: 'https://store.example/orders/101/thanks',
            cancel_url: 'https://store.example/cart',
            metadata: { cart_id: 'c_9' },
          }),
        },
        env as any
      );

      expect(res.status).toBe(201);
      const data = await res.json();

      expect(data.id).toStartWith('pay_');
      expect(data.merchant_id).toBe(testMerchantId);
      expect(data.mode).toBe('live');
      expect(data.status).toBe('CREATED');
      expect(data.amount).toBe(1500);
      expect(data.method).toBe('bkash');
      expect(data.wallet_id).toBe('wal_bkash_1');
      expect(data.checkout_url).toBe(`https://smpg-core.workers.dev/c/${data.id}`);
      expect(data.metadata).toEqual({ cart_id: 'c_9' });
      expect(data.expires_at).toBeDefined();
    });

    test('creates payment with omitted method (chosen on hosted checkout)', async () => {
      const res = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${testKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 800,
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.mode).toBe('test');
      expect(data.method).toBeNull();
      expect(data.wallet_id).toBeNull();
      expect(data.status).toBe('CREATED');
    });

    test('fails if amount exceeds available wallet capacity', async () => {
      const res = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 30000, // Wallet limit is 25000
            method: 'bkash',
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('no_wallet_available');
    });

    test('fails if COD is requested when disabled for merchant', async () => {
      await db.update(merchants).set({ codEnabled: 0 });

      const res = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 1000,
            method: 'cod',
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('method_not_enabled');
    });

    test('validates invalid amount format', async () => {
      const res = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: -50,
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_request');
      expect(data.error.param).toBe('amount');
    });

    test('respects Idempotency-Key header on repeated calls', async () => {
      const idempotencyKey = 'order_idem_999';

      const res1 = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            amount: 1200,
            method: 'nagad',
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      expect(res1.status).toBe(201);
      const data1 = await res1.json();

      // Repeat identical request
      const res2 = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            amount: 1200,
            method: 'nagad',
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.id).toBe(data1.id);
      expect(data2.amount).toBe(data1.amount);
    });
  });

  describe('GET /v1/payments/:id', () => {
    test('retrieves created payment successfully', async () => {
      const createRes = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 2000,
            method: 'bkash',
            external_order_id: 'ORD-202',
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      const created = await createRes.json();

      const getRes = await app.request(
        `/v1/payments/${created.id}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(getRes.status).toBe(200);
      const fetched = await getRes.json();
      expect(fetched.id).toBe(created.id);
      expect(fetched.external_order_id).toBe('ORD-202');
      expect(fetched.amount).toBe(2000);
    });

    test('returns 404 for non-existent payment', async () => {
      const res = await app.request(
        '/v1/payments/pay_nonexistent',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_request');
    });

    test('performs lazy finalization if pending decision window has passed', async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 100;

      // Seed payment with pendingDecision whose window expired
      await db.insert(payments).values({
        id: 'pay_pending_undo',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 500,
        status: 'SUBMITTED',
        method: 'bkash',
        walletId: 'wal_bkash_1',
        successUrl: 'https://store.example/thanks',
        pendingDecision: 'approve',
        decisionActor: 'telegram:@owner',
        decisionEffectiveAt: pastTime,
        expiresAt: pastTime + 3600,
        createdAt: pastTime - 50,
        updatedAt: pastTime,
      });

      const res = await app.request(
        '/v1/payments/pay_pending_undo',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('PAID');
      expect(data.pending_decision).toBeNull();
    });
  });

  describe('GET /v1/payments', () => {
    test('lists payments with pagination and filter', async () => {
      // Create 3 payments
      for (let i = 1; i <= 3; i++) {
        await app.request(
          '/v1/payments',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${liveKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              amount: 100 * i,
              method: 'bkash',
              external_order_id: `ORD-FILTER-${i}`,
              success_url: 'https://store.example/thanks',
            }),
          },
          env as any
        );
      }

      // 1. List with limit = 2
      const resLimit = await app.request(
        '/v1/payments?limit=2',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(resLimit.status).toBe(200);
      const dataLimit = await resLimit.json();
      expect(dataLimit.data.length).toBe(2);
      expect(dataLimit.has_more).toBe(true);

      // 2. Filter by external_order_id
      const resFilter = await app.request(
        '/v1/payments?external_order_id=ORD-FILTER-2',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(resFilter.status).toBe(200);
      const dataFilter = await resFilter.json();
      expect(dataFilter.data.length).toBe(1);
      expect(dataFilter.data[0].external_order_id).toBe('ORD-FILTER-2');
    });
  });

  describe('POST /v1/payments/:id/cancel', () => {
    test('cancels CREATED payment and queues webhook', async () => {
      const createRes = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 750,
            method: 'bkash',
            success_url: 'https://store.example/thanks',
          }),
        },
        env as any
      );

      const created = await createRes.json();

      const cancelRes = await app.request(
        `/v1/payments/${created.id}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(cancelRes.status).toBe(200);
      const cancelled = await cancelRes.json();
      expect(cancelled.status).toBe('CANCELLED');

      // Verify webhook queue entry
      const deliveryRows = await db.select().from(webhookDeliveries);
      expect(deliveryRows.length).toBeGreaterThan(0);
      expect(deliveryRows[0].eventType).toBe('payment.cancelled');
    });

    test('rejects cancellation if payment is in PAID status', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_already_paid',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'PAID',
        method: 'bkash',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/v1/payments/pay_already_paid/cancel',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${liveKey}` },
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_state');
    });
  });
});
