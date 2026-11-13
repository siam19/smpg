import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchants, merchantWallets, payments } from '../../db/schema';
import { generatePrefixedId } from '../../services/crypto';
import { applyPaymentDecision } from '../../services/decision';
import { createUndoKeyboard } from '../views/keyboards';
import { renderSettingsDashboard, renderWalletsDashboard } from '../callbacks/menu';
import { handleOnboardingText } from './onboarding';

const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

function parseDecisionIntent(text: string): 'approve' | 'reject' | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+/g, '');

  const approveKeywords = [
    'ok', 'y', 'yes', 'approve', 'approved', 'accept', 'confirm', 'confirmed',
    'paid', 'done', 'fine', 'thik ase', 'thik ache', 'hoise', '1', '👍'
  ];

  const rejectKeywords = [
    'no', 'n', 'reject', 'rejected', 'deny', 'denied', 'disapprove',
    'cancel', 'cancelled', 'fake', 'fraud', 'wrong', 'vul', '0', '👎'
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
 * Handles incoming text messages (both onboarding progression and replies to ForceReply prompts).
 */
export async function handleTextReply(ctx: BotContext) {
  if (!ctx.merchant) return;

  const input = ctx.message?.text?.trim();
  if (!input) return;

  // 1. Check if the user is in the middle of onboarding
  if (ctx.merchant.onboardingStep && ctx.merchant.onboardingStep !== 'completed') {
    const onboardingHandled = await handleOnboardingText(ctx, input);
    if (onboardingHandled) return;
  }

  // 2. Check if the merchant is approving/rejecting via quick text or notification reply
  const decisionIntent = parseDecisionIntent(input);
  if (decisionIntent) {
    let targetPaymentId: string | null = null;
    let originalMessageId: number | null = null;

    // A. Check reply_to_message
    if (ctx.message?.reply_to_message) {
      const repliedMsg = ctx.message.reply_to_message;
      originalMessageId = repliedMsg.message_id;

      // Check inline buttons callback_data
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

      // Check text for payment ID pattern (e.g. ID: pay_xxx or Ref: pay_xxx)
      if (!targetPaymentId && repliedMsg.text) {
        const match = repliedMsg.text.match(/pay_[a-zA-Z0-9_-]+/);
        if (match) {
          targetPaymentId = match[0];
        }
      }

      // Check payments table metadata with telegram_message_id
      if (!targetPaymentId) {
        const candidate = await ctx.db
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.merchantId, ctx.merchant.id),
              like(payments.metadata, `%"telegram_message_id":${originalMessageId}%`)
            )
          )
          .limit(1)
          .get();
        if (candidate) {
          targetPaymentId = candidate.id;
        }
      }
    }

    // B. If not a direct reply, find the merchant's latest active pending payment
    if (!targetPaymentId) {
      const latestPending = await ctx.db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.merchantId, ctx.merchant.id),
            inArray(payments.status, ['SUBMITTED', 'CREATED']),
            isNull(payments.pendingDecision)
          )
        )
        .orderBy(sql`${payments.createdAt} DESC`)
        .limit(1)
        .get();

      if (latestPending) {
        targetPaymentId = latestPending.id;
        if (latestPending.metadata) {
          try {
            const parsed = JSON.parse(latestPending.metadata);
            if (parsed.telegram_message_id) {
              originalMessageId = parsed.telegram_message_id;
            }
          } catch {}
        }
      }
    }

    if (!targetPaymentId) {
      await ctx.reply('⚠️ No pending payment found awaiting approval or rejection.');
      return;
    }

    // Look up target payment
    const targetPayment = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, targetPaymentId), eq(payments.merchantId, ctx.merchant.id)))
      .limit(1)
      .get();

    if (!targetPayment) {
      await ctx.reply(`⚠️ Payment <code>${targetPaymentId}</code> not found.`, { parse_mode: 'HTML' });
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
      merchantId: ctx.merchant.id,
      telegramChatId: ctx.merchant.telegramChatId,
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
        `⚠️ Payment <b>${targetPayment.externalOrderId || targetPayment.id}</b> is already processed (status: <code>${currentStatus}</code>).`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const undoWindowSeconds = parseInt(ctx.env.UNDO_WINDOW_SECONDS || '90', 10);
    const undoKeyboard = createUndoKeyboard(targetPaymentId);
    const orderText = targetPayment.externalOrderId ? ` · Order #${targetPayment.externalOrderId}` : '';

    if (action === 'approve' || action === 'confirm') {
      await ctx.reply(
        `✅ <b>Payment Approved!</b>\n` +
          `<b>Amount:</b> ৳${targetPayment.amount.toLocaleString('en-BD')}${orderText}\n` +
          `<i>Will be marked as Paid in ${undoWindowSeconds} seconds.</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: undoKeyboard,
        }
      );
    } else {
      await ctx.reply(
        `❌ <b>Payment Rejected</b>\n` +
          `<b>Amount:</b> ৳${targetPayment.amount.toLocaleString('en-BD')}${orderText}\n` +
          `<i>Will be marked as Rejected in ${undoWindowSeconds} seconds.</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: undoKeyboard,
        }
      );
    }
    return;
  }

  const replyText = ctx.message?.reply_to_message?.text;
  if (!replyText) {
    return;
  }

  // 1. Adding bKash Wallet
  if (replyText.includes('Adding bKash Wallet')) {
    const parts = input.split(/\s+/);
    const number = parts[0];
    const label = parts.slice(1).join(' ') || undefined;

    if (!BD_PHONE_REGEX.test(number)) {
      await ctx.reply(
        '⚠️ Invalid phone number. Please enter a valid 11-digit Bangladeshi number starting with 013-019.',
        {
          reply_markup: { force_reply: true, input_field_placeholder: '017XXXXXXXX [label]' },
        }
      );
      return;
    }

    // Check duplicate
    const [existing] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(
        and(
          eq(merchantWallets.merchantId, ctx.merchant.id),
          eq(merchantWallets.provider, 'bkash'),
          eq(merchantWallets.number, number)
        )
      )
      .limit(1);

    if (existing) {
      await ctx.reply(`⚠️ Wallet <code>${number}</code> is already registered under bKash.`, {
        parse_mode: 'HTML',
      });
      return renderWalletsDashboard(ctx);
    }

    const now = Math.floor(Date.now() / 1000);
    await ctx.db.insert(merchantWallets).values({
      id: generatePrefixedId('wal'),
      merchantId: ctx.merchant.id,
      provider: 'bkash',
      number,
      label: label ?? null,
      dailyLimit: 25000,
      priority: 100,
      active: 1,
      createdAt: now,
    });

    await ctx.reply(`✅ <b>bKash wallet ${number} added successfully!</b>`, {
      parse_mode: 'HTML',
    });
    return renderWalletsDashboard(ctx);
  }

  // 2. Adding Nagad Wallet
  if (replyText.includes('Adding Nagad Wallet')) {
    const parts = input.split(/\s+/);
    const number = parts[0];
    const label = parts.slice(1).join(' ') || undefined;

    if (!BD_PHONE_REGEX.test(number)) {
      await ctx.reply(
        '⚠️ Invalid phone number. Please enter a valid 11-digit Bangladeshi number starting with 013-019.',
        {
          reply_markup: { force_reply: true, input_field_placeholder: '018XXXXXXXX [label]' },
        }
      );
      return;
    }

    // Check duplicate
    const [existing] = await ctx.db
      .select()
      .from(merchantWallets)
      .where(
        and(
          eq(merchantWallets.merchantId, ctx.merchant.id),
          eq(merchantWallets.provider, 'nagad'),
          eq(merchantWallets.number, number)
        )
      )
      .limit(1);

    if (existing) {
      await ctx.reply(`⚠️ Wallet <code>${number}</code> is already registered under Nagad.`, {
        parse_mode: 'HTML',
      });
      return renderWalletsDashboard(ctx);
    }

    const now = Math.floor(Date.now() / 1000);
    await ctx.db.insert(merchantWallets).values({
      id: generatePrefixedId('wal'),
      merchantId: ctx.merchant.id,
      provider: 'nagad',
      number,
      label: label ?? null,
      dailyLimit: 25000,
      priority: 100,
      active: 1,
      createdAt: now,
    });

    await ctx.reply(`✅ <b>Nagad wallet ${number} added successfully!</b>`, {
      parse_mode: 'HTML',
    });
    return renderWalletsDashboard(ctx);
  }

  // 3. Edit Daily Limit
  if (replyText.includes('Edit Daily Limit')) {
    const match = replyText.match(/ID: (wal_[a-z0-9_]+)/);
    const walletId = match ? match[1] : undefined;
    const limit = parseInt(input.replace(/[^0-9]/g, ''), 10);

    if (!walletId || isNaN(limit) || limit < 1000) {
      await ctx.reply('⚠️ Please enter a valid amount (minimum ৳1,000):', {
        reply_markup: { force_reply: true, input_field_placeholder: '25000' },
      });
      return;
    }

    await ctx.db
      .update(merchantWallets)
      .set({ dailyLimit: limit })
      .where(
        and(
          eq(merchantWallets.id, walletId),
          eq(merchantWallets.merchantId, ctx.merchant.id)
        )
      );

    await ctx.reply(`✅ Daily limit updated to ৳${limit.toLocaleString('en-BD')}.`);
    return renderWalletsDashboard(ctx);
  }

  // 4. Set Store Name
  if (replyText.includes('Set Store Name')) {
    if (input.length > 50) {
      await ctx.reply('⚠️ Store name must be 50 characters or less. Please try again:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'My Brand Store' },
      });
      return;
    }

    await ctx.db
      .update(merchants)
      .set({ storeName: input })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.storeName = input;

    await ctx.reply(`✅ Store name updated to: <b>${input}</b>`, { parse_mode: 'HTML' });
    return renderSettingsDashboard(ctx);
  }

  // 5. Set Brand Color
  if (replyText.includes('Set Brand Color')) {
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input)) {
      await ctx.reply('⚠️ Invalid hex color code. Example format: #E11D48 or #000000:', {
        reply_markup: { force_reply: true, input_field_placeholder: '#E11D48' },
      });
      return;
    }

    await ctx.db
      .update(merchants)
      .set({ brandColor: input })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.brandColor = input;

    await ctx.reply(`✅ Brand color updated to: <code>${input}</code>`, { parse_mode: 'HTML' });
    return renderSettingsDashboard(ctx);
  }

  // 6. Set Webhook URL
  if (replyText.includes('Set Webhook URL')) {
    if (!input.startsWith('https://')) {
      await ctx.reply('⚠️ Webhook URL must use HTTPS. Please try again:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'https://...' },
      });
      return;
    }

    await ctx.db
      .update(merchants)
      .set({ webhookUrl: input })
      .where(eq(merchants.id, ctx.merchant.id));
    ctx.merchant.webhookUrl = input;

    await ctx.reply(`✅ Webhook URL saved to: <code>${input}</code>`, { parse_mode: 'HTML' });
    return renderSettingsDashboard(ctx);
  }
}
