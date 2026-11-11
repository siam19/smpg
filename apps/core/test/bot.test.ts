import { describe, expect, test } from 'bun:test';
import { app } from '../src/index';
import {
  appendFinalDecisionStatus,
  appendGracePeriodStatus,
  formatCodCard,
  formatSubmittedCard,
} from '../src/bot/views/cards';
import type { Payment, MerchantWallet } from '../src/db/schema';

describe('Telegram Bot & Views', () => {
  test('Webhook rejects requests with missing or invalid secret token', async () => {
    // 1. Missing header
    const resNoToken = await app.request('/v1/telegram-webhook', {
      method: 'POST',
      body: JSON.stringify({ update_id: 123 }),
    }, {
      TELEGRAM_WEBHOOK_SECRET: 'super_secret_token_123',
    } as any);

    expect(resNoToken.status).toBe(401);

    // 2. Wrong header
    const resWrongToken = await app.request('/v1/telegram-webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': 'wrong_token',
      },
      body: JSON.stringify({ update_id: 123 }),
    }, {
      TELEGRAM_WEBHOOK_SECRET: 'super_secret_token_123',
    } as any);

    expect(resWrongToken.status).toBe(401);
  });

  test('Card formatters produce accurate text for bKash, Nagad and COD', () => {
    const mockBkashPayment: Payment = {
      id: 'pay_123',
      merchantId: 'mrc_1',
      mode: 'live',
      externalOrderId: 'ORD-1042',
      method: 'bkash',
      walletId: 'wal_1',
      amount: 1250,
      status: 'SUBMITTED',
      trxId: '9K3L2M1ABC',
      senderNumber: '01712345678',
      customerName: 'Rahim',
      customerPhone: '01712345678',
      parentPaymentId: null,
      verificationMethod: 'telegram',
      successUrl: 'https://shop.example/thanks',
      cancelUrl: null,
      metadata: null,
      idempotencyKey: null,
      attempts: 1,
      pendingDecision: null,
      decisionActor: null,
      decisionEffectiveAt: null,
      lateSubmission: 0,
      expiresAt: 1731330000,
      createdAt: 1731300000,
      updatedAt: 1731300000,
    };

    const mockWallet: MerchantWallet = {
      id: 'wal_1',
      merchantId: 'mrc_1',
      provider: 'bkash',
      number: '01799887766',
      label: 'Main bKash',
      dailyLimit: 25000,
      priority: 100,
      active: 1,
      createdAt: 1731300000,
    };

    // 1. bKash Card
    const bkashCard = formatSubmittedCard(mockBkashPayment, mockWallet);
    expect(bkashCard).toContain('bKash payment · ORD-1042');
    expect(bkashCard).toContain('৳1,250');
    expect(bkashCard).toContain('01799887766 (Main bKash)');
    expect(bkashCard).toContain('TrxID:');
    expect(bkashCard).toContain('9K3L2M1ABC');

    // 2. Nagad Card with Late Submission
    const mockNagadPayment: Payment = {
      ...mockBkashPayment,
      method: 'nagad',
      lateSubmission: 1,
    };
    const nagadCard = formatSubmittedCard(mockNagadPayment, {
      ...mockWallet,
      provider: 'nagad',
      number: '01899887766',
      label: 'Nagad-1',
    });
    expect(nagadCard).toContain('Nagad payment · ORD-1042 ⏰ submitted late');
    expect(nagadCard).toContain('TxnID:');

    // 3. COD Card
    const codCard = formatCodCard({
      ...mockBkashPayment,
      method: 'cod',
    });
    expect(codCard).toContain('COD order · ORD-1042');
    expect(codCard).toContain('Rahim');

    // 4. Grace Period Status
    const graceCard = appendGracePeriodStatus(bkashCard, 'approve', '@seller', '14:32:00');
    expect(graceCard).toContain('Approving by @seller');
    expect(graceCard).toContain('14:32:00');

    // 5. Final Status Badge
    const finalCard = appendFinalDecisionStatus(bkashCard, 'approve', '@seller', '14:32');
    expect(finalCard).toContain('Approved by @seller · 14:32');
  });
});
