import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { app } from '../src/index';
import { createBot } from '../src/bot';
import { createStoreWithCredentials } from '../src/bot/commands/stores';
import { renderStoreServerCredentials } from '../src/bot/callbacks/menu';
import { createTestD1 } from './helpers/mock-d1';
import { applyPaymentDecision } from '../src/services/decision';
import {
  appendFinalDecisionStatus,
  appendGracePeriodStatus,
  formatCodCard,
  formatSubmittedCard,
} from '../src/bot/views/cards';
import {
  createCodActionKeyboard,
  createMainMenuKeyboard,
  createPaymentActionKeyboard,
  createStoreDetailKeyboard,
  createUndoKeyboard,
  createWalletsDashboardKeyboard,
} from '../src/bot/views/keyboards';
import {
  apiKeys,
  botConfig,
  payments,
  stores,
  type Payment,
  type Store,
  type Wallet,
} from '../src/db/schema';
import type { Env } from '../src/types';

const TEST_BOT_INFO = JSON.stringify({
  id: 123456789,
  is_bot: true,
  first_name: 'SMPG Test Bot',
  username: 'smpg_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
});

const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Matches Unicode emoji / pictographic / dingbat / misc symbol characters & variation selector-16
const EMOJI_REGEX = /[\p{Extended_Pictographic}\u{2600}-\u{27BF}\u{FE0F}]/u;

function createMockBotEnv(d1: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: d1,
    TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
    TELEGRAM_WEBHOOK_SECRET: 'super_secret_token_123',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    BOT_INFO: TEST_BOT_INFO,
    UNDO_WINDOW_SECONDS: '90',
    SUBMITTED_TTL_HOURS: '24',
    CREATED_TTL_MINUTES: '30',
    LATE_SUBMIT_HOURS: '24',
    ...overrides,
  };
}

function attachMockTelegramApi(bot: ReturnType<typeof createBot>) {
  const calls: Array<{ method: string; payload: any }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return {
        ok: true,
        result: {
          message_id: 1000 + calls.length,
          date: Math.floor(Date.now() / 1000),
          chat: { id: (payload as any).chat_id ?? 1, type: 'private' },
          text: (payload as any).text ?? '',
        },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
  return calls;
}

function makeMessageUpdate(
  updateId: number,
  chatId: number,
  text: string,
  replyToMessage?: { message_id: number; text: string }
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' as const },
      from: { id: chatId, is_bot: false, first_name: 'Tester', username: `user_${chatId}` },
      text,
      ...(replyToMessage
        ? {
            reply_to_message: {
              message_id: replyToMessage.message_id,
              date: Math.floor(Date.now() / 1000),
              chat: { id: chatId, type: 'private' as const },
              text: replyToMessage.text,
            },
          }
        : {}),
      ...(text.startsWith('/')
        ? {
            entities: [
              {
                type: 'bot_command' as const,
                offset: 0,
                length: text.split(/\s+/)[0].length,
              },
            ],
          }
        : {}),
    },
  };
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('Telegram Bot & Views (Sprint 7)', () => {
  test('Webhook rejects requests with missing or invalid secret token', async () => {
    const resNoToken = await app.request(
      '/v1/telegram-webhook',
      {
        method: 'POST',
        body: JSON.stringify({ update_id: 123 }),
      },
      {
        TELEGRAM_WEBHOOK_SECRET: 'super_secret_token_123',
      } as any
    );
    expect(resNoToken.status).toBe(401);

    const resWrongToken = await app.request(
      '/v1/telegram-webhook',
      {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': 'wrong_token',
        },
        body: JSON.stringify({ update_id: 123 }),
      },
      {
        TELEGRAM_WEBHOOK_SECRET: 'super_secret_token_123',
      } as any
    );
    expect(resWrongToken.status).toBe(401);
  });

  test('Strict owner lock rejects strangers with zero DB writes when OWNER_TELEGRAM_ID is set', async () => {
    const { d1, db } = createTestD1();
    const env = createMockBotEnv(d1, { OWNER_TELEGRAM_ID: '111222333' });
    const bot = createBot(env, db);
    const calls = attachMockTelegramApi(bot);

    // Stranger sends /start, /stores, and plain text
    await bot.handleUpdate(makeMessageUpdate(1, 999888777, '/start'));
    await bot.handleUpdate(makeMessageUpdate(2, 999888777, '/stores'));
    await bot.handleUpdate(makeMessageUpdate(3, 999888777, 'ok'));

    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.method).toBe('sendMessage');
      expect(c.payload.text).toBe('Access denied. This is a private SMPG bot.');
    }

    // Confirm ZERO DB writes occurred for the stranger
    const configs = await db.select().from(botConfig).all();
    const allStores = await db.select().from(stores).all();
    expect(configs.length).toBe(0);
    expect(allStores.length).toBe(0);
  });

  test('/start <SETUP_TOKEN> rejects wrong token and claims bot_config on right token', async () => {
    const { d1, db } = createTestD1();
    const env = createMockBotEnv(d1, { SETUP_TOKEN: 'claim-secret-42' });
    const bot = createBot(env, db);
    const calls = attachMockTelegramApi(bot);

    // 1. Missing token -> rejected, zero DB writes
    await bot.handleUpdate(makeMessageUpdate(1, 555000111, '/start'));
    expect(calls[0].payload.text).toBe('Access denied. This is a private SMPG bot.');
    expect((await db.select().from(botConfig).all()).length).toBe(0);

    // 2. Wrong token -> rejected, zero DB writes
    await bot.handleUpdate(makeMessageUpdate(2, 555000111, '/start wrong-token'));
    expect(calls[1].payload.text).toBe('Access denied. This is a private SMPG bot.');
    expect((await db.select().from(botConfig).all()).length).toBe(0);

    // 3. Correct token -> claims ownership and prompts to create first store
    await bot.handleUpdate(makeMessageUpdate(3, 555000111, '/start claim-secret-42'));
    expect(calls[2].payload.text).toContain('Ownership Claimed');
    expect(calls[2].payload.text).toContain('Create New Store');

    const claimed = await db.select().from(botConfig).where(eq(botConfig.id, 'default')).get();
    expect(claimed?.ownerTelegramChatId).toBe(555000111);

    // 4. Subsequent stranger with the same token is still rejected
    await bot.handleUpdate(makeMessageUpdate(4, 777000999, '/start claim-secret-42'));
    expect(calls[3].payload.text).toBe('Access denied. This is a private SMPG bot.');

    // 5. Owner replies to "Create New Store" ForceReply to create their first store
    await bot.handleUpdate(
      makeMessageUpdate(5, 555000111, 'Dhaka Fashion', {
        message_id: 1003,
        text: 'Create New Store\n\nReply with your first store name:',
      })
    );

    const createdStores = await db.select().from(stores).all();
    expect(createdStores.length).toBe(1);
    expect(createdStores[0].name).toBe('Dhaka Fashion');
    expect(createdStores[0].id.startsWith('str_')).toBe(true);

    const createdKeys = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.storeId, createdStores[0].id))
      .all();
    expect(createdKeys.length).toBe(2);
    expect(createdKeys.map((k) => k.mode).sort()).toEqual(['live', 'test']);
  });

  test('Card formatters include storeName and contain zero emojis', () => {
    const mockBkashPayment: Payment = {
      id: 'pay_123',
      storeId: 'str_1',
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
      telegramMessageId: null,
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

    const mockWallet: Wallet = {
      id: 'wal_1',
      storeId: null,
      provider: 'bkash',
      number: '01799887766',
      label: 'Main bKash',
      dailyLimit: 25000,
      priority: 100,
      active: 1,
      createdAt: 1731300000,
    };

    const bkashCard = formatSubmittedCard(mockBkashPayment, mockWallet, 'Dhaka Fashion');
    expect(bkashCard).toContain('[Dhaka Fashion] bKash Payment · ORD-1042');
    expect(bkashCard).toContain('৳1,250');
    expect(bkashCard).toContain('01799887766 (Main bKash)');
    expect(bkashCard).toContain('TrxID:');
    expect(bkashCard).toContain('9K3L2M1ABC');
    expect(bkashCard).toContain('Wallet:');
    expect(bkashCard).not.toContain('Sent to:');
    expect(EMOJI_REGEX.test(bkashCard)).toBe(false);

    const nagadCard = formatSubmittedCard(
      { ...mockBkashPayment, method: 'nagad', lateSubmission: 1 },
      { ...mockWallet, provider: 'nagad', number: '01899887766', label: 'Nagad-1' },
      'Gadget Store'
    );
    expect(nagadCard).toContain('[Gadget Store] Nagad Payment · ORD-1042 [LATE]');
    expect(nagadCard).toContain('TxnID:');
    expect(EMOJI_REGEX.test(nagadCard)).toBe(false);

    const codCard = formatCodCard({ ...mockBkashPayment, method: 'cod' }, 'Dhaka Fashion');
    expect(codCard).toContain('[Dhaka Fashion] COD Order · ORD-1042');
    expect(codCard).toContain('Rahim');
    expect(EMOJI_REGEX.test(codCard)).toBe(false);

    const graceCard = appendGracePeriodStatus(bkashCard, 'approve', '@seller', '14:32:00');
    expect(graceCard).toContain('[Approving] by @seller');
    expect(graceCard).toContain('14:32:00');
    expect(EMOJI_REGEX.test(graceCard)).toBe(false);

    const finalCard = appendFinalDecisionStatus(bkashCard, 'approve', '@seller', '14:32');
    expect(finalCard).toContain('[Approved] by @seller · 14:32');
    expect(EMOJI_REGEX.test(finalCard)).toBe(false);
  });

  test('Keyboards contain expected actions and zero emojis', () => {
    const mockStore: Store = {
      id: 'str_1',
      name: 'My Store',
      codEnabled: 1,
      webhookUrl: null,
      webhookSecret: 'enc',
      paused: 0,
      createdAt: 1731300000,
    };

    const keyboards = [
      createPaymentActionKeyboard('pay_1'),
      createCodActionKeyboard('pay_1'),
      createUndoKeyboard('pay_1'),
      createMainMenuKeyboard(),
      createStoreDetailKeyboard(mockStore),
      createWalletsDashboardKeyboard([], 'balanced'),
    ];

    for (const kb of keyboards) {
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          expect(EMOJI_REGEX.test(btn.text)).toBe(false);
        }
      }
    }

    const mainLabels = createMainMenuKeyboard()
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(mainLabels).toEqual(['Stores', 'Wallets', 'Payments', 'Help']);

    const storeLabels = createStoreDetailKeyboard(mockStore)
      .inline_keyboard.flat()
      .map((b) => b.text);
    expect(storeLabels).toContain('View Server Credentials');
  });

  test('View Server Credentials displays copyable SMPG_CORE_URL, SMPG_SECRET_KEY, and SMPG_WEBHOOK_SECRET', async () => {
    const { d1, db } = createTestD1();
    const env = createMockBotEnv(d1);
    const bundle = await createStoreWithCredentials(db, env, 'NextJS Demo');

    const replies: Array<{ text: string; options?: any }> = [];
    const mockCtx: any = {
      isOwner: true,
      ownerChatId: 123456,
      db,
      env,
      coreUrl: 'https://smpg-core.example.workers.dev',
      reply: async (text: string, options?: any) => {
        replies.push({ text, options });
      },
    };

    await renderStoreServerCredentials(mockCtx, bundle.store.id);

    expect(replies.length).toBe(1);
    const msg = replies[0].text;
    expect(replies[0].options?.parse_mode).toBe('HTML');
    expect(msg).toContain('<code>https://smpg-core.example.workers.dev</code>');
    expect(msg).toContain(`<code>${bundle.liveKey}</code>`);
    expect(msg).toContain(`<code>${bundle.testKey}</code>`);
    expect(msg).toContain(`<code>${bundle.webhookSecret}</code>`);
    expect(msg).toContain('SMPG_CORE_URL=https://smpg-core.example.workers.dev');
    expect(msg).toContain(`SMPG_SECRET_KEY=${bundle.liveKey}`);
    expect(msg).toContain(`SMPG_WEBHOOK_SECRET=${bundle.webhookSecret}`);
    expect(EMOJI_REGEX.test(msg)).toBe(false);
  });

  test('applyPaymentDecision updates pending decision and starts undo countdown', async () => {
    const { d1, db } = createTestD1();
    const now = Math.floor(Date.now() / 1000);
    const storeId = 'str_quick_reply_test';

    await db.insert(stores).values({
      id: storeId,
      name: 'Test Store',
      webhookSecret: 'secret_123',
      createdAt: now,
    });

    await db.insert(payments).values({
      id: 'pay_reply_to_approve',
      storeId,
      mode: 'live',
      amount: 1500,
      status: 'SUBMITTED',
      method: 'bkash',
      trxId: 'TXN12345678',
      expiresAt: now + 3600,
      successUrl: 'https://store.example/success',
      createdAt: now,
      updatedAt: now,
    });

    const env = createMockBotEnv(d1);

    const res = await applyPaymentDecision({
      db,
      env,
      storeId,
      telegramChatId: 99887766,
      paymentId: 'pay_reply_to_approve',
      action: 'approve',
      actorName: '@seller',
      actorDb: 'telegram:@seller',
    });

    expect(res.success).toBe(true);
    expect(res.payment?.pendingDecision).toBe('approve');
    expect(res.effectiveAt).toBeGreaterThan(now);

    const updated = await db
      .select()
      .from(payments)
      .where(eq(payments.id, 'pay_reply_to_approve'))
      .get();
    expect(updated?.pendingDecision).toBe('approve');
    expect(updated?.decisionActor).toBe('telegram:@seller');
  });

  test('Zero emojis exist anywhere in apps/core/src/bot/**/*.ts', () => {
    const botDir = join(__dirname, '../src/bot');
    const files = collectTsFiles(botDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const match = content.match(EMOJI_REGEX);
      if (match) {
        violations.push(`${file}: found "${match[0]}"`);
      }
    }

    expect(violations).toEqual([]);
  });
});
