import { and, eq, isNotNull } from 'drizzle-orm';
import type { BotContext } from '../context';
import { payments, stores, wallets } from '../../db/schema';
import { ACCESS_DENIED_MESSAGE } from '../middleware/auth';
import { formatCodCard, formatSubmittedCard } from '../views/cards';
import { createCodActionKeyboard, createPaymentActionKeyboard } from '../views/keyboards';

export async function handleUndoCallback(ctx: BotContext, paymentId: string) {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: ACCESS_DENIED_MESSAGE, show_alert: true });
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
    .where(and(eq(payments.id, paymentId), isNotNull(payments.pendingDecision)))
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

  const store = await ctx.db
    .select()
    .from(stores)
    .where(eq(stores.id, payment.storeId))
    .get();
  const storeName = store?.name || 'Store';

  let restoredText = '';
  let keyboard;

  if (payment.method === 'cod') {
    restoredText = formatCodCard(payment, storeName);
    keyboard = createCodActionKeyboard(payment.id);
  } else {
    let wallet = null;
    if (payment.walletId) {
      const [w] = await ctx.db
        .select()
        .from(wallets)
        .where(eq(wallets.id, payment.walletId))
        .limit(1);
      wallet = w ?? null;
    }
    restoredText = formatSubmittedCard(payment, wallet, storeName);
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
