import { and, desc, eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { apiKeys, merchants, merchantWallets, payments, paymentEvents } from '../../db/schema';
import {
  createKeysKeyboard,
  createMainMenuKeyboard,
  createPaymentsKeyboard,
  createSettingsKeyboard,
  createWalletDetailKeyboard,
  createWalletsDashboardKeyboard,
} from '../views/keyboards';
import { getMerchantWalletsWithUsage } from '../../services/wallet';
import { decryptAesGcm, generateApiKey, generatePrefixedId, sha256 } from '../../services/crypto';

function renderProgressBar(percentage: number): string {
  const totalBars = 10;
  const filledBars = Math.min(totalBars, Math.round((percentage / 100) * totalBars));
  const emptyBars = totalBars - filledBars;
  return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
}

/**
 * Renders the Main Dashboard menu.
 */
export async function renderMainMenu(ctx: BotContext, editMessage = false) {
  if (!ctx.merchant) return;

  const wallets = await ctx.db
    .select()
    .from(merchantWallets)
    .where(eq(merchantWallets.merchantId, ctx.merchant.id));

  const text = [
    `🏪 <b>${ctx.merchant.storeName || 'SMPG Merchant Dashboard'}</b>`,
    `Merchant ID: <code>${ctx.merchant.id}</code>`,
    `Status: ${ctx.merchant.paused ? '⏸ <b>Paused</b>' : '🟢 <b>Active</b>'}`,
    `Active Wallets: <b>${wallets.filter((w) => w.active === 1).length}</b> / ${wallets.length}`,
    `COD: <b>${ctx.merchant.codEnabled ? 'Enabled' : 'Disabled'}</b>`,
    '',
    `Select a section below:`,
  ].join('\n');

  const keyboard = createMainMenuKeyboard();

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Wallets Dashboard.
 */
export async function renderWalletsDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.merchant) return;

  const walletsWithUsage = await getMerchantWalletsWithUsage(ctx.db, ctx.merchant.id);
  const rawWallets = walletsWithUsage.map((w) => w.wallet);

  const lines = [
    `📱 <b>Receiving Wallets Dashboard</b>`,
    `Daily Rotation Mode: <code>${ctx.merchant.rotationStrategy}</code>`,
    '',
  ];

  if (walletsWithUsage.length === 0) {
    lines.push('<i>No wallets added yet. Tap a button below to add your first receiving wallet.</i>');
  } else {
    for (const item of walletsWithUsage) {
      const w = item.wallet;
      const providerBadge = w.provider === 'bkash' ? '🔴 bKash' : '🟠 Nagad';
      const labelText = w.label ? ` (${w.label})` : '';
      const statusText = w.active === 1 ? '🟢 Active' : '⏸ Paused';
      const progressBar = renderProgressBar(item.percentageUsed);

      lines.push(
        `${providerBadge}${labelText}: <code>${w.number}</code>`,
        `৳${item.reservedToday.toLocaleString('en-BD')} / ৳${w.dailyLimit.toLocaleString('en-BD')} [${progressBar}] ${item.percentageUsed}%`,
        `Status: ${statusText} · Priority: ${w.priority}`,
        ''
      );
    }
  }

  const keyboard = createWalletsDashboardKeyboard(rawWallets, ctx.merchant.rotationStrategy);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Settings Dashboard.
 */
export async function renderSettingsDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.merchant) return;

  const lines = [
    `⚙️ <b>Store Settings</b>`,
    '',
    `• <b>Store Name:</b> ${ctx.merchant.storeName || 'Not Set'}`,
    `• <b>Brand Color:</b> <code>${ctx.merchant.brandColor || '#000000'}</code>`,
    `• <b>Cash on Delivery (COD):</b> ${ctx.merchant.codEnabled ? '🟢 Enabled' : '🔴 Disabled'}`,
    `• <b>Webhook URL:</b> <code>${ctx.merchant.webhookUrl || 'Not configured'}</code>`,
    `• <b>Store Status:</b> ${ctx.merchant.paused ? '⏸ Paused (rejecting new payments)' : '🟢 Active'}`,
    '',
    `Tap any setting below to edit:`,
  ];

  const keyboard = createSettingsKeyboard(ctx.merchant);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the API Keys Dashboard.
 */
export async function renderKeysDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.merchant) return;

  const activeKeys = await ctx.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.merchantId, ctx.merchant.id)));

  const lines = [
    `🔑 <b>API Credentials</b>`,
    `Merchant ID: <code>${ctx.merchant.id}</code>`,
    '',
  ];

  for (const k of activeKeys) {
    if (k.revokedAt) continue;
    const modeBadge = k.mode === 'live' ? '🟢 Live' : '🟡 Test';
    lines.push(`• ${modeBadge}: <code>${k.prefix}...</code>`);
  }

  lines.push(
    '',
    `<i>Note: Full secret keys are only shown once upon creation or rotation.</i>`,
    `Tap below to rotate a key:`
  );

  const keyboard = createKeysKeyboard();

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Payments Dashboard.
 */
export async function renderPaymentsDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.merchant) return;

  const list = await ctx.db
    .select()
    .from(payments)
    .where(eq(payments.merchantId, ctx.merchant.id))
    .orderBy(desc(payments.createdAt))
    .limit(10);

  const lines = ['📋 <b>Recent Transactions</b>', ''];

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;
  const reopenable = list.filter((p) => p.status === 'REJECTED' && p.updatedAt >= sevenDaysAgo);

  if (list.length === 0) {
    lines.push('<i>No payments recorded yet.</i>');
  } else {
    for (const p of list) {
      const orderRef = p.externalOrderId ? ` · ${p.externalOrderId}` : '';
      const dateStr = new Date(p.createdAt * 1000).toLocaleString('en-US', {
        timeZone: 'Asia/Dhaka',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      lines.push(
        `• <code>${p.id}</code>${orderRef} — <b>৳${p.amount.toLocaleString('en-BD')}</b> (${p.method})`,
        `  Status: <b>${p.status}</b> · ${dateStr}`,
        ''
      );
    }
  }

  const keyboard = createPaymentsKeyboard(reopenable);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Handles all menu & action callbacks.
 */
export async function handleMenuCallback(ctx: BotContext, data: string) {
  await ctx.answerCallbackQuery();

  // Navigation
  if (data === 'menu:main') {
    return renderMainMenu(ctx, true);
  }
  if (data === 'menu:wallets') {
    return renderWalletsDashboard(ctx, true);
  }
  if (data === 'menu:settings') {
    return renderSettingsDashboard(ctx, true);
  }
  if (data === 'menu:keys') {
    return renderKeysDashboard(ctx, true);
  }
  if (data === 'menu:payments') {
    return renderPaymentsDashboard(ctx, true);
  }
  if (data === 'menu:help') {
    return ctx.reply(
      [
        '📖 <b>SMPG Payments Bot Guide</b>',
        '',
        'Use the interactive buttons in each menu to easily manage your store without remembering commands!',
        '',
        '<b>Quick Shortcuts:</b>',
        '• /wallets - Add and manage receiving wallets',
        '• /settings - Customize store branding and webhooks',
        '• /payments - View recent payments and reopen rejected ones',
        '• /keys - Rotate API credentials',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }

  // Wallet Actions
  if (data === 'wallet:add:bkash') {
    await ctx.reply(
      '📱 <b>Adding bKash Wallet</b>\n\nPlease reply to this message with your 11-digit bKash number and an optional label.\n\n<b>Example:</b> <code>017XXXXXXXX Primary</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '017XXXXXXXX [label]' },
      }
    );
    return;
  }

  if (data === 'wallet:add:nagad') {
    await ctx.reply(
      '📱 <b>Adding Nagad Wallet</b>\n\nPlease reply to this message with your 11-digit Nagad number and an optional label.\n\n<b>Example:</b> <code>018XXXXXXXX Nagad1</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '018XXXXXXXX [label]' },
      }
    );
    return;
  }

  if (data === 'wallet:toggle_strategy') {
    if (!ctx.merchant) return;
    const nextStrategy = ctx.merchant.rotationStrategy === 'balanced' ? 'fill_first' : 'balanced';
    await ctx.db
      .update(merchants)
      .set({ rotationStrategy: nextStrategy })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.rotationStrategy = nextStrategy;
    return renderWalletsDashboard(ctx, true);
  }

  if (data.startsWith('wallet:view:')) {
    const walletId = data.replace('wallet:view:', '');
    const [wallet] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.id, walletId))
      .limit(1);

    if (!wallet) return;

    const providerTag = wallet.provider === 'bkash' ? '🔴 bKash' : '🟠 Nagad';
    const text = [
      `📱 <b>Wallet Details</b>`,
      `Provider: ${providerTag}`,
      `Number: <code>${wallet.number}</code>`,
      `Label: ${wallet.label || 'None'}`,
      `Daily Limit: ৳${wallet.dailyLimit.toLocaleString('en-BD')}`,
      `Status: ${wallet.active ? '🟢 Active' : '⏸ Paused'}`,
      `Priority: ${wallet.priority}`,
    ].join('\n');

    return ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: createWalletDetailKeyboard(wallet),
    });
  }

  if (data.startsWith('wallet:toggle_active:')) {
    const walletId = data.replace('wallet:toggle_active:', '');
    const [wallet] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.id, walletId))
      .limit(1);

    if (!wallet) return;

    await ctx.db
      .update(merchantWallets)
      .set({ active: wallet.active === 1 ? 0 : 1 })
      .where(eq(merchantWallets.id, walletId));

    return renderWalletsDashboard(ctx, true);
  }

  if (data.startsWith('wallet:delete:')) {
    const walletId = data.replace('wallet:delete:', '');
    await ctx.db.delete(merchantWallets).where(eq(merchantWallets.id, walletId));
    return renderWalletsDashboard(ctx, true);
  }

  if (data.startsWith('wallet:edit_limit:')) {
    const walletId = data.replace('wallet:edit_limit:', '');
    const [wallet] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.id, walletId))
      .limit(1);

    if (!wallet) return;

    await ctx.reply(
      `✏️ <b>Edit Daily Limit</b>\nWallet: <code>${wallet.number}</code>\nID: <code>${wallet.id}</code>\n\nPlease reply with the new daily limit amount in whole taka (BDT):\n\n<b>Example:</b> <code>30000</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Amount in BDT (e.g. 25000)' },
      }
    );
    return;
  }

  // Settings Actions
  if (data === 'settings:store_name') {
    await ctx.reply(
      '✏️ <b>Set Store Name</b>\n\nPlease reply to this message with your new store or brand name (up to 50 characters):',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'My Brand Store' },
      }
    );
    return;
  }

  if (data === 'settings:brand_color') {
    await ctx.reply(
      '🎨 <b>Set Brand Color</b>\n\nPlease reply to this message with a hex color code (e.g. #E11D48 or #10B981):',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '#E11D48' },
      }
    );
    return;
  }

  if (data === 'settings:toggle_cod') {
    if (!ctx.merchant) return;
    const nextCod = ctx.merchant.codEnabled === 1 ? 0 : 1;
    await ctx.db
      .update(merchants)
      .set({ codEnabled: nextCod })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.codEnabled = nextCod;
    return renderSettingsDashboard(ctx, true);
  }

  if (data === 'settings:toggle_pause') {
    if (!ctx.merchant) return;
    const nextPaused = ctx.merchant.paused === 1 ? 0 : 1;
    await ctx.db
      .update(merchants)
      .set({ paused: nextPaused })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.paused = nextPaused;
    return renderSettingsDashboard(ctx, true);
  }

  if (data === 'settings:webhook') {
    await ctx.reply(
      '🔗 <b>Set Webhook URL</b>\n\nPlease reply to this message with your HTTPS webhook endpoint URL:\n\n<b>Example:</b> <code>https://your-site.com/api/smpg-webhook</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'https://...' },
      }
    );
    return;
  }

  if (data === 'settings:ping_webhook') {
    if (!ctx.merchant?.webhookUrl) {
      await ctx.reply('⚠️ Please set a webhook URL first before sending a test ping.');
      return;
    }

    try {
      const rawSecret = await decryptAesGcm(ctx.merchant.webhookSecret, ctx.env.ENCRYPTION_KEY);
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        id: 'evt_test_ping',
        type: 'payment.created',
        created: timestamp,
        data: {
          id: 'pay_test_ping',
          amount: 100,
          status: 'CREATED',
          method: 'bkash',
          test: true,
        },
      });

      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(rawSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${payload}`));
      const sigHex = Array.from(new Uint8Array(sigBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const res = await fetch(ctx.merchant.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-smpg-signature': `t=${timestamp},v1=${sigHex}`,
          'x-smpg-event': 'payment.created',
        },
        body: payload,
      });

      await ctx.reply(
        res.ok
          ? `🟢 <b>Test ping succeeded!</b> (HTTP ${res.status})`
          : `🟡 <b>Test ping returned:</b> HTTP ${res.status}`,
        { parse_mode: 'HTML' }
      );
    } catch (err: any) {
      await ctx.reply(`🔴 <b>Test ping failed:</b> ${err.message}`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Key Rotations
  if (data === 'keys:rotate:live' || data === 'keys:rotate:test') {
    if (!ctx.merchant) return;
    const targetMode = data.includes('live') ? 'live' : 'test';
    const now = Math.floor(Date.now() / 1000);

    await ctx.db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiKeys.merchantId, ctx.merchant.id),
          eq(apiKeys.mode, targetMode)
        )
      );

    const newKeyData = generateApiKey(targetMode);
    const keyHash = await sha256(newKeyData.key);

    await ctx.db.insert(apiKeys).values({
      id: generatePrefixedId('key'),
      merchantId: ctx.merchant.id,
      keyHash,
      prefix: newKeyData.prefix,
      mode: targetMode,
      createdAt: now,
    });

    await ctx.reply(
      [
        `🔑 <b>${targetMode.toUpperCase()} API Key Rotated!</b>`,
        '',
        `New API Key (save this now, shown only once):`,
        `<code>${newKeyData.key}</code>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return renderKeysDashboard(ctx);
  }

  // 1-Tap Reopen
  if (data.startsWith('pay:reopen:')) {
    const paymentId = data.replace('pay:reopen:', '');
    const now = Math.floor(Date.now() / 1000);
    const actor = ctx.from?.username ? `telegram:@${ctx.from.username}` : `telegram:${ctx.from?.id}`;

    await ctx.db
      .update(payments)
      .set({
        status: 'SUBMITTED',
        pendingDecision: null,
        decisionActor: null,
        decisionEffectiveAt: null,
        updatedAt: now,
      })
      .where(eq(payments.id, paymentId));

    await ctx.db.insert(paymentEvents).values({
      paymentId,
      fromStatus: 'REJECTED',
      toStatus: 'SUBMITTED',
      actor,
      note: 'Reopened via 1-tap button in Telegram',
      createdAt: now,
    });

    await ctx.reply(`✅ Payment <code>${paymentId}</code> has been reopened to <b>SUBMITTED</b>.`, {
      parse_mode: 'HTML',
    });
    return renderPaymentsDashboard(ctx, true);
  }
}
