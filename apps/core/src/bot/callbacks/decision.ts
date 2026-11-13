import type { BotContext } from '../context';
import { applyPaymentDecision } from '../../services/decision';

export async function handleDecisionCallback(
  ctx: BotContext,
  action: 'approve' | 'reject' | 'confirm' | 'cancel',
  paymentId: string
) {
  if (!ctx.merchant) {
    await ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    return;
  }

  const actorName = ctx.from?.username ? `@${ctx.from.username}` : `User ${ctx.from?.id}`;
  const actorDb = ctx.from?.username ? `telegram:@${ctx.from.username}` : `telegram:${ctx.from?.id}`;
  const originalMessageId = ctx.callbackQuery?.message?.message_id;

  const result = await applyPaymentDecision({
    db: ctx.db,
    env: ctx.env,
    merchantId: ctx.merchant.id,
    telegramChatId: ctx.merchant.telegramChatId,
    paymentId,
    action,
    actorName,
    actorDb,
    bot: ctx as any,
    originalMessageId,
  });

  if (!result.success) {
    await ctx.answerCallbackQuery({
      text: 'Decision already recorded or payment status changed.',
      show_alert: true,
    });
    return;
  }

  const undoWindowSeconds = parseInt(ctx.env.UNDO_WINDOW_SECONDS || '90', 10);
  await ctx.answerCallbackQuery({
    text: `Marked for ${action}. You have ${undoWindowSeconds}s to undo.`,
  });
}
