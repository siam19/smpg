import { describe, expect, test, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { app } from '../src/index';
import { createTestD1 } from './helpers/mock-d1';
import {
  botConfig,
  payments,
  stores,
  trxSubmissions,
  wallets,
  webhookDeliveries,
} from '../src/db/schema';
import type { Env } from '../src/types';

describe('Customer Checkout Endpoints (/c/:id/*)', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;

  const testStoreId = 'str_checkout_store';

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      TELEGRAM_BOT_TOKEN: '', // Empty in tests to prevent real HTTP calls to Telegram API
      TELEGRAM_WEBHOOK_SECRET: 'mock_secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      OWNER_TELEGRAM_ID: '88776655',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);

    await db.insert(botConfig).values({
      id: 'default',
      ownerTelegramChatId: 88776655,
      rotationStrategy: 'balanced',
      createdAt: now,
      updatedAt: now,
    });

    // Seed store
    await db.insert(stores).values({
      id: testStoreId,
      name: 'Aesthetic Fashion',
      codEnabled: 1,
      webhookUrl: 'https://store.example/api/webhook',
      webhookSecret: 'mock_secret_enc',
      paused: 0,
      createdAt: now,
    });

    // Seed shared wallets
    await db.insert(wallets).values([
      {
        id: 'wal_bkash_main',
        storeId: null,
        provider: 'bkash',
        number: '01711002233',
        label: 'Main bKash',
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      },
      {
        id: 'wal_nagad_main',
        storeId: null,
        provider: 'nagad',
        number: '01811002233',
        label: 'Main Nagad',
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      },
    ]);
  });

  describe('GET /c/:id/data', () => {
    test('returns public checkout session data with store id/name and available methods (no brand_color/logo_key)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_checkout_1',
        storeId: testStoreId,
        mode: 'live',
        amount: 1500,
        status: 'CREATED',
        method: null,
        walletId: null,
        successUrl: 'https://store.example/thanks',
        cancelUrl: 'https://store.example/cart',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request('/c/pay_checkout_1/data', { method: 'GET' }, env as any);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.id).toBe('pay_checkout_1');
      expect(data.amount).toBe(1500);
      expect(data.currency).toBe('BDT');
      expect(data.status).toBe('CREATED');
      expect(data.store).toEqual({ id: testStoreId, name: 'Aesthetic Fashion' });
      expect(data.store.brand_color).toBeUndefined();
      expect(data.store.logo_key).toBeUndefined();
      expect(data.available_methods).toContain('cod');
      expect(data.available_methods).toContain('bkash');
      expect(data.available_methods).toContain('nagad');
      expect(data.assigned_wallet).toBeNull();
      expect(data.attempts_remaining).toBe(3);
      expect(data.is_expired).toBe(false);
      expect(data.can_late_submit).toBe(false);
    });

    test('returns 404 for non-existent payment', async () => {
      const res = await app.request('/c/pay_does_not_exist/data', { method: 'GET' }, env as any);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_request');
    });

    test('returns 403 if store is paused', async () => {
      await db.update(stores).set({ paused: 1 });
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_paused_str',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request('/c/pay_paused_str/data', { method: 'GET' }, env as any);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe('store_paused');
    });

    test('flags can_late_submit if payment expired within 24h grace window', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_expired_recent',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'EXPIRED',
        expiresAt: now - 7200,
        createdAt: now - 10800,
        updatedAt: now - 7200,
      });

      const res = await app.request('/c/pay_expired_recent/data', { method: 'GET' }, env as any);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.is_expired).toBe(true);
      expect(data.can_late_submit).toBe(true);
    });
  });

  describe('POST /c/:id/method', () => {
    test('allocates bKash wallet when customer selects bkash', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_choose_bkash',
        storeId: testStoreId,
        mode: 'live',
        amount: 1200,
        status: 'CREATED',
        method: null,
        walletId: null,
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_choose_bkash/method',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'bkash' }),
        },
        env as any
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe('pay_choose_bkash');
      expect(data.method).toBe('bkash');
      expect(data.assigned_wallet.provider).toBe('bkash');
      expect(data.assigned_wallet.number).toBe('01711002233');

      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, 'pay_choose_bkash'))
        .get();
      expect(updated.method).toBe('bkash');
      expect(updated.walletId).toBe('wal_bkash_main');
    });

    test('transitions to CONFIRMED and queues payment.confirmed webhook when customer selects COD', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_choose_cod',
        storeId: testStoreId,
        mode: 'live',
        externalOrderId: 'ORD-COD-CHK',
        amount: 1500,
        status: 'CREATED',
        method: null,
        walletId: null,
        customerName: 'Siam',
        customerPhone: '01711998877',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_choose_cod/method',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'cod' }),
        },
        env as any
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('CONFIRMED');
      expect(data.method).toBe('cod');
      expect(data.redirect_url).toContain('status=confirmed');

      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, 'pay_choose_cod'))
        .get();
      expect(updated.status).toBe('CONFIRMED');

      // Verify payment.confirmed webhook was queued with snake_case payload
      const deliveries = await db.select().from(webhookDeliveries);
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].eventType).toBe('payment.confirmed');
      expect(deliveries[0].storeId).toBe(testStoreId);
      const payload = JSON.parse(deliveries[0].payload);
      expect(payload.data.external_order_id).toBe('ORD-COD-CHK');
      expect(payload.data.status).toBe('CONFIRMED');
    });

    test('rejects method change when payment is not in CREATED state', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_already_submitted',
        storeId: testStoreId,
        mode: 'live',
        amount: 1500,
        status: 'SUBMITTED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_already_submitted/method',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'nagad' }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_state');
    });
  });

  describe('POST /c/:id/submit', () => {
    test('submits valid TrxID and transitions payment to SUBMITTED', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_to_submit_1',
        storeId: testStoreId,
        mode: 'live',
        amount: 1800,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_to_submit_1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_number: '01712345678',
            trx_id: 'bk123abc456',
          }),
        },
        env as any
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('SUBMITTED');
      expect(data.payment_id).toBe('pay_to_submit_1');
      expect(data.redirect_url).toContain('payment_id=pay_to_submit_1');
      expect(data.redirect_url).toContain('status=submitted');
      expect(data.attempts_remaining).toBe(2);

      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, 'pay_to_submit_1'))
        .get();
      expect(updated.status).toBe('SUBMITTED');
      expect(updated.trxId).toBe('BK123ABC456');
      expect(updated.senderNumber).toBe('01712345678');
      expect(updated.attempts).toBe(1);

      const burned = await db
        .select()
        .from(trxSubmissions)
        .where(eq(trxSubmissions.trxId, 'BK123ABC456'))
        .get();
      expect(burned).toBeDefined();
      expect(burned.method).toBe('bkash');
    });

    test('submits TrxID without sender_number and without success_url (redirect_url is null)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_trx_only_submit',
        storeId: testStoreId,
        mode: 'live',
        amount: 850,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        successUrl: null,
        cancelUrl: null,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_trx_only_submit/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trx_id: 'ONLYTRX789',
          }),
        },
        env as any
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('SUBMITTED');
      expect(data.payment_id).toBe('pay_trx_only_submit');
      expect(data.redirect_url).toBeNull();

      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, 'pay_trx_only_submit'))
        .get();
      expect(updated.status).toBe('SUBMITTED');
      expect(updated.trxId).toBe('ONLYTRX789');
      expect(updated.senderNumber).toBeNull();
    });

    test('rejects honeypot bot submissions', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_bot_target',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_bot_target/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_number: '01712345678',
            trx_id: 'BK999XYZ',
            honeypot: 'i-am-a-bot',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_request');
    });

    test('rejects reused TrxID in live mode (TrxID burning)', async () => {
      const now = Math.floor(Date.now() / 1000);

      await db.insert(payments).values({
        id: 'pay_previous_session',
        storeId: testStoreId,
        mode: 'live',
        amount: 500,
        status: 'PAID',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        createdAt: now - 2000,
        updatedAt: now - 1000,
      });

      await db.insert(trxSubmissions).values({
        paymentId: 'pay_previous_session',
        method: 'bkash',
        trxId: 'ALREADYUSED123',
        senderNumber: '01711111111',
        outcome: 'approved',
        mode: 'live',
        createdAt: now - 1000,
      });

      await db.insert(payments).values({
        id: 'pay_dup_trx_test',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_dup_trx_test/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_number: '01712345678',
            trx_id: 'alreadyused123',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('trx_id_already_used');
    });

    test('validates invalid Bangladeshi mobile sender numbers', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_invalid_phone_test',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_invalid_phone_test/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_number: '01234567890',
            trx_id: 'VALIDTRX99',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_request');
      expect(data.error.param).toBe('sender_number');
    });

    test('accepts late submission past 60 min and flags late_submission', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_late_submit_target',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'EXPIRED',
        method: 'nagad',
        walletId: 'wal_nagad_main',
        expiresAt: now - 1800,
        createdAt: now - 5400,
        updatedAt: now - 1800,
      });

      const res = await app.request(
        '/c/pay_late_submit_target/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_number: '01812345678',
            trx_id: 'NG987654321',
          }),
        },
        env as any
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('SUBMITTED');

      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, 'pay_late_submit_target'))
        .get();
      expect(updated.status).toBe('SUBMITTED');
      expect(updated.lateSubmission).toBe(1);
    });

    test('rejects submission when maximum 3 attempts exceeded', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_max_attempts',
        storeId: testStoreId,
        mode: 'live',
        amount: 1000,
        status: 'REJECTED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        attempts: 3,
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request(
        '/c/pay_max_attempts/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_number: '01712345678',
            trx_id: 'NEWTRX444',
          }),
        },
        env as any
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('too_many_attempts');
    });
  });

  describe('GET /c/:id/status', () => {
    test('returns status with 5-second public cache header', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_status_fast',
        storeId: testStoreId,
        mode: 'live',
        amount: 2500,
        status: 'SUBMITTED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request('/c/pay_status_fast/status', { method: 'GET' }, env as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=5');

      const data = await res.json();
      expect(data.id).toBe('pay_status_fast');
      expect(data.status).toBe('SUBMITTED');
    });

    test('returns 404 for non-existent payment in status check', async () => {
      const res = await app.request('/c/pay_no_id_status/status', { method: 'GET' }, env as any);
      expect(res.status).toBe(404);
    });
  });
});
