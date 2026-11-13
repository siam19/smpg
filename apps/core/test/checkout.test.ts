import { describe, expect, test, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { app } from '../src/index';
import { createTestD1 } from './helpers/mock-d1';
import { merchants, merchantWallets, payments, trxSubmissions } from '../src/db/schema';
import type { Env } from '../src/types';

describe('Sprint 3: Customer Checkout Endpoints', () => {
  let d1: D1Database;
  let db: any;
  let env: Env;

  const testMerchantId = 'mrc_checkout_store';
  const testChatId = 88776655;

  beforeEach(async () => {
    const testSetup = createTestD1();
    d1 = testSetup.d1;
    db = testSetup.db;

    env = {
      DB: d1,
      BUCKET: {} as any,
      TELEGRAM_BOT_TOKEN: '', // Empty in tests to prevent real HTTP calls to Telegram API
      TELEGRAM_WEBHOOK_SECRET: 'mock_secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      PUBLIC_BASE_URL: 'https://smpg-core.workers.dev',
      UNDO_WINDOW_SECONDS: '90',
      SUBMITTED_TTL_HOURS: '72',
      CREATED_TTL_MINUTES: '60',
      LATE_SUBMIT_HOURS: '24',
    };

    const now = Math.floor(Date.now() / 1000);

    // Seed merchant
    await db.insert(merchants).values({
      id: testMerchantId,
      telegramChatId: testChatId,
      storeName: 'Aesthetic Fashion',
      brandColor: '#E11D48',
      codEnabled: 1,
      rotationStrategy: 'balanced',
      webhookUrl: 'https://store.example/api/webhook',
      webhookSecret: 'mock_secret_enc',
      testMode: 1,
      paused: 0,
      createdAt: now,
    });

    // Seed wallets
    await db.insert(merchantWallets).values([
      {
        id: 'wal_bkash_main',
        merchantId: testMerchantId,
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
        merchantId: testMerchantId,
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
    test('returns public checkout session data with store branding and available methods', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_checkout_1',
        merchantId: testMerchantId,
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
      expect(data.store.name).toBe('Aesthetic Fashion');
      expect(data.store.brand_color).toBe('#E11D48');
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

    test('returns 403 if merchant account is paused', async () => {
      await db.update(merchants).set({ paused: 1 });
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_paused_mrc',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        successUrl: 'https://store.example/thanks',
        expiresAt: now + 3600,
        createdAt: now,
        updatedAt: now,
      });

      const res = await app.request('/c/pay_paused_mrc/data', { method: 'GET' }, env as any);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe('merchant_paused');
    });

    test('flags can_late_submit if payment expired within 24h grace window', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Expired 2 hours ago
      await db.insert(payments).values({
        id: 'pay_expired_recent',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'EXPIRED',
        successUrl: 'https://store.example/thanks',
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
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1200,
        status: 'CREATED',
        method: null,
        walletId: null,
        successUrl: 'https://store.example/thanks',
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

      // Check DB
      const updated = await db.select().from(payments).where(eq(payments.id, 'pay_choose_bkash')).get();
      expect(updated.method).toBe('bkash');
      expect(updated.walletId).toBe('wal_bkash_main');
    });

    test('transitions to CONFIRMED when customer selects COD', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_choose_cod',
        merchantId: testMerchantId,
        mode: 'live',
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

      const updated = await db.select().from(payments).where(eq(payments.id, 'pay_choose_cod')).get();
      expect(updated.status).toBe('CONFIRMED');
    });

    test('rejects method change when payment is not in CREATED state', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_already_submitted',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1500,
        status: 'SUBMITTED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
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
        merchantId: testMerchantId,
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

      // Verify DB updates
      const updated = await db.select().from(payments).where(eq(payments.id, 'pay_to_submit_1')).get();
      expect(updated.status).toBe('SUBMITTED');
      expect(updated.trxId).toBe('BK123ABC456'); // Normalized to uppercase
      expect(updated.senderNumber).toBe('01712345678');
      expect(updated.attempts).toBe(1);

      // Verify TrxID burned in trx_submissions
      const burned = await db
        .select()
        .from(trxSubmissions)
        .where(eq(trxSubmissions.trxId, 'BK123ABC456'))
        .get();
      expect(burned).toBeDefined();
      expect(burned.method).toBe('bkash');
    });

    test('submits TrxID without sender_number (TrxID-only submission)', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_trx_only_submit',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 850,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        expiresAt: now + 3600,
        successUrl: 'https://store.example/success',
        cancelUrl: 'https://store.example/cancel',
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
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
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

      // Pre-seed previous payment and pre-burn a TrxID in trx_submissions
      await db.insert(payments).values({
        id: 'pay_previous_session',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 500,
        status: 'PAID',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
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
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
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
            trx_id: 'alreadyused123', // Lowercase, tests normalization
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
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
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
            sender_number: '01234567890', // 012 is invalid BD prefix
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
      // Expired 30 minutes ago, but within 24h grace window
      await db.insert(payments).values({
        id: 'pay_late_submit_target',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'CREATED',
        method: 'nagad',
        walletId: 'wal_nagad_main',
        successUrl: 'https://store.example/thanks',
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

      const updated = await db.select().from(payments).where(eq(payments.id, 'pay_late_submit_target')).get();
      expect(updated.status).toBe('SUBMITTED');
      expect(updated.lateSubmission).toBe(1);
    });

    test('rejects submission when maximum 3 attempts exceeded', async () => {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(payments).values({
        id: 'pay_max_attempts',
        merchantId: testMerchantId,
        mode: 'live',
        amount: 1000,
        status: 'REJECTED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        attempts: 3,
        successUrl: 'https://store.example/thanks',
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
        merchantId: testMerchantId,
        mode: 'live',
        amount: 2500,
        status: 'SUBMITTED',
        method: 'bkash',
        walletId: 'wal_bkash_main',
        successUrl: 'https://store.example/thanks',
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
