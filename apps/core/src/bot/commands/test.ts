import { eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { generatePrefixedId, randomBytesHex } from '../../services/crypto';
import { merchantWallets, paymentEvents, payments, trxSubmissions } from '../../db/schema';
import { sendCodNotification, sendPaymentSubmissionNotification } from '../../services/notification';

/**
 * Handles /test command to simulate customer submissions and approvals without real money.
 * Usage:
 *   /test        - simulates a bKash submission (default)
 *   /test bkash  - simulates a bKash submission
 *   /test nagad  - simulates a Nagad submission
 *   /test cod    - simulates a Cash on Delivery order
 */
export async function handleTestCommand(ctx: BotContext) {
  if (!ctx.merchant) return;

  const rawArgs = ctx.message?.text?.split(/\s+/).slice(1) || [];
  const methodArg = rawArgs[0]?.toLowerCase();

  const method: 'bkash' | 'nagad' | 'cod' =
    methodArg === 'nagad' ? 'nagad' : methodArg === 'cod' ? 'cod' : 'bkash';

  const amount = 500;
  const now = Math.floor(Date.now() / 1000);
  const paymentId = generatePrefixedId('pay');
  const orderId = `TEST-${randomBytesHex(3).toUpperCase()}`;

  // Find active wallet of merchant for card display
  let wallet = null;
  if (method !== 'cod') {
    const wallets = await ctx.db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.merchantId, ctx.merchant.id))
      .all();
    wallet = wallets.find((w) => w.provider === method) || wallets[0] || null;
  }

  const testPayment = {
    id: paymentId,
    merchantId: ctx.merchant.id,
    mode: 'test' as const,
    externalOrderId: orderId,
    method,
    walletId: wallet?.id || null,
    amount,
    status: method === 'cod' ? 'CONFIRMED' : 'SUBMITTED',
    trxId: method === 'cod' ? null : `TRX${randomBytesHex(4).toUpperCase()}`,
    senderNumber: null,
    customerName: 'Test Customer',
    customerPhone: '01700000000',
    successUrl: 'https://example.com/test/thanks',
    cancelUrl: 'https://example.com/test/cart',
    attempts: 1,
    lateSubmission: 0,
    expiresAt: now + 3600,
    createdAt: now,
    updatedAt: now,
  };

  await ctx.db.insert(payments).values(testPayment);

  if (method !== 'cod') {
    await ctx.db.insert(trxSubmissions).values({
      paymentId,
      method,
      trxId: testPayment.trxId!,
      senderNumber: null,
      outcome: 'pending',
      mode: 'test',
      createdAt: now,
    });
  }

  await ctx.db.insert(paymentEvents).values({
    paymentId,
    fromStatus: 'CREATED',
    toStatus: testPayment.status,
    actor: 'test_simulation',
    note: `Simulated ${method.toUpperCase()} payment via /test`,
    createdAt: now,
  });

  await ctx.reply(
    `🧪 <b>Simulation started for ${method.toUpperCase()}!</b>\n` +
      `<b>Payment ID:</b> <code>${paymentId}</code>\n` +
      `<b>Order:</b> <code>${orderId}</code>\n\n` +
      `<i>The notification card below has live buttons and accepts replies like <b>"ok"</b> or <b>"no"</b>!</i>`,
    { parse_mode: 'HTML' }
  );

  if (method === 'cod') {
    const msgId = await sendCodNotification(ctx as any, ctx.merchant, testPayment as any);
    if (msgId) {
      await ctx.db
        .update(payments)
        .set({
          metadata: JSON.stringify({ telegram_message_id: msgId }),
        })
        .where(eq(payments.id, paymentId));
    }
  } else {
    const msgId = await sendPaymentSubmissionNotification(
      ctx as any,
      ctx.merchant,
      testPayment as any,
      wallet
    );
    if (msgId) {
      await ctx.db
        .update(payments)
        .set({
          metadata: JSON.stringify({ telegram_message_id: msgId }),
        })
        .where(eq(payments.id, paymentId));
    }
  }
}
