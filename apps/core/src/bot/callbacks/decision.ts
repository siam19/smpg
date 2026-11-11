import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchantWallets, payments } from '../../db/schema';
import { appendGracePeriodStatus, formatCodCard, formatSubmittedCard } from '../views/cards';
import { createUndoKeyboard } from '../views/keyboards';

export async function handleDecisionCallback(
  ctx: BotContext,
  action: 'approve' | 'reject' | 'confirm' | 'cancel',
  paymentId: string
) {
  if (!ctx.merchant) {
    await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const undoWindowSeconds = parseInt(ctx.env.UNDO_WINDOW_SECONDS || '90', 10);
  const effectiveAt = now + undoWindowSeconds;

  const actor = ctx.from?.username ? `@${ctx.from.username}` : `User ${ctx.from?.id}`;
  const actorDb = ctx.from?.username ? `telegram:@${ctx.from.username}` : `telegram:${ctx.from?.id}`;

  // Allowed initial statuses
  const allowedStatuses = action === 'confirm' || action === 'cancel'
    ? ['CREATED']
    : ['SUBMITTED'];

  // Atomic update: only update if pendingDecision is currently null
  const result = await ctx.db
    .update(payments)
    .set({
      pendingDecision: action,
      decisionActor: actorDb,
      decisionEffectiveAt: effectiveAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(payments.id, paymentId),
        eq(payments.merchantId, ctx.merchant.id),
        inArray(payments.status, allowedStatuses),
        isNull(payments.pendingDecision)
      )
    )
    .returning();

  if (result.length === 0) {
    await ctx.answerCallbackQuery({
      text: 'Decision already recorded or payment status changed.',
      show_alert: true,
    });
    return;
  }

  const updatedPayment = result[0];

  // Acknowledge callback immediately
  await ctx.answerCallbackQuery({
    text: `Marked for ${action}. You have ${undoWindowSeconds}s to undo.`,
  });

  // Re-render message card with grace period status and Undo button
  const originalMessageText = ctx.callbackQuery?.message?.text || '';
  const timeString = new Date(effectiveAt * 1000).toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'Asia/Dhaka',
  });

  // Base card text
  let baseCard = '';
  if (updatedPayment.method === 'cod') {
    baseCard = formatCodCard(updatedPayment);
  } else {
    // Fetch wallet for display
    let wallet = null;
    if (updatedPayment.walletId) {
      const [w] = await ctx.db
        .select()
        .from(merchantWallets)
        .where(eq(merchantWallets.id, updatedPayment.walletId))
        .limit(1);
      wallet = w ?? null;
    }
    baseCard = formatSubmittedCard(updatedPayment, wallet);
  }

  const newCardText = appendGracePeriodStatus(baseCard, action, actor, timeString);
  const keyboard = createUndoKeyboard(paymentId);

  try {
    await ctx.editMessageText(newCardText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(`Failed to update message for payment ${paymentId}:`, err);
  }
}
