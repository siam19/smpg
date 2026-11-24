import { describe, expect, test, beforeEach } from 'bun:test';
import { app } from '../src/index';
import { createTestD1 } from './helpers/mock-d1';
import {
  apiKeys,
  botConfig,
  payments,
  stores,
  wallets,
  webhookDeliveries,
} from '../src/db/schema';
import { generateApiKey, sha256 } from '../src/services/crypto';
import type { Env } from '../src/types';

describe('Core Payments REST API (Single-Owner Multi-Store)', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;

  const testStoreId = 'str_test123';
  const secondStoreId = 'str_other456';
  let liveKey: string;
  let testKey: string;
  let secondStoreKey: string;

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: 'mock_webhook_secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      OWNER_TELEGRAM_ID: '12345678',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);

    await db.insert(botConfig).values({
      id: 'default',
      ownerTelegramChatId: 12345678,
      rotationStrategy: 'balanced',
      createdAt: now,
      updatedAt: now,
    });

    // 1. Seed stores
    await db.insert(stores).values([
      {
        id: testStoreId,
        name: 'Test Store',
        codEnabled: 1,
        webhookUrl: 'https://store.example/api/webhook',
        webhookSecret: 'mock_secret_enc',
        paused: 0,
        createdAt: now,
      },
      {
        id: secondStoreId,
        name: 'Other Store',
        codEnabled: 1,
        webhookUrl: 'https://other.example/api/webhook',
        webhookSecret: 'mock_secret_enc_2',
        paused: 0,
        createdAt: now,
      },
    ]);

    // 2. Seed API Keys
    const liveKeyData = generateApiKey('live');
    liveKey = liveKeyData.key;
    await db.insert(apiKeys).values({
      id: 'key_live_1',
      storeId: testStoreId,
      keyHash: await sha256(liveKey),
      prefix: liveKeyData.prefix,
      mode: 'live',
      revokedAt: null,
      createdAt: now,
    });

    const testKeyData = generateApiKey('test');
    testKey = testKeyData.key;
    await db.insert(apiKeys).values({
      id: 'key_test_1',
      storeId: testStoreId,
      keyHash: await sha256(testKey),
      prefix: testKeyData.prefix,
      mode: 'test',
      revokedAt: null,
      createdAt: now,
    });

    const secondKeyData = generateApiKey('live');
    secondStoreKey = secondKeyData.key;
    await db.insert(apiKeys).values({
      id: 'key_live_2',
      storeId: secondStoreId,
      keyHash: await sha256(secondStoreKey),
      prefix: secondKeyData.prefix,
      mode: 'live',
      revokedAt: null,
      createdAt: now,
    });

    // 3. Seed shared bKash and Nagad wallets
    await db.insert(wallets).values([
      {
        id: 'wal_bkash_1',
        storeId: null,
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
        storeId: null,
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
        storeId: testStoreId,
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

    test('rejects paused store with 403 store_paused', async () => {
      await db.update(stores).set({ paused: 1 });

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
      expect(data.error.code).toBe('store_paused');
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
    test('creates payment with bkash method and assigns wallet (no checkout_url, uses store_id)', async () => {
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
      expect(data.store_id).toBe(testStoreId);
      expect(data.merchant_id).toBeUndefined();
      expect(data.checkout_url).toBeUndefined();
      expect(data.mode).toBe('live');
      expect(data.status).toBe('CREATED');
      expect(data.amount).toBe(1500);
      expect(data.method).toBe('bkash');
      expect(data.wallet_id).toBe('wal_bkash_1');
      expect(data.attempts).toBe(0);
      expect(data.attempts_remaining).toBe(3);
      expect(data.metadata).toEqual({ cart_id: 'c_9' });
      expect(data.expires_at).toBeDefined();
    });

    test('creates payment with omitted method and omitted success_url', async () => {
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
          }),
        },
        env as any
      );

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.mode).toBe('test');
      expect(data.method).toBeNull();
      expect(data.wallet_id).toBeNull();
      expect(data.success_url).toBeNull();
      expect(data.cancel_url).toBeNull();
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
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('no_wallet_available');
    });

    test('fails if COD is requested when disabled for store', async () => {
      await db.update(stores).set({ codEnabled: 0 });

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
          }),
        },
        env as any
      );

      expect(res1.status).toBe(201);
      const data1 = await res1.json();

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

  describe('Multi-Store Isolation & Retrieval', () => {
    test('store B cannot retrieve store A payments', async () => {
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
          }),
        },
        env as any
      );

      const created = await createRes.json();

      const otherRes = await app.request(
        `/v1/payments/${created.id}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${secondStoreKey}` },
        },
        env as any
      );

      expect(otherRes.status).toBe(404);
    });

    test('performs lazy finalization if pending decision window has passed and queues snake_case webhook', async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 100;

      await db.insert(payments).values({
        id: 'pay_pending_undo',
        storeId: testStoreId,
        mode: 'live',
        externalOrderId: 'ORD-LAZY-1',
        amount: 500,
        status: 'SUBMITTED',
        method: 'bkash',
        walletId: 'wal_bkash_1',
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

      // Verify webhook payload is normalized snake_case
      const deliveryRows = await db.select().from(webhookDeliveries);
      expect(deliveryRows.length).toBe(1);
      expect(deliveryRows[0].storeId).toBe(testStoreId);
      const payload = JSON.parse(deliveryRows[0].payload);
      expect(payload.type).toBe('payment.paid');
      expect(payload.data.store_id).toBe(testStoreId);
      expect(payload.data.external_order_id).toBe('ORD-LAZY-1');
      expect(payload.data.storeId).toBeUndefined();
    });
  });

  describe('GET /v1/payments', () => {
    test('lists payments with pagination and filter', async () => {
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
            }),
          },
          env as any
        );
      }

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

  describe('POST /v1/payments/:id/cancel & /method', () => {
    test('cancels CREATED payment and queues normalized snake_case webhook', async () => {
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
            external_order_id: 'ORD-CANCEL-1',
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

      const deliveryRows = await db.select().from(webhookDeliveries);
      expect(deliveryRows.length).toBe(1);
      expect(deliveryRows[0].eventType).toBe('payment.cancelled');
      expect(deliveryRows[0].storeId).toBe(testStoreId);
      const payload = JSON.parse(deliveryRows[0].payload);
      expect(payload.data.external_order_id).toBe('ORD-CANCEL-1');
      expect(payload.data.store_id).toBe(testStoreId);
    });

    test('selecting COD via REST API queues payment.confirmed webhook', async () => {
      const createRes = await app.request(
        '/v1/payments',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: 900,
            external_order_id: 'ORD-COD-API',
          }),
        },
        env as any
      );
      const created = await createRes.json();

      const methodRes = await app.request(
        `/v1/payments/${created.id}/method`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${liveKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ method: 'cod' }),
        },
        env as any
      );

      expect(methodRes.status).toBe(200);
      const updated = await methodRes.json();
      expect(updated.status).toBe('CONFIRMED');
      expect(updated.method).toBe('cod');

      const deliveryRows = await db.select().from(webhookDeliveries);
      expect(deliveryRows.length).toBe(1);
      expect(deliveryRows[0].eventType).toBe('payment.confirmed');
      const payload = JSON.parse(deliveryRows[0].payload);
      expect(payload.data.status).toBe('CONFIRMED');
      expect(payload.data.external_order_id).toBe('ORD-COD-API');
    });

    test('rejects cancellation if payment is in PAID status', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_already_paid',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'PAID',
        method: 'bkash',
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
