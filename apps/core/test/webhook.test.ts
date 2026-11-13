import { describe, expect, test, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { constructEvent } from '../../../packages/sdk/src/webhooks';
import { createTestD1 } from './helpers/mock-d1';
import {
  merchants,
  payments,
  webhookDeliveries,
  type WebhookDelivery,
} from '../src/db/schema';
import {
  computeWebhookSignature,
  deliverSingleWebhook,
  deliverWebhookPayload,
  processPendingWebhookDeliveries,
  queueWebhookDelivery,
  RETRY_DELAYS_SECONDS,
} from '../src/services/webhook';
import { encryptAesGcm } from '../src/services/crypto';
import type { Env } from '../src/types';

describe('Sprint 4: Outbound Webhooks & Event Delivery', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;

  const testMerchantId = 'mrc_webhook_store';
  const rawWebhookSecret = 'whsec_test_secret_1234567890abcdef';
  const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      BUCKET: {} as any,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: 'mock_secret',
      ENCRYPTION_KEY: encryptionKey,
      PUBLIC_BASE_URL: 'https://smpg-core.workers.dev',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);
    const encryptedSecret = await encryptAesGcm(rawWebhookSecret, encryptionKey);

    await db.insert(merchants).values({
      id: testMerchantId,
      telegramChatId: 778899,
      storeName: 'Webhook Store',
      brandColor: '#4F46E5',
      codEnabled: 1,
      rotationStrategy: 'balanced',
      webhookUrl: 'https://merchant.example/api/webhooks',
      webhookSecret: encryptedSecret,
      testMode: 1,
      paused: 0,
      createdAt: now,
    });
  });

  describe('Signature Generation & Verification Compatibility', () => {
    test('computes HMAC-SHA256 signature that passes SDK constructEvent verification', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawPayload = JSON.stringify({
        id: 'evt_test_1',
        type: 'payment.paid',
        created: timestamp,
        data: {
          id: 'pay_123',
          amount: 2500,
          status: 'PAID',
        },
      });

      const signatureHex = await computeWebhookSignature(rawWebhookSecret, timestamp, rawPayload);
      const signatureHeader = `t=${timestamp},v1=${signatureHex}`;

      // Verify using @smpg/sdk constructEvent
      const event = await constructEvent(rawPayload, signatureHeader, rawWebhookSecret);
      expect(event.id).toBe('evt_test_1');
      expect(event.type).toBe('payment.paid');
      expect(event.data.amount).toBe(2500);
      expect(event.data.status).toBe('PAID');
    });

    test('SDK rejects signature if payload has been tampered with', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const originalPayload = JSON.stringify({ id: 'evt_1', amount: 500 });
      const tamperedPayload = JSON.stringify({ id: 'evt_1', amount: 5000 });

      const signatureHex = await computeWebhookSignature(rawWebhookSecret, timestamp, originalPayload);
      const signatureHeader = `t=${timestamp},v1=${signatureHex}`;

      await expect(
        constructEvent(tamperedPayload, signatureHeader, rawWebhookSecret)
      ).rejects.toThrow();
    });
  });

  describe('Webhook Delivery & Retries', () => {
    test('deliverWebhookPayload sends expected headers and body', async () => {
      const originalFetch = globalThis.fetch;
      let capturedRequest: { url: string; headers: Headers; body: string } | null = null;

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequest = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        };
        return new Response('OK', { status: 200 });
      };

      try {
        const payload = JSON.stringify({ id: 'evt_delivery_test', type: 'payment.submitted' });
        const res = await deliverWebhookPayload(
          'https://store.example/webhook',
          rawWebhookSecret,
          'payment.submitted',
          payload
        );

        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(capturedRequest).toBeDefined();
        expect(capturedRequest!.url).toBe('https://store.example/webhook');
        expect(capturedRequest!.headers.get('x-smpg-event')).toBe('payment.submitted');
        expect(capturedRequest!.headers.get('x-smpg-signature')).toStartWith('t=');
        expect(capturedRequest!.headers.get('User-Agent')).toBe('SMPG-Webhook/1.0');
        expect(capturedRequest!.body).toBe(payload);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('queueWebhookDelivery inserts a delivery record into D1', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_queue_test',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1200,
        status: 'PAID',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const delivery = await queueWebhookDelivery(db, 'pay_queue_test', 'payment.paid', {
        id: 'pay_queue_test',
        amount: 1200,
        status: 'PAID',
      });

      expect(delivery.id).toStartWith('dlv_');
      expect(delivery.paymentId).toBe('pay_queue_test');
      expect(delivery.eventType).toBe('payment.paid');
      expect(delivery.attempt).toBe(0);
      expect(delivery.deliveredAt).toBeNull();

      const inDb = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)).get();
      expect(inDb).toBeDefined();
      expect(inDb.eventType).toBe('payment.paid');
    });

    test('deliverSingleWebhook marks successful delivery in D1', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_success_delivery',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 950,
        status: 'PAID',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const delivery = await queueWebhookDelivery(db, 'pay_success_delivery', 'payment.paid', {
        id: 'pay_success_delivery',
        amount: 950,
        status: 'PAID',
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('OK', { status: 200 });

      try {
        const ok = await deliverSingleWebhook(db, env, delivery);
        expect(ok).toBe(true);

        const updated = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)).get();
        expect(updated.deliveredAt).toBeGreaterThan(0);
        expect(updated.lastStatus).toBe(200);
        expect(updated.attempt).toBe(1);
        expect(updated.nextAttemptAt).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('deliverSingleWebhook handles failure with exponential backoff retry scheduling', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_retry_schedule',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 500,
        status: 'PAID',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const delivery = await queueWebhookDelivery(db, 'pay_retry_schedule', 'payment.paid', {
        id: 'pay_retry_schedule',
        amount: 500,
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('Server Error', { status: 500 });

      try {
        // Attempt 1 fail -> delay = RETRY_DELAYS_SECONDS[0] (60s)
        const ok = await deliverSingleWebhook(db, env, delivery);
        expect(ok).toBe(false);

        const attempt1 = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)).get();
        expect(attempt1.attempt).toBe(1);
        expect(attempt1.lastStatus).toBe(500);
        expect(attempt1.deliveredAt).toBeNull();
        expect(attempt1.nextAttemptAt).toBe(now + RETRY_DELAYS_SECONDS[0]);

        // Attempt 2 fail -> delay = RETRY_DELAYS_SECONDS[1] (300s)
        await deliverSingleWebhook(db, env, attempt1);
        const attempt2 = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)).get();
        expect(attempt2.attempt).toBe(2);
        expect(attempt2.nextAttemptAt).toBe(now + RETRY_DELAYS_SECONDS[1]);

        // Attempt 3 fail -> delay = RETRY_DELAYS_SECONDS[2] (1800s)
        await deliverSingleWebhook(db, env, attempt2);
        const attempt3 = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)).get();
        expect(attempt3.attempt).toBe(3);
        expect(attempt3.nextAttemptAt).toBe(now + RETRY_DELAYS_SECONDS[2]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('processPendingWebhookDeliveries queries and processes due retries in batch', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_cron_batch',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 700,
        status: 'PAID',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      // Insert 2 due deliveries
      await db.insert(webhookDeliveries).values([
        {
          id: 'dlv_batch_1',
          paymentId: 'pay_cron_batch',
          eventType: 'payment.paid',
          payload: JSON.stringify({ id: 'evt_1', type: 'payment.paid' }),
          attempt: 1,
          nextAttemptAt: now - 10, // Due
          lastStatus: 500,
          deliveredAt: null,
        },
        {
          id: 'dlv_batch_2',
          paymentId: 'pay_cron_batch',
          eventType: 'payment.paid',
          payload: JSON.stringify({ id: 'evt_2', type: 'payment.paid' }),
          attempt: 2,
          nextAttemptAt: now - 5, // Due
          lastStatus: 500,
          deliveredAt: null,
        },
        {
          id: 'dlv_batch_future',
          paymentId: 'pay_cron_batch',
          eventType: 'payment.paid',
          payload: JSON.stringify({ id: 'evt_3', type: 'payment.paid' }),
          attempt: 1,
          nextAttemptAt: now + 3600, // Not due yet
          lastStatus: 500,
          deliveredAt: null,
        },
      ]);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('OK', { status: 200 });

      try {
        const stats = await processPendingWebhookDeliveries(db, env);
        expect(stats.processed).toBe(2);
        expect(stats.succeeded).toBe(2);
        expect(stats.failed).toBe(0);

        // Verify that the future delivery was untouched
        const futureRow = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, 'dlv_batch_future')).get();
        expect(futureRow.deliveredAt).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
