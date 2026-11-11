import { and, eq, inArray } from 'drizzle-orm';
import type { BotContext } from '../context';
import {
  apiKeys,
  merchants,
  merchantWallets,
  paymentEvents,
  payments,
  trxSubmissions,
  webhookDeliveries,
} from '../../db/schema';
import {
  decryptAesGcm,
  encryptAesGcm,
  generateApiKey,
  generatePrefixedId,
  generateWebhookSecret,
  sha256,
} from '../../services/crypto';
import {
  createBrandColorKeyboard,
  createCreateStoreKeyboard,
  createMainMenuKeyboard,
  createNidQuestionKeyboard,
} from '../views/keyboards';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

/**
 * Initiates or resumes the multi-step onboarding flow.
 */
export async function handleStartOnboarding(ctx: BotContext) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const [existingMerchant] = await ctx.db
    .select()
    .from(merchants)
    .where(eq(merchants.telegramChatId, chatId))
    .limit(1);

  // 1. If merchant already finished onboarding
  if (existingMerchant && existingMerchant.onboardingStep === 'completed') {
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

  // 2. Resume existing incomplete onboarding
  if (existingMerchant) {
    ctx.merchant = existingMerchant;
    const step = existingMerchant.onboardingStep || 'name';

    if (step === 'name') {
      await ctx.reply(
        '👋 <b>Welcome to SMPG!</b>\n\nTo begin, what is your <b>Full Name</b>?',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (step === 'phone') {
      await ctx.reply(
        `Please enter your phone number in the format <code>01XXXXXXXXX</code>:`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (step === 'nid') {
      await ctx.reply('Can you provide NID / Passport if required?', {
        reply_markup: createNidQuestionKeyboard(),
      });
      return;
    }

    if (step === 'ready_to_create_store') {
      await ctx.reply(
        [
          '🎉 <b>Welcome to SMPG!</b>',
          '',
          `Merchant ID: <code>${existingMerchant.id}</code>`,
          '',
          '<b>Next Step:</b> Creating your store.',
        ].join('\n'),
        { parse_mode: 'HTML', reply_markup: createCreateStoreKeyboard() }
      );
      return;
    }

    if (step === 'store_name') {
      await ctx.reply(
        '🏪 What is your <b>Store Name</b>? (e.g. <i>Modish Apparel</i>):',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (step === 'brand_color') {
      await ctx.reply(
        [
          '🎨 <b>Choose Your Brand Color</b>',
          '',
          'Pick out your brand color and copy the hex code:',
          '👉 <a href="https://htmlcolorcodes.com/color-picker/">HTML Color Codes Picker</a>',
          '',
          'Send the hex code below (e.g. <code>#E11D48</code>) or tap Skip to use default:',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: createBrandColorKeyboard(),
          link_preview_options: { is_disabled: false },
        }
      );
      return;
    }
  }

  // 3. New registration: insert initial merchant record with step = 'name'
  const now = Math.floor(Date.now() / 1000);
  const merchantId = generatePrefixedId('mrc');
  const rawWebhookSecret = generateWebhookSecret();
  const encryptedWebhookSecret = await encryptAesGcm(rawWebhookSecret, ctx.env.ENCRYPTION_KEY);

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
    onboardingStep: 'name',
    canProvideNid: 0,
    createdAt: now,
  });

  const [newMerchant] = await ctx.db
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  ctx.merchant = newMerchant;

  await ctx.reply(
    '👋 <b>Welcome to SMPG!</b>\n\nTo begin, what is your <b>Full Name</b>?',
    { parse_mode: 'HTML' }
  );
}

/**
 * Handles text input during onboarding steps.
 */
export async function handleOnboardingText(ctx: BotContext, input: string): Promise<boolean> {
  if (!ctx.merchant || !ctx.merchant.onboardingStep || ctx.merchant.onboardingStep === 'completed') {
    return false;
  }

  const step = ctx.merchant.onboardingStep;

  // Step 1: Name input
  if (step === 'name') {
    const name = input.trim();
    if (name.length < 2 || name.length > 100) {
      await ctx.reply('⚠️ Please enter a valid name (2-100 characters):');
      return true;
    }

    await ctx.db
      .update(merchants)
      .set({ ownerName: name, onboardingStep: 'phone' })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.ownerName = name;
    ctx.merchant.onboardingStep = 'phone';

    await ctx.reply(
      `Nice to meet you, <b>${name}</b>!\n\nPlease enter your phone number in the format <code>01XXXXXXXXX</code>:`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  // Step 2: Phone number input
  if (step === 'phone') {
    const phone = input.trim();
    if (!BD_PHONE_REGEX.test(phone)) {
      await ctx.reply(
        '⚠️ Please enter a valid 11-digit phone number in the format <code>01XXXXXXXXX</code> (e.g. <code>01712345678</code>):',
        { parse_mode: 'HTML' }
      );
      return true;
    }

    await ctx.db
      .update(merchants)
      .set({ phoneNumber: phone, onboardingStep: 'nid' })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.phoneNumber = phone;
    ctx.merchant.onboardingStep = 'nid';

    await ctx.reply('Can you provide NID / Passport if required?', {
      reply_markup: createNidQuestionKeyboard(),
    });
    return true;
  }

  // Step 5: Store Name input
  if (step === 'store_name') {
    const storeName = input.trim();
    if (storeName.length < 1 || storeName.length > 50) {
      await ctx.reply('⚠️ Store name must be between 1 and 50 characters. Please try again:');
      return true;
    }

    await ctx.db
      .update(merchants)
      .set({ storeName, onboardingStep: 'brand_color' })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.storeName = storeName;
    ctx.merchant.onboardingStep = 'brand_color';

    await ctx.reply(
      [
        '🎨 <b>Choose Your Brand Color</b>',
        '',
        'Pick out your brand color and copy the hex code:',
        '👉 <a href="https://htmlcolorcodes.com/color-picker/">HTML Color Codes Picker</a>',
        '',
        'Send the hex code below (e.g. <code>#E11D48</code>) or tap Skip to use default:',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: createBrandColorKeyboard(),
        link_preview_options: { is_disabled: false },
      }
    );
    return true;
  }

  // Step 6: Brand Color input
  if (step === 'brand_color') {
    const color = input.trim().toUpperCase();
    if (!/^#([0-9A-F]{3}|[0-9A-F]{6})$/.test(color)) {
      await ctx.reply(
        '⚠️ Invalid hex color code. Please send a valid hex code (e.g. <code>#E11D48</code>) or tap Skip below:',
        {
          parse_mode: 'HTML',
          reply_markup: createBrandColorKeyboard(),
        }
      );
      return true;
    }

    await completeOnboarding(ctx, color);
    return true;
  }

  return false;
}

/**
 * Handles button callbacks during onboarding.
 */
export async function handleOnboardingCallback(ctx: BotContext, data: string): Promise<boolean> {
  if (!ctx.merchant) return false;

  // NID Question: Yes / No
  if (data === 'onboarding:nid:yes' || data === 'onboarding:nid:no') {
    await ctx.answerCallbackQuery();
    const canProvide = data === 'onboarding:nid:yes' ? 1 : 0;

    await ctx.db
      .update(merchants)
      .set({ canProvideNid: canProvide, onboardingStep: 'ready_to_create_store' })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.canProvideNid = canProvide;
    ctx.merchant.onboardingStep = 'ready_to_create_store';

    await ctx.editMessageText(
      [
        '🎉 <b>Welcome to SMPG!</b>',
        '',
        `Merchant ID: <code>${ctx.merchant.id}</code>`,
        '',
        '<b>Next Step:</b> Creating your store.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: createCreateStoreKeyboard(),
      }
    );
    return true;
  }

  // Create Store button tap
  if (data === 'onboarding:create_store') {
    await ctx.answerCallbackQuery();

    await ctx.db
      .update(merchants)
      .set({ onboardingStep: 'store_name' })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.onboardingStep = 'store_name';

    await ctx.reply(
      '🏪 What is your <b>Store Name</b>? (e.g. <i>Modish Apparel</i>):',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  // Skip brand color tap
  if (data === 'onboarding:skip_color') {
    await ctx.answerCallbackQuery();
    await completeOnboarding(ctx, '#000000');
    return true;
  }

  return false;
}

/**
 * Finalizes onboarding, generates credentials, and reveals the dashboard.
 */
export async function completeOnboarding(ctx: BotContext, brandColor: string) {
  if (!ctx.merchant) return;

  const now = Math.floor(Date.now() / 1000);

  // Update merchant record
  await ctx.db
    .update(merchants)
    .set({
      brandColor,
      onboardingStep: 'completed',
    })
    .where(eq(merchants.id, ctx.merchant.id));
  ctx.merchant.brandColor = brandColor;
  ctx.merchant.onboardingStep = 'completed';

  // Check if API keys already exist
  const existingKeys = await ctx.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.merchantId, ctx.merchant.id));

  let liveKey = '';
  let testKey = '';

  if (existingKeys.length === 0) {
    const liveKeyData = generateApiKey('live');
    const testKeyData = generateApiKey('test');
    liveKey = liveKeyData.key;
    testKey = testKeyData.key;

    const liveHash = await sha256(liveKeyData.key);
    const testHash = await sha256(testKeyData.key);

    await ctx.db.insert(apiKeys).values({
      id: generatePrefixedId('key'),
      merchantId: ctx.merchant.id,
      keyHash: liveHash,
      prefix: liveKeyData.prefix,
      mode: 'live',
      createdAt: now,
    });

    await ctx.db.insert(apiKeys).values({
      id: generatePrefixedId('key'),
      merchantId: ctx.merchant.id,
      keyHash: testHash,
      prefix: testKeyData.prefix,
      mode: 'test',
      createdAt: now,
    });
  }

  // Decrypt raw webhook secret to show once
  let rawWebhookSecret = 'whsec_secret';
  try {
    rawWebhookSecret = await decryptAesGcm(ctx.merchant.webhookSecret, ctx.env.ENCRYPTION_KEY);
  } catch {
    // Fallback if decryption fails
  }

  const welcomeText = [
    `🎉 <b>Welcome to SMPG! Your Store is Ready!</b>`,
    '',
    `• Store Name: <b>${ctx.merchant.storeName || 'My Store'}</b>`,
    `• Merchant ID: <code>${ctx.merchant.id}</code>`,
    `• Brand Color: <code>${brandColor}</code>`,
    '',
    liveKey
      ? [
          `🔑 <b>Your API Credentials (Save these now, shown only once):</b>`,
          `<b>Live API Key:</b>`,
          `<code>${liveKey}</code>`,
          '',
          `<b>Test API Key:</b>`,
          `<code>${testKey}</code>`,
          '',
          `🔒 <b>Webhook Secret:</b>`,
          `<code>${rawWebhookSecret}</code>`,
          '',
        ].join('\n')
      : '',
    `👉 Next, add your receiving wallets (bKash/Nagad) using the menu below:`,
  ].join('\n');

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: createMainMenuKeyboard(),
  });
}

/**
 * Developer / testing command: /logout
 * Clears the merchant account and session so onboarding can be run afresh.
 */
export async function handleLogoutCommand(ctx: BotContext) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const [existingMerchant] = await ctx.db
    .select()
    .from(merchants)
    .where(eq(merchants.telegramChatId, chatId))
    .limit(1);

  if (!existingMerchant) {
    await ctx.reply('You are not currently registered. Type /start to onboard.');
    return;
  }

  const merchantId = existingMerchant.id;

  // 1. Delete api_keys
  await ctx.db.delete(apiKeys).where(eq(apiKeys.merchantId, merchantId));

  // 2. Delete merchant_wallets
  await ctx.db.delete(merchantWallets).where(eq(merchantWallets.merchantId, merchantId));

  // 3. Delete payments & child rows
  const merchantPayments = await ctx.db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.merchantId, merchantId));

  const paymentIds = merchantPayments.map((p) => p.id);
  if (paymentIds.length > 0) {
    await ctx.db.delete(trxSubmissions).where(inArray(trxSubmissions.paymentId, paymentIds));
    await ctx.db.delete(paymentEvents).where(inArray(paymentEvents.paymentId, paymentIds));
    await ctx.db.delete(webhookDeliveries).where(inArray(webhookDeliveries.paymentId, paymentIds));
    await ctx.db.delete(payments).where(eq(payments.merchantId, merchantId));
  }

  // 4. Delete merchant record
  await ctx.db.delete(merchants).where(eq(merchants.id, merchantId));

  ctx.merchant = null;

  await ctx.reply(
    '👋 <b>Logged out successfully!</b>\n\nYour test merchant account has been cleared.\n\nType /start to begin a fresh onboarding flow.',
    { parse_mode: 'HTML' }
  );
}

