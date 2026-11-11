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
        `Your account for <b>${storeTitle}</b> is active.`,
        `Merchant ID: <code>${existingMerchant.id}</code>`,
        '',
        `<b>Available Commands:</b>`,
        `• /wallets - View and manage payment wallets`,
        `• /add_bkash & /add_nagad - Add receiving accounts`,
        `• /payments - View recent payments`,
        `• /keys - Manage your API credentials`,
        `• /help - Full command guide`,
      ].join('\n'),
      { parse_mode: 'HTML' }
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
    `🔑 <b>Your API Keys (Save these securely, shown only once):</b>`,
    `<b>Live Key:</b>`,
    `<code>${liveKeyData.key}</code>`,
    '',
    `<b>Test Key:</b>`,
    `<code>${testKeyData.key}</code>`,
    '',
    `🔒 <b>Webhook Secret:</b>`,
    `<code>${rawWebhookSecret}</code>`,
    '',
    `👉 <b>Next Steps:</b>`,
    `1. Add your bKash wallet: <code>/add_bkash 017XXXXXXXX MyWallet</code>`,
    `2. Add your Nagad wallet: <code>/add_nagad 018XXXXXXXX Nagad1</code>`,
    `3. Customize your store name: <code>/store_name Your Brand</code>`,
    `4. Set your webhook URL: <code>/webhook https://your-site.com/api/smpg-webhook</code>`,
    '',
    `Type /help for the full list of options.`,
  ].join('\n');

  await ctx.reply(welcomeText, { parse_mode: 'HTML' });
}
