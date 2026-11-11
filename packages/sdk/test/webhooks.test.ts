import { describe, expect, test } from 'bun:test';
import { constructEvent, WebhookVerificationError } from '../src/webhooks';

describe('Webhook Verification', () => {
  const secret = 'whsec_test_secret_1234567890';

  async function generateSignature(secret: string, timestamp: number, body: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
    const hex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `t=${timestamp},v1=${hex}`;
  }

  test('successfully verifies valid signature', async () => {
    const body = JSON.stringify({
      id: 'evt_123',
      type: 'payment.paid',
      created: 1731330000,
      data: { id: 'pay_123', status: 'PAID' },
    });
    const now = Math.floor(Date.now() / 1000);
    const sig = await generateSignature(secret, now, body);

    const event = await constructEvent(body, sig, secret);
    expect(event.id).toBe('evt_123');
    expect(event.type).toBe('payment.paid');
    expect(event.data.id).toBe('pay_123');
  });

  test('fails if signature is invalid', async () => {
    const body = JSON.stringify({ id: 'evt_123' });
    const now = Math.floor(Date.now() / 1000);
    const sig = `t=${now},v1=badhexsignature`;

    expect(constructEvent(body, sig, secret)).rejects.toThrow(WebhookVerificationError);
  });

  test('fails if timestamp is expired', async () => {
    const body = JSON.stringify({ id: 'evt_123' });
    const expiredTime = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const sig = await generateSignature(secret, expiredTime, body);

    expect(constructEvent(body, sig, secret, { toleranceSeconds: 300 })).rejects.toThrow(
      WebhookVerificationError
    );
  });
});
