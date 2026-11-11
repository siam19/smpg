import { and, eq, isNotNull } from 'drizzle-orm';
import type { BotContext } from '../context';
import { merchantWallets, payments } from '../../db/schema';
import { formatCodCard, formatSubmittedCard } from '../views/cards';
import { createCodActionKeyboard, createPaymentActionKeyboard } from '../views/keyboards';

export async function handleUndoCallback(ctx: BotContext, paymentId: string) {
  if (!ctx.merchant) {
    await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Atomic reset: only reset if pendingDecision is still set
  const result = await ctx.db
    .update(payments)
    .set({
      pendingDecision: null,
      decisionActor: null,
      decisionEffectiveAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(payments.id, paymentId),
        eq(payments.merchantId, ctx.merchant.id),
        isNotNull(payments.pendingDecision)
      )
    )
    .returning();

  if (result.length === 0) {
    await ctx.answerCallbackQuery({
      text: 'Grace period expired. Decision has already been finalized.',
      show_alert: true,
    });
    return;
  }

  const payment = result[0];

  await ctx.answerCallbackQuery({
    text: 'Decision cancelled. Reverted to previous state.',
  });

  // Restore original card with initial buttons
  let restoredText = '';
  let keyboard;

  if (payment.method === 'cod') {
    restoredText = formatCodCard(payment);
    keyboard = createCodActionKeyboard(payment.id);
  } else {
    let wallet = null;
    if (payment.walletId) {
      const [w] = await ctx.db
        .select()
        .from(merchantWallets)
        .where(eq(merchantWallets.id, payment.walletId))
        .limit(1);
      wallet = w ?? null;
    }
    restoredText = formatSubmittedCard(payment, wallet);
    keyboard = createPaymentActionKeyboard(payment.id);
  }

  try {
    await ctx.editMessageText(restoredText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error(`Failed to restore card for payment ${paymentId}:`, err);
  }
}
