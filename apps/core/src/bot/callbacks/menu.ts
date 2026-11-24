import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BotContext } from '../context';
import {
  apiKeys,
  botConfig,
  paymentEvents,
  payments,
  stores,
  trxSubmissions,
  wallets,
  webhookDeliveries,
} from '../../db/schema';
import {
  createMainMenuKeyboard,
  createPaymentsKeyboard,
  createStoreDeleteConfirmKeyboard,
  createStoreDetailKeyboard,
  createStoreKeysKeyboard,
  createStoresDashboardKeyboard,
  createWalletDetailKeyboard,
  createWalletScopeKeyboard,
  createWalletsDashboardKeyboard,
} from '../views/keyboards';
import { getRotationStrategy, getWalletsWithUsage } from '../../services/wallet';
import { decryptAesGcm, generateApiKey, generatePrefixedId, sha256 } from '../../services/crypto';
import { deliverWebhookPayload } from '../../services/webhook';
import { reopenRejectedPayment } from '../../services/decision';
import { ACCESS_DENIED_MESSAGE } from '../middleware/auth';
import { handleHelpCommand } from '../commands/stores';

function renderProgressBar(percentage: number): string {
  const totalBars = 10;
  const filledBars = Math.min(totalBars, Math.max(0, Math.round((percentage / 100) * totalBars)));
  const emptyBars = totalBars - filledBars;
  return '[' + '#'.repeat(filledBars) + '.'.repeat(emptyBars) + ']';
}

/**
 * Renders the Main Dashboard menu.
 */
export async function renderMainMenu(ctx: BotContext, editMessage = false) {
  if (!ctx.isOwner) return;

  const [allStores, allWallets, strategy] = await Promise.all([
    ctx.db.select().from(stores).all(),
    ctx.db.select().from(wallets).all(),
    getRotationStrategy(ctx.db),
  ]);

  const activeStores = allStores.filter((s) => s.paused === 0).length;
  const activeWallets = allWallets.filter((w) => w.active === 1).length;

  const text = [
    '<b>SMPG Owner Dashboard</b>',
    '',
    `<b>Stores:</b> ${activeStores} active / ${allStores.length} total`,
    `<b>Wallets:</b> ${activeWallets} active / ${allWallets.length} total`,
    `<b>Rotation Mode:</b> <code>${strategy}</code>`,
    '',
    'Select a section below:',
  ].join('\n');

  const keyboard = createMainMenuKeyboard();

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Stores Dashboard.
 */
export async function renderStoresDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.isOwner) return;

  const storeList = await ctx.db.select().from(stores).orderBy(stores.createdAt).all();

  const lines = ['<b>Stores Dashboard</b>', ''];

  if (storeList.length === 0) {
    lines.push('<i>No stores created yet. Tap "+ Create Store" below to add your first store.</i>');
  } else {
    for (const s of storeList) {
      const statusBadge = s.paused === 1 ? '[Paused]' : '[Active]';
      const webhookStatus = s.webhookUrl ? 'Configured' : 'Not set';
      const codStatus = s.codEnabled === 1 ? 'On' : 'Off';
      lines.push(
        `<b>${s.name}</b> ${statusBadge}`,
        `ID: <code>${s.id}</code> | COD: ${codStatus} | Webhook: ${webhookStatus}`,
        ''
      );
    }
  }

  const keyboard = createStoresDashboardKeyboard(storeList);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Store Detail view.
 */
export async function renderStoreDetail(ctx: BotContext, storeId: string, editMessage = false) {
  if (!ctx.isOwner) return;

  const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
  if (!store) {
    await ctx.reply(`Store <code>${storeId}</code> not found.`, { parse_mode: 'HTML' });
    return;
  }

  const activeKeys = await ctx.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.storeId, store.id), isNull(apiKeys.revokedAt)))
    .all();

  const keyLines =
    activeKeys.length > 0
      ? activeKeys.map((k) => `  - ${k.mode.toUpperCase()}: <code>${k.prefix}...</code>`)
      : ['  - None'];

  const lines = [
    `<b>Store: ${store.name}</b>`,
    `<b>Store ID:</b> <code>${store.id}</code>`,
    `<b>Status:</b> ${store.paused === 1 ? '[Paused]' : '[Active]'}`,
    `<b>Cash on Delivery (COD):</b> ${store.codEnabled === 1 ? 'Enabled' : 'Disabled'}`,
    `<b>Webhook URL:</b> <code>${store.webhookUrl || 'Not configured'}</code>`,
    '<b>Active API Keys:</b>',
    ...keyLines,
  ];

  const keyboard = createStoreDetailKeyboard(store);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the API Keys & Webhook Secret view for a specific store.
 */
export async function renderStoreKeys(ctx: BotContext, storeId: string, editMessage = false) {
  if (!ctx.isOwner) return;

  const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
  if (!store) {
    await ctx.reply(`Store <code>${storeId}</code> not found.`, { parse_mode: 'HTML' });
    return;
  }

  const activeKeys = await ctx.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.storeId, store.id), isNull(apiKeys.revokedAt)))
    .all();

  const lines = [
    `<b>API Credentials: ${store.name}</b>`,
    `Store ID: <code>${store.id}</code>`,
    '',
  ];

  if (activeKeys.length === 0) {
    lines.push('<i>No active API keys. Rotate a key below to generate one.</i>');
  } else {
    for (const k of activeKeys) {
      const modeLabel = k.mode === 'live' ? '[LIVE]' : '[TEST]';
      lines.push(`- ${modeLabel} <code>${k.prefix}...</code>`);
    }
  }

  lines.push(
    '',
    '<i>Note: Full secret keys are only displayed once upon creation or rotation.</i>'
  );

  const keyboard = createStoreKeysKeyboard(store.id);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Wallets Dashboard.
 */
export async function renderWalletsDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.isOwner) return;

  const [walletsWithUsage, strategy, allStores] = await Promise.all([
    getWalletsWithUsage(ctx.db),
    getRotationStrategy(ctx.db),
    ctx.db.select().from(stores).all(),
  ]);

  const storeNameMap = new Map(allStores.map((s) => [s.id, s.name]));
  const rawWallets = walletsWithUsage.map((w) => w.wallet);

  const lines = [
    '<b>Receiving Wallets Dashboard</b>',
    `Daily Rotation Mode: <code>${strategy}</code>`,
    '',
  ];

  if (walletsWithUsage.length === 0) {
    lines.push('<i>No wallets added yet. Tap a button below to add your first receiving wallet.</i>');
  } else {
    for (const item of walletsWithUsage) {
      const w = item.wallet;
      const providerBadge = w.provider === 'bkash' ? 'bKash' : 'Nagad';
      const labelText = w.label ? ` (${w.label})` : '';
      const statusText = w.active === 1 ? '[Active]' : '[Paused]';
      const scopeText = w.storeId ? storeNameMap.get(w.storeId) || w.storeId : 'All Stores';
      const progressBar = renderProgressBar(item.percentageUsed);

      lines.push(
        `<b>${providerBadge}</b>${labelText}: <code>${w.number}</code>`,
        `৳${item.reservedToday.toLocaleString('en-BD')} / ৳${w.dailyLimit.toLocaleString('en-BD')} ${progressBar} ${item.percentageUsed}%`,
        `Scope: ${scopeText} | Status: ${statusText} | Priority: ${w.priority}`,
        ''
      );
    }
  }

  const keyboard = createWalletsDashboardKeyboard(rawWallets, strategy);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders a specific wallet detail view.
 */
export async function renderWalletDetail(ctx: BotContext, walletId: string, editMessage = false) {
  if (!ctx.isOwner) return;

  const wallet = await ctx.db.select().from(wallets).where(eq(wallets.id, walletId)).get();
  if (!wallet) {
    await ctx.reply(`Wallet <code>${walletId}</code> not found.`, { parse_mode: 'HTML' });
    return;
  }

  let scopeLabel = 'All Stores (Shared)';
  if (wallet.storeId) {
    const store = await ctx.db
      .select()
      .from(stores)
      .where(eq(stores.id, wallet.storeId))
      .get();
    scopeLabel = store ? `${store.name} (${store.id})` : wallet.storeId;
  }

  const providerTag = wallet.provider === 'bkash' ? 'bKash' : 'Nagad';
  const text = [
    '<b>Wallet Details</b>',
    `<b>Provider:</b> ${providerTag}`,
    `<b>Number:</b> <code>${wallet.number}</code>`,
    `<b>Label:</b> ${wallet.label || 'None'}`,
    `<b>Scope:</b> ${scopeLabel}`,
    `<b>Daily Limit:</b> ৳${wallet.dailyLimit.toLocaleString('en-BD')}`,
    `<b>Status:</b> ${wallet.active === 1 ? '[Active]' : '[Paused]'}`,
    `<b>Priority:</b> ${wallet.priority}`,
  ].join('\n');

  const keyboard = createWalletDetailKeyboard(wallet);

  if (editMessage && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

/**
 * Renders the Payments Dashboard.
 */
export async function renderPaymentsDashboard(ctx: BotContext, editMessage = false) {
  if (!ctx.isOwner) return;

  const [list, allStores] = await Promise.all([
    ctx.db.select().from(payments).orderBy(desc(payments.createdAt)).limit(10).all(),
    ctx.db.select().from(stores).all(),
  ]);

  const storeNameMap = new Map(allStores.map((s) => [s.id, s.name]));
  const lines = ['<b>Recent Transactions</b>', ''];

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;
  const reopenable = list.filter((p) => p.status === 'REJECTED' && p.updatedAt >= sevenDaysAgo);

  if (list.length === 0) {
    lines.push('<i>No payments recorded yet.</i>');
  } else {
    for (const p of list) {
      const storeName = storeNameMap.get(p.storeId) || p.storeId;
      const orderRef = p.externalOrderId ? ` · ${p.externalOrderId}` : '';
      const methodText = p.method || 'unselected';
      const dateStr = new Date(p.createdAt * 1000).toLocaleString('en-US', {
        timeZone: 'Asia/Dhaka',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      lines.push(
        `- <b>[${storeName}]</b> <code>${p.id}</code>${orderRef} - <b>৳${p.amount.toLocaleString('en-BD')}</b> (${methodText})`,
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
 * Handles all menu, store, wallet, keys, and payment action callbacks.
 */
export async function handleMenuCallback(ctx: BotContext, data: string) {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: ACCESS_DENIED_MESSAGE, show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  // Top-level navigation
  if (data === 'menu:main') {
    return renderMainMenu(ctx, true);
  }
  if (data === 'menu:stores') {
    return renderStoresDashboard(ctx, true);
  }
  if (data === 'menu:wallets') {
    return renderWalletsDashboard(ctx, true);
  }
  if (data === 'menu:payments') {
    return renderPaymentsDashboard(ctx, true);
  }
  if (data === 'menu:help') {
    return handleHelpCommand(ctx);
  }

  // Store Actions
  if (data === 'store:create') {
    await ctx.reply(
      '<b>Create New Store</b>\n\nPlease reply to this message with the name for your new store (up to 50 characters):\n\n<b>Example:</b> <code>My Shop</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'My Shop' },
      }
    );
    return;
  }

  if (data.startsWith('store:view:')) {
    const storeId = data.slice('store:view:'.length);
    return renderStoreDetail(ctx, storeId, true);
  }

  if (data.startsWith('store:rename:')) {
    const storeId = data.slice('store:rename:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    await ctx.reply(
      `<b>Rename Store</b>\nStore ID: <code>${store.id}</code>\nCurrent Name: ${store.name}\n\nPlease reply with the new store name (up to 50 characters):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: store.name },
      }
    );
    return;
  }

  if (data.startsWith('store:webhook:')) {
    const storeId = data.slice('store:webhook:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    await ctx.reply(
      `<b>Set Webhook URL</b>\nStore ID: <code>${store.id}</code>\nStore: ${store.name}\n\nPlease reply with your HTTPS webhook endpoint URL:\n\n<b>Example:</b> <code>https://your-site.com/api/smpg-webhook</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'https://...' },
      }
    );
    return;
  }

  if (data.startsWith('store:ping:')) {
    const storeId = data.slice('store:ping:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    if (!store.webhookUrl) {
      await ctx.reply('Please set a webhook URL first before sending a test ping.');
      return;
    }

    try {
      const rawSecret = await decryptAesGcm(store.webhookSecret, ctx.env.ENCRYPTION_KEY);
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        id: 'evt_test_ping',
        type: 'payment.created',
        created: timestamp,
        data: {
          id: 'pay_test_ping',
          store_id: store.id,
          amount: 100,
          status: 'CREATED',
          method: 'bkash',
          test: true,
        },
      });

      const res = await deliverWebhookPayload(
        store.webhookUrl,
        rawSecret,
        'payment.created',
        payload
      );

      if (res.ok) {
        await ctx.reply(`<b>[OK] Test ping succeeded</b> (HTTP ${res.status})`, {
          parse_mode: 'HTML',
        });
      } else {
        const detail = res.status ? `HTTP ${res.status}` : res.error || 'Network error';
        await ctx.reply(`<b>[Failed] Test ping returned:</b> ${detail}`, {
          parse_mode: 'HTML',
        });
      }
    } catch (err: any) {
      await ctx.reply(`<b>[Error] Test ping failed:</b> ${err?.message || 'Unknown error'}`, {
        parse_mode: 'HTML',
      });
    }
    return;
  }

  if (data.startsWith('store:toggle_cod:')) {
    const storeId = data.slice('store:toggle_cod:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    await ctx.db
      .update(stores)
      .set({ codEnabled: store.codEnabled === 1 ? 0 : 1 })
      .where(eq(stores.id, storeId));

    return renderStoreDetail(ctx, storeId, true);
  }

  if (data.startsWith('store:toggle_pause:')) {
    const storeId = data.slice('store:toggle_pause:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    await ctx.db
      .update(stores)
      .set({ paused: store.paused === 1 ? 0 : 1 })
      .where(eq(stores.id, storeId));

    return renderStoreDetail(ctx, storeId, true);
  }

  if (data.startsWith('store:keys:')) {
    const storeId = data.slice('store:keys:'.length);
    return renderStoreKeys(ctx, storeId, true);
  }

  if (data.startsWith('store:delete_confirm:')) {
    const storeId = data.slice('store:delete_confirm:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    await ctx.editMessageText(
      `<b>Confirm Store Deletion</b>\n\nAre you sure you want to permanently delete <b>${store.name}</b> (<code>${store.id}</code>)?\n\nThis will revoke its API keys and remove its payment records. Assigned wallets will become shared.`,
      {
        parse_mode: 'HTML',
        reply_markup: createStoreDeleteConfirmKeyboard(storeId),
      }
    );
    return;
  }

  if (data.startsWith('store:delete:')) {
    const storeId = data.slice('store:delete:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    // Clean FK-dependent rows before deleting store
    const storePayments = await ctx.db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.storeId, storeId))
      .all();
    const paymentIds = storePayments.map((p) => p.id);

    await ctx.db.delete(webhookDeliveries).where(eq(webhookDeliveries.storeId, storeId));
    if (paymentIds.length > 0) {
      await ctx.db.delete(paymentEvents).where(inArray(paymentEvents.paymentId, paymentIds));
      await ctx.db.delete(trxSubmissions).where(inArray(trxSubmissions.paymentId, paymentIds));
      await ctx.db.delete(payments).where(eq(payments.storeId, storeId));
    }
    await ctx.db.delete(stores).where(eq(stores.id, storeId));

    await ctx.reply(`Store <b>${store.name}</b> (<code>${store.id}</code>) has been deleted.`, {
      parse_mode: 'HTML',
    });
    return renderStoresDashboard(ctx);
  }

  // API Keys & Webhook Secret Actions
  if (data.startsWith('keys:rotate:live:') || data.startsWith('keys:rotate:test:')) {
    const isLive = data.startsWith('keys:rotate:live:');
    const targetMode: 'live' | 'test' = isLive ? 'live' : 'test';
    const storeId = data.slice(isLive ? 'keys:rotate:live:'.length : 'keys:rotate:test:'.length);

    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    const now = Math.floor(Date.now() / 1000);
    await ctx.db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.storeId, storeId), eq(apiKeys.mode, targetMode)));

    const newKeyData = generateApiKey(targetMode);
    const keyHash = await sha256(newKeyData.key);

    await ctx.db.insert(apiKeys).values({
      id: generatePrefixedId('key'),
      storeId,
      keyHash,
      prefix: newKeyData.prefix,
      mode: targetMode,
      revokedAt: null,
      createdAt: now,
    });

    await ctx.reply(
      [
        `<b>${targetMode.toUpperCase()} API Key Rotated</b>`,
        `Store: ${store.name} (<code>${store.id}</code>)`,
        '',
        'New API Key (save this now, shown only once):',
        `<code>${newKeyData.key}</code>`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return renderStoreKeys(ctx, storeId);
  }

  if (data.startsWith('keys:whsec:')) {
    const storeId = data.slice('keys:whsec:'.length);
    const store = await ctx.db.select().from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return;

    try {
      const rawSecret = await decryptAesGcm(store.webhookSecret, ctx.env.ENCRYPTION_KEY);
      await ctx.reply(
        [
          `<b>Webhook Secret: ${store.name}</b>`,
          `Store ID: <code>${store.id}</code>`,
          '',
          `<code>${rawSecret}</code>`,
        ].join('\n'),
        { parse_mode: 'HTML' }
      );
    } catch {
      await ctx.reply('Failed to decrypt webhook secret. Check ENCRYPTION_KEY configuration.');
    }
    return;
  }

  // Wallet Actions
  if (data === 'wallet:add:bkash') {
    await ctx.reply(
      '<b>Adding bKash Wallet</b>\n\nPlease reply to this message with your 11-digit bKash number and an optional label.\n\n<b>Example:</b> <code>017XXXXXXXX Primary</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '017XXXXXXXX [label]' },
      }
    );
    return;
  }

  if (data === 'wallet:add:nagad') {
    await ctx.reply(
      '<b>Adding Nagad Wallet</b>\n\nPlease reply to this message with your 11-digit Nagad number and an optional label.\n\n<b>Example:</b> <code>018XXXXXXXX Nagad1</code>',
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '018XXXXXXXX [label]' },
      }
    );
    return;
  }

  if (data === 'wallet:toggle_strategy') {
    const current = await getRotationStrategy(ctx.db);
    const nextStrategy = current === 'balanced' ? 'fill_first' : 'balanced';
    const now = Math.floor(Date.now() / 1000);

    const existing = await ctx.db
      .select()
      .from(botConfig)
      .where(eq(botConfig.id, 'default'))
      .get();

    if (existing) {
      await ctx.db
        .update(botConfig)
        .set({ rotationStrategy: nextStrategy, updatedAt: now })
        .where(eq(botConfig.id, 'default'));
      ctx.botConfig = { ...existing, rotationStrategy: nextStrategy, updatedAt: now };
    } else {
      const inserted = {
        id: 'default',
        ownerTelegramChatId: ctx.ownerChatId,
        rotationStrategy: nextStrategy,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.db.insert(botConfig).values(inserted);
      ctx.botConfig = inserted;
    }

    return renderWalletsDashboard(ctx, true);
  }

  if (data.startsWith('wallet:view:')) {
    const walletId = data.slice('wallet:view:'.length);
    return renderWalletDetail(ctx, walletId, true);
  }

  if (data.startsWith('wallet:toggle_active:')) {
    const walletId = data.slice('wallet:toggle_active:'.length);
    const wallet = await ctx.db.select().from(wallets).where(eq(wallets.id, walletId)).get();
    if (!wallet) return;

    await ctx.db
      .update(wallets)
      .set({ active: wallet.active === 1 ? 0 : 1 })
      .where(eq(wallets.id, walletId));

    return renderWalletsDashboard(ctx, true);
  }

  if (data.startsWith('wallet:scope:')) {
    const walletId = data.slice('wallet:scope:'.length);
    const [wallet, storeList] = await Promise.all([
      ctx.db.select().from(wallets).where(eq(wallets.id, walletId)).get(),
      ctx.db.select().from(stores).orderBy(stores.createdAt).all(),
    ]);
    if (!wallet) return;

    await ctx.editMessageText(
      `<b>Assign Wallet Scope</b>\nWallet: <code>${wallet.number}</code>\n\nChoose whether this wallet is shared across all stores or dedicated to one store:`,
      {
        parse_mode: 'HTML',
        reply_markup: createWalletScopeKeyboard(walletId, storeList, wallet.storeId),
      }
    );
    return;
  }

  if (data.startsWith('wallet:set_scope:')) {
    const rest = data.slice('wallet:set_scope:'.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) return;

    const walletId = rest.slice(0, lastColon);
    const scopeTarget = rest.slice(lastColon + 1);
    const newStoreId = scopeTarget === 'shared' ? null : scopeTarget;

    await ctx.db
      .update(wallets)
      .set({ storeId: newStoreId })
      .where(eq(wallets.id, walletId));

    return renderWalletDetail(ctx, walletId, true);
  }

  if (data.startsWith('wallet:delete:')) {
    const walletId = data.slice('wallet:delete:'.length);
    await ctx.db
      .update(payments)
      .set({ walletId: null })
      .where(eq(payments.walletId, walletId));
    await ctx.db.delete(wallets).where(eq(wallets.id, walletId));
    return renderWalletsDashboard(ctx, true);
  }

  if (data.startsWith('wallet:edit_limit:')) {
    const walletId = data.slice('wallet:edit_limit:'.length);
    const wallet = await ctx.db.select().from(wallets).where(eq(wallets.id, walletId)).get();
    if (!wallet) return;

    await ctx.reply(
      `<b>Edit Daily Limit</b>\nWallet: <code>${wallet.number}</code>\nID: <code>${wallet.id}</code>\n\nPlease reply with the new daily limit amount in whole taka (BDT):\n\n<b>Example:</b> <code>30000</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Amount in BDT (e.g. 25000)' },
      }
    );
    return;
  }

  // 1-Tap Reopen (uses reopenRejectedPayment so payment.reopened webhook is queued)
  if (data.startsWith('pay:reopen:')) {
    const paymentId = data.slice('pay:reopen:'.length);
    const actor = ctx.from?.username ? `telegram:@${ctx.from.username}` : `telegram:${ctx.from?.id}`;

    const res = await reopenRejectedPayment(ctx.db, paymentId, actor);
    if (!res.success) {
      const reasonMsg =
        res.reason === 'too_old'
          ? 'Payment was rejected more than 7 days ago and cannot be reopened.'
          : res.reason === 'invalid_state'
            ? `Payment cannot be reopened (current status: ${res.payment?.status ?? 'UNKNOWN'}).`
            : `Payment ${paymentId} not found.`;
      await ctx.reply(reasonMsg);
      return;
    }

    await ctx.reply(
      `Payment <code>${paymentId}</code> has been reopened to <b>CREATED</b> and a <code>payment.reopened</code> webhook has been queued.`,
      { parse_mode: 'HTML' }
    );
    return renderPaymentsDashboard(ctx, true);
  }
}
