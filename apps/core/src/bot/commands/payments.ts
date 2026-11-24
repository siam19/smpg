import type { BotContext } from '../context';
import { reopenRejectedPayment } from '../../services/decision';
import { renderPaymentsDashboard } from '../callbacks/menu';

export async function handlePaymentsListCommand(ctx: BotContext) {
  return renderPaymentsDashboard(ctx);
}

export async function handleReopenCommand(ctx: BotContext) {
  if (!ctx.isOwner) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const paymentId = parts[1]?.trim();

  if (!paymentId) {
    await ctx.reply(
      'Usage: <code>/reopen &lt;payment_id&gt;</code>\nExample: <code>/reopen pay_8f2k</code>\n\nOr tap a Reopen button under /payments.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const actor = ctx.from?.username ? `telegram:@${ctx.from.username}` : `telegram:${ctx.from?.id}`;
  const res = await reopenRejectedPayment(ctx.db, paymentId, actor);

  if (!res.success) {
    if (res.reason === 'not_found') {
      await ctx.reply(`Payment <code>${paymentId}</code> not found.`, { parse_mode: 'HTML' });
    } else if (res.reason === 'invalid_state') {
      await ctx.reply(
        `Only rejected payments can be reopened. Current status: <b>${res.payment?.status ?? 'UNKNOWN'}</b>`,
        { parse_mode: 'HTML' }
      );
    } else if (res.reason === 'too_old') {
      await ctx.reply(
        'This payment was rejected more than 7 days ago and can no longer be reopened.',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  await ctx.reply(
    `Payment <code>${paymentId}</code> has been reopened to <b>CREATED</b> and a <code>payment.reopened</code> webhook has been queued.`,
    { parse_mode: 'HTML' }
  );
  return renderPaymentsDashboard(ctx);
}
