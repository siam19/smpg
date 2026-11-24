import { describe, expect, test, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { constructEvent } from '../../../packages/sdk/src/webhooks';
import { createTestD1 } from './helpers/mock-d1';
import {
  botConfig,
  payments,
  stores,
  webhookDeliveries,
} from '../src/db/schema';
import {
  computeWebhookSignature,
  deliverSingleWebhook,
  deliverWebhookPayload,
  processPendingWebhookDeliveries,
  queueWebhookDelivery,
  RETRY_DELAYS_SECONDS,
} from '../src/services/webhook';
import { finalizeDueDecisions, reopenRejectedPayment } from '../src/services/decision';
import { encryptAesGcm } from '../src/services/crypto';
import type { Env } from '../src/types';

describe('Outbound Webhooks, Decision Finalization & Event Delivery', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;

  const testStoreId = 'str_webhook_store';
  const rawWebhookSecret = 'whsec_test_secret_1234567890abcdef';
  const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: 'mock_secret',
      ENCRYPTION_KEY: encryptionKey,
      OWNER_TELEGRAM_ID: '778899',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);
    const encryptedSecret = await encryptAesGcm(rawWebhookSecret, encryptionKey);

    await db.insert(botConfig).values({
      id: 'default',
      ownerTelegramChatId: 778899,
      rotationStrategy: 'balanced',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(stores).values({
      id: testStoreId,
      name: 'Webhook Store',
      codEnabled: 1,
      webhookUrl: 'https://store.example/api/webhooks',
      webhookSecret: encryptedSecret,
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
          store_id: testStoreId,
          amount: 2500,
          status: 'PAID',
        },
      });

      const signatureHex = await computeWebhookSignature(rawWebhookSecret, timestamp, rawPayload);
      const signatureHeader = `t=${timestamp},v1=${signatureHex}`;

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

    test('queueWebhookDelivery inserts a delivery record with storeId into D1', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_queue_test',
        storeId: testStoreId,
        mode: 'live',
        amount: 1200,
        status: 'PAID',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const delivery = await queueWebhookDelivery(db, 'pay_queue_test', testStoreId, 'payment.paid', {
        id: 'pay_queue_test',
        store_id: testStoreId,
        amount: 1200,
        status: 'PAID',
      });

      expect(delivery.id).toStartWith('dlv_');
      expect(delivery.paymentId).toBe('pay_queue_test');
      expect(delivery.storeId).toBe(testStoreId);
      expect(delivery.eventType).toBe('payment.paid');
      expect(delivery.attempt).toBe(0);
      expect(delivery.deliveredAt).toBeNull();

      const inDb = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, delivery.id))
        .get();
      expect(inDb).toBeDefined();
      expect(inDb.eventType).toBe('payment.paid');
      expect(inDb.storeId).toBe(testStoreId);
    });

    test('deliverSingleWebhook marks successful delivery in D1', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_success_delivery',
        storeId: testStoreId,
        mode: 'live',
        amount: 950,
        status: 'PAID',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const delivery = await queueWebhookDelivery(
        db,
        'pay_success_delivery',
        testStoreId,
        'payment.paid',
        {
          id: 'pay_success_delivery',
          store_id: testStoreId,
          amount: 950,
          status: 'PAID',
        }
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('OK', { status: 200 });

      try {
        const ok = await deliverSingleWebhook(db, env, delivery);
        expect(ok).toBe(true);

        const updated = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, delivery.id))
          .get();
        expect(updated.deliveredAt).toBeGreaterThan(0);
        expect(updated.lastStatus).toBe(200);
        expect(updated.attempt).toBe(1);
        expect(updated.nextAttemptAt).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('deliverSingleWebhook handles failure with exponential backoff and emoji-free owner alert on attempt 3', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_retry_schedule',
        storeId: testStoreId,
        mode: 'live',
        amount: 500,
        status: 'PAID',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const delivery = await queueWebhookDelivery(
        db,
        'pay_retry_schedule',
        testStoreId,
        'payment.paid',
        {
          id: 'pay_retry_schedule',
          store_id: testStoreId,
          amount: 500,
        }
      );

      const sentAlerts: { chatId: number; text: string }[] = [];
      const mockBot = {
        api: {
          sendMessage: async (chatId: number, text: string) => {
            sentAlerts.push({ chatId, text });
            return { message_id: 1 };
          },
        },
      } as any;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('Server Error', { status: 500 });

      try {
        const ok = await deliverSingleWebhook(db, env, delivery, mockBot);
        expect(ok).toBe(false);

        const attempt1 = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, delivery.id))
          .get();
        expect(attempt1.attempt).toBe(1);
        expect(attempt1.lastStatus).toBe(500);
        expect(attempt1.deliveredAt).toBeNull();
        expect(attempt1.nextAttemptAt).toBeGreaterThanOrEqual(now + RETRY_DELAYS_SECONDS[0]);

        await deliverSingleWebhook(db, env, attempt1, mockBot);
        const attempt2 = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, delivery.id))
          .get();
        expect(attempt2.attempt).toBe(2);
        expect(sentAlerts.length).toBe(0);

        await deliverSingleWebhook(db, env, attempt2, mockBot);
        const attempt3 = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, delivery.id))
          .get();
        expect(attempt3.attempt).toBe(3);
        expect(sentAlerts.length).toBe(1);
        expect(sentAlerts[0].chatId).toBe(778899);
        expect(sentAlerts[0].text).toContain('Webhook Store');
        expect(sentAlerts[0].text).not.toContain('⚠️');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('processPendingWebhookDeliveries queries and processes due retries in batch', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_cron_batch',
        storeId: testStoreId,
        mode: 'live',
        amount: 700,
        status: 'PAID',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(webhookDeliveries).values([
        {
          id: 'dlv_batch_1',
          paymentId: 'pay_cron_batch',
          storeId: testStoreId,
          eventType: 'payment.paid',
          payload: JSON.stringify({ id: 'evt_1', type: 'payment.paid' }),
          attempt: 1,
          nextAttemptAt: now - 10,
          lastStatus: 500,
          deliveredAt: null,
        },
        {
          id: 'dlv_batch_2',
          paymentId: 'pay_cron_batch',
          storeId: testStoreId,
          eventType: 'payment.paid',
          payload: JSON.stringify({ id: 'evt_2', type: 'payment.paid' }),
          attempt: 2,
          nextAttemptAt: now - 5,
          lastStatus: 500,
          deliveredAt: null,
        },
        {
          id: 'dlv_batch_future',
          paymentId: 'pay_cron_batch',
          storeId: testStoreId,
          eventType: 'payment.paid',
          payload: JSON.stringify({ id: 'evt_3', type: 'payment.paid' }),
          attempt: 1,
          nextAttemptAt: now + 3600,
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

        const futureRow = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, 'dlv_batch_future'))
          .get();
        expect(futureRow.deliveredAt).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Decision Finalization & Reopen Webhooks', () => {
    test('finalizeDueDecisions emits normalized snake_case payload without retry_url and finalizes Telegram card', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_reject_finalize',
        storeId: testStoreId,
        mode: 'live',
        externalOrderId: 'ORD-REJ-1',
        amount: 1400,
        status: 'SUBMITTED',
        method: 'bkash',
        trxId: 'BADTRX123',
        telegramMessageId: 4242,
        pendingDecision: 'reject',
        decisionActor: 'telegram:@owner',
        decisionEffectiveAt: now - 10,
        expiresAt: now + 3600,
        createdAt: now - 120,
        updatedAt: now - 60,
      });

      const editedMessages: { chatId: number; messageId: number; replyMarkup: any }[] = [];
      const mockBot = {
        api: {
          editMessageText: async (chatId: number, messageId: number, _text: string, opts: any) => {
            editedMessages.push({ chatId, messageId, replyMarkup: opts?.reply_markup });
            return true;
          },
        },
      } as any;

      const count = await finalizeDueDecisions(db, mockBot, env);
      expect(count).toBe(1);

      // Verify Telegram card was finalized (inline_keyboard cleared)
      expect(editedMessages.length).toBe(1);
      expect(editedMessages[0].chatId).toBe(778899);
      expect(editedMessages[0].messageId).toBe(4242);
      expect(editedMessages[0].replyMarkup).toEqual({ inline_keyboard: [] });

      // Verify webhook payload is snake_case and has no retry_url
      const deliveries = await db.select().from(webhookDeliveries);
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].eventType).toBe('payment.rejected');
      const payload = JSON.parse(deliveries[0].payload);
      expect(payload.data.store_id).toBe(testStoreId);
      expect(payload.data.external_order_id).toBe('ORD-REJ-1');
      expect(payload.data.status).toBe('REJECTED');
      expect(payload.data.retry_url).toBeUndefined();
      expect(payload.data.storeId).toBeUndefined();

      // Reopen rejected payment and verify payment.reopened webhook
      const reopened = await reopenRejectedPayment(db, 'pay_reject_finalize', 'telegram:@owner');
      expect(reopened.success).toBe(true);
      expect(reopened.payment?.status).toBe('CREATED');

      const allDeliveries = await db.select().from(webhookDeliveries);
      expect(allDeliveries.length).toBe(2);
      expect(allDeliveries[1].eventType).toBe('payment.reopened');
    });
  });
});
