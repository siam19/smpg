import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BotContext } from '../context';
import { payments, stores, wallets } from '../../db/schema';
import { generatePrefixedId } from '../../services/crypto';
import { applyPaymentDecision } from '../../services/decision';
import { createUndoKeyboard } from '../views/keyboards';
import { renderStoreDetail, renderWalletsDashboard } from '../callbacks/menu';
import { createStoreWithCredentials } from '../commands/stores';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

function parseDecisionIntent(text: string): 'approve' | 'reject' | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+/g, '');

  const approveKeywords = [
    'ok',
    'y',
    'yes',
    'approve',
    'approved',
    'accept',
    'confirm',
    'confirmed',
    'paid',
    'done',
    'fine',
    'thik ase',
    'thik ache',
    'hoise',
    '1',
  ];

  const rejectKeywords = [
    'no',
    'n',
    'reject',
    'rejected',
    'deny',
    'denied',
    'disapprove',
    'cancel',
    'cancelled',
    'fake',
    'fraud',
    'wrong',
    'vul',
    '0',
  ];

  if (approveKeywords.includes(normalized)) {
    return 'approve';
  }
  if (rejectKeywords.includes(normalized)) {
    return 'reject';
  }
  return null;
}

/**
 * Handles incoming text messages from the verified owner:
 * 1. Replies to ForceReply prompts (create/rename store, webhook URL, add wallet, edit wallet limit).
 * 2. Direct reply or quick-text payment approval/rejection.
 */
export async function handleTextReply(ctx: BotContext) {
  if (!ctx.isOwner || !ctx.ownerChatId) return;

  const input = ctx.message?.text?.trim();
  if (!input || input.startsWith('/')) return;

  const replyText = ctx.message?.reply_to_message?.text;

  // 1. Handle ForceReply prompts first so store names etc. are never misclassified as payment decisions
  if (replyText) {
    // A. Create New Store
    if (replyText.includes('Create New Store')) {
      if (input.length > 50) {
        await ctx.reply('Store name must be 50 characters or less. Please reply with a shorter name:', {
          reply_markup: { force_reply: true, input_field_placeholder: 'My Shop' },
        });
        return;
      }

      const bundle = await createStoreWithCredentials(ctx.db, ctx.env, input);
      const credLines = [
        `<b>Store Created: ${bundle.store.name}</b>`,
        `<b>Store ID:</b> <code>${bundle.store.id}</code>`,
        '',
        '<i>Tap any credential below to copy (you can view these anytime under "View Server Credentials"):</i>',
        ...(ctx.coreUrl ? ['', '<b>SMPG_CORE_URL</b>', `<code>${ctx.coreUrl}</code>`] : []),
        '',
        '<b>SMPG_SECRET_KEY (Live)</b>',
        `<code>${bundle.liveKey}</code>`,
        '',
        '<b>SMPG_SECRET_KEY (Test)</b>',
        `<code>${bundle.testKey}</code>`,
        '',
        '<b>SMPG_WEBHOOK_SECRET</b>',
        `<code>${bundle.webhookSecret}</code>`,
      ];
      await ctx.reply(credLines.join('\n'), { parse_mode: 'HTML' });
      return renderStoreDetail(ctx, bundle.store.id);
    }

    // B. Rename Store
    if (replyText.includes('Rename Store')) {
      const match = replyText.match(/Store ID: (str_[a-z0-9_]+)/);
      const storeId = match?.[1];
      if (!storeId) return;

      if (input.length > 50) {
        await ctx.reply('Store name must be 50 characters or less. Please try again:', {
          reply_markup: { force_reply: true, input_field_placeholder: 'My Shop' },
        });
        return;
      }

      await ctx.db.update(stores).set({ name: input }).where(eq(stores.id, storeId));
      await ctx.reply(`Store name updated to <b>${input}</b>.`, { parse_mode: 'HTML' });
      return renderStoreDetail(ctx, storeId);
    }

    // C. Set Webhook URL
    if (replyText.includes('Set Webhook URL')) {
      const match = replyText.match(/Store ID: (str_[a-z0-9_]+)/);
      const storeId = match?.[1];
      if (!storeId) return;

      if (!input.startsWith('https://')) {
        await ctx.reply('Webhook URL must start with https://. Please try again:', {
          reply_markup: { force_reply: true, input_field_placeholder: 'https://...' },
        });
        return;
      }

      await ctx.db.update(stores).set({ webhookUrl: input }).where(eq(stores.id, storeId));
      await ctx.reply(`Webhook URL saved: <code>${input}</code>`, { parse_mode: 'HTML' });
      return renderStoreDetail(ctx, storeId);
    }

    // D. Adding bKash / Nagad Wallet
    if (replyText.includes('Adding bKash Wallet') || replyText.includes('Adding Nagad Wallet')) {
      const provider: 'bkash' | 'nagad' = replyText.includes('Adding bKash Wallet')
        ? 'bkash'
        : 'nagad';
      const providerName = provider === 'bkash' ? 'bKash' : 'Nagad';
      const placeholder = provider === 'bkash' ? '017XXXXXXXX [label]' : '018XXXXXXXX [label]';

      const parts = input.split(/\s+/);
      const number = parts[0];
      const label = parts.slice(1).join(' ') || undefined;

      if (!BD_PHONE_REGEX.test(number)) {
        await ctx.reply(
          'Invalid phone number. Please enter a valid 11-digit Bangladeshi number starting with 013-019.',
          {
            reply_markup: { force_reply: true, input_field_placeholder: placeholder },
          }
        );
        return;
      }

      const [existing] = await ctx.db
        .select()
        .from(wallets)
        .where(and(eq(wallets.provider, provider), eq(wallets.number, number)))
        .limit(1);

      if (existing) {
        await ctx.reply(`Wallet <code>${number}</code> is already registered under ${providerName}.`, {
          parse_mode: 'HTML',
        });
        return renderWalletsDashboard(ctx);
      }

      const now = Math.floor(Date.now() / 1000);
      await ctx.db.insert(wallets).values({
        id: generatePrefixedId('wal'),
        storeId: null,
        provider,
        number,
        label: label ?? null,
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      });

      await ctx.reply(`<b>${providerName} wallet ${number} added</b> (Scope: All Stores).`, {
        parse_mode: 'HTML',
      });
      return renderWalletsDashboard(ctx);
    }

    // E. Edit Daily Limit
    if (replyText.includes('Edit Daily Limit')) {
      const match = replyText.match(/ID: (wal_[a-z0-9_]+)/);
      const walletId = match?.[1];
      const limit = parseInt(input.replace(/[^0-9]/g, ''), 10);

      if (!walletId || isNaN(limit) || limit < 1000) {
        await ctx.reply('Please enter a valid amount (minimum ৳1,000):', {
          reply_markup: { force_reply: true, input_field_placeholder: '25000' },
        });
        return;
      }

      await ctx.db
        .update(wallets)
        .set({ dailyLimit: limit })
        .where(eq(wallets.id, walletId));

      await ctx.reply(`Daily limit updated to ৳${limit.toLocaleString('en-BD')}.`);
      return renderWalletsDashboard(ctx);
    }
  }

  // 2. Check if the owner is approving/rejecting via direct reply or quick text
  const decisionIntent = parseDecisionIntent(input);
  if (!decisionIntent) return;

  let targetPaymentId: string | null = null;
  let originalMessageId: number | null = null;

  // A. Check reply_to_message
  if (ctx.message?.reply_to_message) {
    const repliedMsg = ctx.message.reply_to_message;
    originalMessageId = repliedMsg.message_id;

    // 1. Check inline buttons callback_data
    const inlineKeyboard = (repliedMsg as any).reply_markup?.inline_keyboard;
    if (Array.isArray(inlineKeyboard)) {
      for (const row of inlineKeyboard) {
        for (const btn of row) {
          const m = btn.callback_data?.match(/v1:(approve|reject|confirm|cancel):([^:]+)/);
          if (m) {
            targetPaymentId = m[2];
            break;
          }
        }
        if (targetPaymentId) break;
      }
    }

    // 2. Check text for payment ID pattern (e.g. pay_xxx)
    if (!targetPaymentId && repliedMsg.text) {
      const match = repliedMsg.text.match(/pay_[a-zA-Z0-9_-]+/);
      if (match) {
        targetPaymentId = match[0];
      }
    }

    // 3. Check payments.telegramMessageId
    if (!targetPaymentId) {
      const candidate = await ctx.db
        .select()
        .from(payments)
        .where(eq(payments.telegramMessageId, originalMessageId))
        .limit(1)
        .get();
      if (candidate) {
        targetPaymentId = candidate.id;
      }
    }
  }

  // B. If not a direct reply, find the latest active pending payment
  if (!targetPaymentId) {
    const latestPending = await ctx.db
      .select()
      .from(payments)
      .where(
        and(
          inArray(payments.status, ['SUBMITTED', 'CREATED']),
          isNull(payments.pendingDecision)
        )
      )
      .orderBy(sql`${payments.createdAt} DESC`)
      .limit(1)
      .get();

    if (latestPending) {
      targetPaymentId = latestPending.id;
      originalMessageId = latestPending.telegramMessageId ?? null;
    }
  }

  if (!targetPaymentId) {
    await ctx.reply('No pending payment found awaiting approval or rejection.');
    return;
  }

  const targetPayment = await ctx.db
    .select()
    .from(payments)
    .where(eq(payments.id, targetPaymentId))
    .limit(1)
    .get();

  if (!targetPayment) {
    await ctx.reply(`Payment <code>${targetPaymentId}</code> not found.`, { parse_mode: 'HTML' });
    return;
  }

  let action: 'approve' | 'reject' | 'confirm' | 'cancel';
  if (targetPayment.method === 'cod') {
    action = decisionIntent === 'approve' ? 'confirm' : 'cancel';
  } else {
    action = decisionIntent === 'approve' ? 'approve' : 'reject';
  }

  const actorName = ctx.from?.username ? `@${ctx.from.username}` : `User ${ctx.from?.id}`;
  const actorDb = ctx.from?.username ? `telegram:@${ctx.from.username}` : `telegram:${ctx.from?.id}`;

  const res = await applyPaymentDecision({
    db: ctx.db,
    env: ctx.env,
    telegramChatId: ctx.ownerChatId,
    paymentId: targetPaymentId,
    action,
    actorName,
    actorDb,
    bot: ctx as any,
    originalMessageId,
  });

  if (!res.success) {
    const currentStatus = targetPayment.pendingDecision || targetPayment.status;
    await ctx.reply(
      `Payment <b>${targetPayment.externalOrderId || targetPayment.id}</b> is already processed (status: <code>${currentStatus}</code>).`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const undoWindowSeconds = parseInt(ctx.env.UNDO_WINDOW_SECONDS || '90', 10);
  const undoKeyboard = createUndoKeyboard(targetPaymentId);
  const orderText = targetPayment.externalOrderId ? ` · Order #${targetPayment.externalOrderId}` : '';

  if (action === 'approve' || action === 'confirm') {
    const targetLabel = action === 'confirm' ? 'Confirmed' : 'Paid';
    await ctx.reply(
      `<b>[Approved] Payment Queued</b>\n` +
        `<b>Amount:</b> ৳${targetPayment.amount.toLocaleString('en-BD')}${orderText}\n` +
        `<i>Will be marked as ${targetLabel} in ${undoWindowSeconds} seconds.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: undoKeyboard,
      }
    );
  } else {
    const targetLabel = action === 'cancel' ? 'Cancelled' : 'Rejected';
    await ctx.reply(
      `<b>[Rejected] Payment Queued</b>\n` +
        `<b>Amount:</b> ৳${targetPayment.amount.toLocaleString('en-BD')}${orderText}\n` +
        `<i>Will be marked as ${targetLabel} in ${undoWindowSeconds} seconds.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: undoKeyboard,
      }
    );
  }
}
