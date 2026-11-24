import { eq } from 'drizzle-orm';
import type { BotContext } from '../context';
import { generatePrefixedId, randomBytesHex } from '../../services/crypto';
import { paymentEvents, payments, stores, trxSubmissions, type Wallet } from '../../db/schema';
import { getWalletsWithUsage } from '../../services/wallet';
import { sendCodNotification, sendPaymentSubmissionNotification } from '../../services/notification';

/**
 * Handles /test command to simulate customer submissions and approvals without real money.
 * Usage:
 *   /test [bkash|nagad|cod] [store_id]
 */
export async function handleTestCommand(ctx: BotContext) {
  if (!ctx.isOwner || !ctx.ownerChatId) return;

  const rawArgs = ctx.message?.text?.split(/\s+/).slice(1) || [];
  const methodArg = rawArgs[0]?.toLowerCase();
  const storeArg = rawArgs[1]?.trim();

  const method: 'bkash' | 'nagad' | 'cod' =
    methodArg === 'nagad' ? 'nagad' : methodArg === 'cod' ? 'cod' : 'bkash';

  const allStores = await ctx.db.select().from(stores).all();
  if (allStores.length === 0) {
    await ctx.reply('No stores found. Create a store first via /stores.');
    return;
  }

  let targetStore = storeArg
    ? allStores.find((s) => s.id === storeArg)
    : allStores.find((s) => s.paused === 0) || allStores[0];

  if (!targetStore) {
    await ctx.reply(`Store <code>${storeArg}</code> not found. Check /stores for valid Store IDs.`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const amount = 500;
  const now = Math.floor(Date.now() / 1000);
  const paymentId = generatePrefixedId('pay');
  const orderId = `TEST-${randomBytesHex(3).toUpperCase()}`;

  let wallet: Wallet | null = null;
  if (method !== 'cod') {
    const eligibleWallets = await getWalletsWithUsage(ctx.db, {
      storeId: targetStore.id,
      provider: method,
    });
    wallet =
      eligibleWallets.find((w) => w.wallet.active === 1)?.wallet ??
      eligibleWallets[0]?.wallet ??
      null;
  }

  const testPayment = {
    id: paymentId,
    storeId: targetStore.id,
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
    successUrl: null,
    cancelUrl: null,
    telegramMessageId: null,
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
    `<b>Simulation started for ${method.toUpperCase()}</b>\n` +
      `<b>Store:</b> ${targetStore.name} (<code>${targetStore.id}</code>)\n` +
      `<b>Payment ID:</b> <code>${paymentId}</code>\n` +
      `<b>Order:</b> <code>${orderId}</code>\n\n` +
      `<i>The notification card below has live buttons and accepts replies like <b>"ok"</b> or <b>"no"</b>.</i>`,
    { parse_mode: 'HTML' }
  );

  let msgId: number | null = null;
  if (method === 'cod') {
    msgId = await sendCodNotification(
      ctx as any,
      ctx.ownerChatId,
      targetStore.name,
      testPayment as any
    );
  } else {
    msgId = await sendPaymentSubmissionNotification(
      ctx as any,
      ctx.ownerChatId,
      targetStore.name,
      testPayment as any,
      wallet
    );
  }

  if (msgId) {
    await ctx.db
      .update(payments)
      .set({ telegramMessageId: msgId })
      .where(eq(payments.id, paymentId));
  }
}
