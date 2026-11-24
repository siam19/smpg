import { describe, expect, test } from 'bun:test';
import { SMPGCheckout } from '../src/checkout';
import { SMPG, SMPGError } from '../src/client';

describe('SMPGCheckout', () => {
  test('throws a clear error when baseUrl is missing or empty', () => {
    expect(() => new SMPGCheckout('')).toThrow(/requires a baseUrl/i);
    expect(() => new SMPGCheckout('   ')).toThrow(/requires a baseUrl/i);
    expect(() => new SMPGCheckout({ baseUrl: '' })).toThrow(/requires a baseUrl/i);
    expect(() => new SMPGCheckout({ baseUrl: '  ' })).toThrow(/requires a baseUrl/i);
    // @ts-expect-error runtime guard for JS callers omitting constructor arg
    expect(() => new SMPGCheckout()).toThrow(/requires a baseUrl/i);
  });

  test('accepts baseUrl as a string and strips trailing slashes', async () => {
    const calledUrls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      calledUrls.push(String(input));
      return new Response(
        JSON.stringify({
          id: 'pay_1',
          amount: 1200,
          currency: 'BDT',
          external_order_id: 'ORD-1',
          status: 'CREATED',
          store: { id: 'str_1', name: 'Demo Shop' },
          available_methods: ['bkash', 'nagad', 'cod'],
          method: null,
          assigned_wallet: null,
          trx_id: null,
          sender_number: null,
          attempts: 0,
          attempts_remaining: 3,
          expires_at: '2026-11-24T12:00:00.000Z',
          is_expired: false,
          can_late_submit: false,
          success_url: null,
          cancel_url: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const checkout = new SMPGCheckout('https://pay.mystore.workers.dev///');
    const session = await checkout.getSession('pay_1', { fetchFn: mockFetch });

    expect(calledUrls).toEqual(['https://pay.mystore.workers.dev/c/pay_1/data']);
    expect(session.store).toEqual({ id: 'str_1', name: 'Demo Shop' });
    expect(session.success_url).toBeNull();
  });

  test('accepts options object { baseUrl, fetchFn } and supports selectMethod, submit, getStatus', async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method || 'GET',
        body: init?.body ? String(init.body) : undefined,
      });

      if (url.endsWith('/method')) {
        return new Response(
          JSON.stringify({
            id: 'pay_2',
            method: 'bkash',
            status: 'CREATED',
            assigned_wallet: {
              id: 'wal_1',
              provider: 'bkash',
              number: '01700000000',
              label: 'Primary',
            },
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/submit')) {
        return new Response(
          JSON.stringify({
            status: 'SUBMITTED',
            message: 'Submitted for verification',
            payment_id: 'pay_2',
            redirect_url: null,
            attempts_remaining: 2,
          }),
          { status: 200 }
        );
      }

      if (url.endsWith('/status')) {
        return new Response(
          JSON.stringify({ id: 'pay_2', status: 'PAID', attempts: 1 }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
        status: 404,
      });
    }) as typeof fetch;

    const checkout = new SMPGCheckout({
      baseUrl: 'https://smpg.example.workers.dev/',
      fetchFn: mockFetch,
    });

    const selected = await checkout.selectMethod('pay_2', 'bkash');
    expect(selected.assigned_wallet?.number).toBe('01700000000');

    const submitted = await checkout.submit('pay_2', { trx_id: '9A8B7C6D5E' });
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.redirect_url).toBeNull();
    expect(submitted.attempts_remaining).toBe(2);

    const status = await checkout.getStatus('pay_2');
    expect(status.status).toBe('PAID');

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://smpg.example.workers.dev/c/pay_2/method',
      'POST https://smpg.example.workers.dev/c/pay_2/submit',
      'GET https://smpg.example.workers.dev/c/pay_2/status',
    ]);
  });

  test('strips accidental /v1 or /v1/payments suffix from baseUrl in SMPG and SMPGCheckout', async () => {
    const calledUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrls.push(String(input));
      return new Response(JSON.stringify({ id: 'pay_norm', status: 'CREATED', attempts: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const smpgFromV1 = new SMPG('smpg_test_key', {
        baseUrl: 'https://smpg.example.workers.dev/v1/',
      });
      await smpgFromV1.payments.create({ amount: 500 });

      const smpgFromPayments = new SMPG('smpg_test_key', {
        baseUrl: 'https://smpg.example.workers.dev/v1/payments',
      });
      await smpgFromPayments.payments.create({ amount: 500 });

      const checkoutFromV1 = new SMPGCheckout('https://smpg.example.workers.dev/v1');
      await checkoutFromV1.getStatus('pay_norm');

      expect(calledUrls).toEqual([
        'https://smpg.example.workers.dev/v1/payments',
        'https://smpg.example.workers.dev/v1/payments',
        'https://smpg.example.workers.dev/c/pay_norm/status',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws SMPGError on non-2xx checkout API response', async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'duplicate_trx', message: 'TrxID already used' } }),
        { status: 409 }
      )) as typeof fetch;

    const checkout = new SMPGCheckout({
      baseUrl: 'https://smpg.example.workers.dev',
      fetchFn: mockFetch,
    });

    await expect(checkout.submit('pay_3', { trx_id: 'DUP12345' })).rejects.toThrow(SMPGError);
  });
});
