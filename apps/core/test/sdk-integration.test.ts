import { describe, expect, test, beforeEach } from 'bun:test';
import { SMPG, SMPGCheckout } from '../../../packages/sdk/src/index';
import { app } from '../src/index';
import { createTestD1 } from './helpers/mock-d1';
import { apiKeys, merchants, merchantWallets } from '../src/db/schema';
import { generateApiKey, sha256 } from '../src/services/crypto';
import type { Env } from '../src/types';

describe('SDK Integration with Core Payments API', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;
  let liveKey: string;
  const testMerchantId = 'mrc_sdk_test';

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      BUCKET: {} as any,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: 'mock_webhook_secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PUBLIC_BASE_URL: 'https://smpg-core.workers.dev',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);

    await db.insert(merchants).values({
      id: testMerchantId,
      telegramChatId: 998877,
      storeName: 'SDK Store',
      brandColor: '#2563EB',
      codEnabled: 1,
      rotationStrategy: 'balanced',
      webhookUrl: 'https://myshop.com/webhooks/smpg',
      webhookSecret: 'mock_secret_enc',
      testMode: 0,
      paused: 0,
      createdAt: now,
    });

    const keyData = generateApiKey('live');
    liveKey = keyData.key;
    const keyHash = await sha256(liveKey);

    await db.insert(apiKeys).values({
      id: 'key_sdk_1',
      merchantId: testMerchantId,
      keyHash,
      prefix: keyData.prefix,
      mode: 'live',
      revokedAt: null,
      createdAt: now,
    });

    await db.insert(merchantWallets).values([
      {
        id: 'wal_sdk_bkash',
        merchantId: testMerchantId,
        provider: 'bkash',
        number: '01700112233',
        label: 'SDK bKash',
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      },
    ]);
  });

  test('SDK creates, retrieves, lists, and cancels payments end-to-end', async () => {
    // Intercept fetch in SDK with app.request
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(url);
      const relativePath = parsedUrl.pathname + parsedUrl.search;
      return app.request(relativePath, init, env as any);
    };

    try {
      const smpg = new SMPG(liveKey, {
        baseUrl: 'https://smpg-core.workers.dev',
      });

      // 1. Create Payment
      const payment = await smpg.payments.create(
        {
          amount: 1250,
          method: 'bkash',
          external_order_id: 'ORD-SDK-001',
          customer: { name: 'Fahim', phone: '01711223344' },
          success_url: 'https://myshop.com/orders/ORD-SDK-001/thanks',
          cancel_url: 'https://myshop.com/cart',
          metadata: { plan: 'pro' },
        },
        { idempotencyKey: 'idem_sdk_001' }
      );

      expect(payment.id).toStartWith('pay_');
      expect(payment.amount).toBe(1250);
      expect(payment.status).toBe('CREATED');
      expect(payment.method).toBe('bkash');
      expect(payment.assigned_wallet?.number).toBe('01700112233');
      expect(payment.checkout_url).toBe(`https://smpg-core.workers.dev/c/${payment.id}`);
      expect(payment.metadata).toEqual({ plan: 'pro' });

      // 2. Retrieve Payment (verifying assigned_wallet)
      const retrieved = await smpg.payments.retrieve(payment.id);
      expect(retrieved.id).toBe(payment.id);
      expect(retrieved.external_order_id).toBe('ORD-SDK-001');
      expect(retrieved.assigned_wallet?.number).toBe('01700112233');

      // 3. List Payments
      const list = await smpg.payments.list({ external_order_id: 'ORD-SDK-001' });
      expect(list.data.length).toBe(1);
      expect(list.data[0].id).toBe(payment.id);

      // 4. Cancel Payment
      const cancelled = await smpg.payments.cancel(payment.id);
      expect(cancelled.status).toBe('CANCELLED');

      const afterCancel = await smpg.payments.retrieve(payment.id);
      expect(afterCancel.status).toBe('CANCELLED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('SDK supports embedded checkout flow: create without method -> selectMethod -> submit TrxID', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(url);
      const relativePath = parsedUrl.pathname + parsedUrl.search;
      return app.request(relativePath, init, env as any);
    };

    try {
      const smpg = new SMPG(liveKey, {
        baseUrl: 'https://smpg-core.workers.dev',
      });

      // 1. Create payment without method (customer is at /checkout box)
      const payment = await smpg.payments.create({
        amount: 2100,
        external_order_id: 'ORD-CUSTOM-CHECKOUT-1',
        success_url: 'https://myshop.com/orders/thanks',
      });

      expect(payment.method).toBeNull();
      expect(payment.assigned_wallet).toBeNull();
      expect(payment.available_methods).toContain('bkash');

      // 2. Customer selects bKash in merchant's custom checkout widget
      const withMethod = await smpg.payments.selectMethod(payment.id, 'bkash');
      expect(withMethod.method).toBe('bkash');
      expect(withMethod.assigned_wallet?.number).toBe('01700112233');

      // 3. Customer submits TrxID via merchant's server
      const submitted = await smpg.payments.submit(payment.id, {
        trx_id: 'SDKTRX998877',
      });

      expect(submitted.status).toBe('SUBMITTED');
      expect(submitted.trx_id).toBe('SDKTRX998877');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('SMPGCheckout client-safe helper queries session and submits without secret API key', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(url);
      const relativePath = parsedUrl.pathname + parsedUrl.search;
      return app.request(relativePath, init, env as any);
    };

    try {
      const smpg = new SMPG(liveKey, {
        baseUrl: 'https://smpg-core.workers.dev',
      });

      // Create payment
      const payment = await smpg.payments.create({
        amount: 950,
        method: 'bkash',
        external_order_id: 'ORD-CLIENT-CHECKOUT-1',
        success_url: 'https://myshop.com/orders/thanks',
      });

      // Frontend browser uses keyless SMPGCheckout
      const checkout = new SMPGCheckout('https://smpg-core.workers.dev');
      const session = await checkout.getSession(payment.id);
      expect(session.id).toBe(payment.id);
      expect(session.assigned_wallet?.number).toBe('01700112233');

      const submitResult = await checkout.submit(payment.id, {
        trx_id: 'CLIENTTRX456',
      });
      expect(submitResult.status).toBe('SUBMITTED');
      expect(submitResult.payment_id).toBe(payment.id);

      const status = await checkout.getStatus(payment.id);
      expect(status.status).toBe('SUBMITTED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
