import { eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { apiKeys, merchants } from '../../db/schema';
import {
  encryptAesGcm,
  generateApiKey,
  generatePrefixedId,
  generateWebhookSecret,
  sha256,
} from '../../services/crypto';
import { createMainMenuKeyboard } from '../views/keyboards';

export async function handleStartCommand(ctx: BotContext) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // 1. Check if already registered
  const [existingMerchant] = await ctx.db
    .select()
    .from(merchants)
    .where(eq(merchants.telegramChatId, chatId))
    .limit(1);

  if (existingMerchant) {
    const storeTitle = existingMerchant.storeName || 'your store';
    await ctx.reply(
      [
        `👋 <b>Welcome back to SMPG!</b>`,
        '',
        `Your store <b>${storeTitle}</b> is active.`,
        `Merchant ID: <code>${existingMerchant.id}</code>`,
        '',
        `Select an action from the dashboard below:`,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: createMainMenuKeyboard() }
    );
    return;
  }

  // 2. Register new merchant
  const now = Math.floor(Date.now() / 1000);
  const merchantId = generatePrefixedId('mrc');
  const rawWebhookSecret = generateWebhookSecret();
  const encryptedWebhookSecret = await encryptAesGcm(rawWebhookSecret, ctx.env.ENCRYPTION_KEY);

  // Generate API keys
  const liveKeyData = generateApiKey('live');
  const testKeyData = generateApiKey('test');

  const liveHash = await sha256(liveKeyData.key);
  const testHash = await sha256(testKeyData.key);

  // Insert merchant
  await ctx.db.insert(merchants).values({
    id: merchantId,
    telegramChatId: chatId,
    storeName: 'My Store',
    brandColor: '#000000',
    codEnabled: 1,
    rotationStrategy: 'balanced',
    webhookSecret: encryptedWebhookSecret,
    testMode: 1,
    paused: 0,
    createdAt: now,
  });

  // Insert live API key
  await ctx.db.insert(apiKeys).values({
    id: generatePrefixedId('key'),
    merchantId,
    keyHash: liveHash,
    prefix: liveKeyData.prefix,
    mode: 'live',
    createdAt: now,
  });

  // Insert test API key
  await ctx.db.insert(apiKeys).values({
    id: generatePrefixedId('key'),
    merchantId,
    keyHash: testHash,
    prefix: testKeyData.prefix,
    mode: 'test',
    createdAt: now,
  });

  // Format onboarding message
  const welcomeText = [
    `🎉 <b>Welcome to SMPG (Send Money Payment Gateway)!</b>`,
    '',
    `Your store account has been successfully initialized.`,
    `Merchant ID: <code>${merchantId}</code>`,
    '',
    `🔑 <b>Your API Credentials (Save these now, shown only once):</b>`,
    `<b>Live API Key:</b>`,
    `<code>${liveKeyData.key}</code>`,
    '',
    `<b>Test API Key:</b>`,
    `<code>${testKeyData.key}</code>`,
    '',
    `🔒 <b>Webhook Secret:</b>`,
    `<code>${rawWebhookSecret}</code>`,
    '',
    `👉 Use the buttons below to configure your receiving wallets and store branding:`,
  ].join('\n');

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: createMainMenuKeyboard(),
  });
}
