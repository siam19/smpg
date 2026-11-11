import { and, desc, eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { paymentEvents, payments, trxSubmissions } from '../../db/schema';
import { renderPaymentsDashboard } from '../callbacks/menu';

export async function handlePaymentsListCommand(ctx: BotContext) {
  return renderPaymentsDashboard(ctx);
}

export async function handleReopenCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const paymentId = parts[1]?.trim();

  if (!paymentId) {
    await ctx.reply(
      '⚠️ Usage: <code>/reopen &lt;payment_id&gt;</code>\nExample: <code>/reopen pay_8f2k</code>\n\nOr simply tap the 🔄 Reopen button under /payments.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Find payment
  const [payment] = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, ctx.merchant.id)))
    .limit(1);

  if (!payment) {
    await ctx.reply(`⚠️ Payment <code>${paymentId}</code> not found.`, { parse_mode: 'HTML' });
    return;
  }

  if (payment.status !== 'REJECTED') {
    await ctx.reply(
      `⚠️ Only rejected payments can be reopened. Current status: <b>${payment.status}</b>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;

  if (payment.updatedAt < sevenDaysAgo) {
    await ctx.reply('⚠️ This payment was rejected more than 7 days ago and can no longer be reopened.', {
      parse_mode: 'HTML',
    });
    return;
  }

  // Precondition: Customer hasn't submitted a newer TrxID
  const latestSubmissions = await ctx.db
    .select()
    .from(trxSubmissions)
    .where(eq(trxSubmissions.paymentId, paymentId))
    .orderBy(desc(trxSubmissions.createdAt))
    .limit(1);

  if (latestSubmissions.length > 0 && latestSubmissions[0].outcome === 'pending') {
    await ctx.reply(
      '⚠️ A new TrxID has already been submitted by the customer for this payment. Please review that instead.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Atomic update back to SUBMITTED
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

  // Write audit trail
  await ctx.db.insert(paymentEvents).values({
    paymentId,
    fromStatus: 'REJECTED',
    toStatus: 'SUBMITTED',
    actor,
    note: 'Reopened by merchant in Telegram',
    createdAt: now,
  });

  await ctx.reply(
    `✅ Payment <code>${paymentId}</code> has been reopened and set to <b>SUBMITTED</b>.`,
    { parse_mode: 'HTML' }
  );
  return renderPaymentsDashboard(ctx);
}
