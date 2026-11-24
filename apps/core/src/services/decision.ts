import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Database } from '../db';
import type { Env } from '../types';
import {
  paymentEvents,
  payments,
  stores,
  trxSubmissions,
  wallets,
  type Payment,
  type Wallet,
} from '../db/schema';
import { finalizeNotificationCard, getOwnerChatId } from './notification';
import { formatPaymentResponse } from './payment';
import { queueWebhookDelivery } from './webhook';
import { appendGracePeriodStatus, formatCodCard, formatSubmittedCard } from '../bot/views/cards';
import { createUndoKeyboard } from '../bot/views/keyboards';

/**
 * Finalizes any payment whose 90-second Undo window has passed.
 * Can be called from the 1-minute cron backstop or lazily during GET /v1/payments/:id.
 */
export async function finalizeDueDecisions(
  db: Database,
  bot?: Bot<any>,
  env?: Pick<Env, 'OWNER_TELEGRAM_ID'>
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  // 1. Fetch payments ready for finalization
  const duePayments = await db
    .select()
    .from(payments)
    .where(
      and(
        isNotNull(payments.pendingDecision),
        lte(payments.decisionEffectiveAt, now)
      )
    );

  if (duePayments.length === 0) {
    return 0;
  }

  let finalizedCount = 0;

  for (const payment of duePayments) {
    const decision = payment.pendingDecision;
    if (!decision) continue;

    let targetStatus = payment.status;
    let eventType = '';
    let submissionOutcome = '';

    switch (decision) {
      case 'approve':
        targetStatus = 'PAID';
        eventType = 'payment.paid';
        submissionOutcome = 'approved';
        break;
      case 'reject':
        targetStatus = 'REJECTED';
        eventType = 'payment.rejected';
        submissionOutcome = 'rejected';
        break;
      case 'confirm':
        targetStatus = 'CONFIRMED';
        eventType = 'payment.confirmed';
        break;
      case 'cancel':
        targetStatus = 'CANCELLED';
        eventType = 'payment.cancelled';
        break;
    }

    const fromStatus = payment.status;
    const actor = payment.decisionActor || 'system';
    const verificationMethod =
      payment.verificationMethod || (decision === 'approve' ? 'telegram' : null);

    // 2. Update payment status atomically
    await db
      .update(payments)
      .set({
        status: targetStatus,
        verificationMethod,
        pendingDecision: null,
        decisionEffectiveAt: null,
        updatedAt: now,
      })
      .where(eq(payments.id, payment.id));

    // 3. Update trx_submissions outcome if applicable
    if (submissionOutcome && payment.trxId) {
      await db
        .update(trxSubmissions)
        .set({ outcome: submissionOutcome })
        .where(
          and(
            eq(trxSubmissions.paymentId, payment.id),
            eq(trxSubmissions.trxId, payment.trxId)
          )
        );
    }

    // 4. Record audit event
    await db.insert(paymentEvents).values({
      paymentId: payment.id,
      fromStatus,
      toStatus: targetStatus,
      actor,
      note: 'Finalized after 90s undo window',
      createdAt: now,
    });

    const finalizedPayment: Payment = {
      ...payment,
      status: targetStatus,
      verificationMethod,
      pendingDecision: null,
      decisionEffectiveAt: null,
      updatedAt: now,
    };

    const wallet: Wallet | null = payment.walletId
      ? (await db.select().from(wallets).where(eq(wallets.id, payment.walletId)).get()) ?? null
      : null;

    // 5. Queue outbound webhook delivery with normalized snake_case Payment object
    if (eventType) {
      await queueWebhookDelivery(
        db,
        payment.id,
        payment.storeId,
        eventType,
        formatPaymentResponse(finalizedPayment, wallet) as unknown as Record<string, unknown>
      );
    }

    // 6. Finalize Telegram notification card (remove Undo button, freeze static badge)
    if (bot && payment.telegramMessageId) {
      const ownerChatId = await getOwnerChatId(db, env);
      if (ownerChatId) {
        const store = await db
          .select()
          .from(stores)
          .where(eq(stores.id, payment.storeId))
          .get();
        const storeName = store?.name || 'Store';
        const baseCard =
          finalizedPayment.method === 'cod'
            ? (formatCodCard as (p: Payment, s?: string) => string)(finalizedPayment, storeName)
            : (formatSubmittedCard as (p: Payment, w?: Wallet | null, s?: string) => string)(
                finalizedPayment,
                wallet,
                storeName
              );

        await finalizeNotificationCard(
          bot,
          ownerChatId,
          payment.telegramMessageId,
          baseCard,
          targetStatus,
          actor
        );
      }
    }

    finalizedCount++;
  }

  return finalizedCount;
}

export interface ApplyDecisionParams {
  db: Database;
  env: Env;
  telegramChatId: number;
  paymentId: string;
  action: 'approve' | 'reject' | 'confirm' | 'cancel';
  actorName: string;
  actorDb: string;
  storeId?: string;
  bot?: Bot<any>;
  originalMessageId?: number | null;
}

export interface ApplyDecisionResult {
  success: boolean;
  payment?: Payment;
  effectiveAt?: number;
  reason?: 'not_found' | 'already_decided' | 'invalid_state';
}

/**
 * Applies a pending decision (approve/reject/confirm/cancel) to a payment.
 * Starts the 90-second undo window and updates the Telegram card if available.
 */
export async function applyPaymentDecision(
  params: ApplyDecisionParams
): Promise<ApplyDecisionResult> {
  const {
    db,
    env,
    storeId,
    telegramChatId,
    paymentId,
    action,
    actorName,
    actorDb,
    bot,
    originalMessageId,
  } = params;

  const lookupConditions = [eq(payments.id, paymentId)];
  if (storeId) {
    lookupConditions.push(eq(payments.storeId, storeId));
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(and(...lookupConditions))
    .limit(1);

  if (!payment) {
    return { success: false, reason: 'not_found' };
  }

  const allowedStatuses =
    action === 'confirm' || action === 'cancel' ? ['CREATED', 'CONFIRMED'] : ['SUBMITTED'];

  if (!allowedStatuses.includes(payment.status) || payment.pendingDecision !== null) {
    return { success: false, reason: 'already_decided', payment };
  }

  const now = Math.floor(Date.now() / 1000);
  const undoWindowSeconds = parseInt(env.UNDO_WINDOW_SECONDS || '90', 10);
  const effectiveAt = now + undoWindowSeconds;

  const updateConditions = [
    eq(payments.id, paymentId),
    inArray(payments.status, allowedStatuses),
    isNull(payments.pendingDecision),
  ];
  if (storeId) {
    updateConditions.push(eq(payments.storeId, storeId));
  }

  const updatedPayments = await db
    .update(payments)
    .set({
      pendingDecision: action,
      decisionActor: actorDb,
      decisionEffectiveAt: effectiveAt,
      updatedAt: now,
    })
    .where(and(...updateConditions))
    .returning();

  if (updatedPayments.length === 0) {
    return { success: false, reason: 'already_decided', payment };
  }

  const updatedPayment = updatedPayments[0];
  const cardMessageId = originalMessageId ?? updatedPayment.telegramMessageId;

  // If a Telegram notification card message ID is known, edit the original card
  if (bot && cardMessageId) {
    try {
      const store = await db
        .select()
        .from(stores)
        .where(eq(stores.id, updatedPayment.storeId))
        .get();
      const storeName = store?.name || 'Store';

      let baseCard = '';
      if (updatedPayment.method === 'cod') {
        baseCard = (formatCodCard as (p: Payment, s?: string) => string)(
          updatedPayment,
          storeName
        );
      } else {
        let wallet: Wallet | null = null;
        if (updatedPayment.walletId) {
          const [w] = await db
            .select()
            .from(wallets)
            .where(eq(wallets.id, updatedPayment.walletId))
            .limit(1);
          wallet = w ?? null;
        }
        baseCard = (formatSubmittedCard as (p: Payment, w?: Wallet | null, s?: string) => string)(
          updatedPayment,
          wallet,
          storeName
        );
      }

      const timeString = new Date(effectiveAt * 1000).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'Asia/Dhaka',
      });
      const newCardText = appendGracePeriodStatus(baseCard, action, actorName, timeString);
      const keyboard = createUndoKeyboard(paymentId);

      await bot.api.editMessageText(telegramChatId, cardMessageId, newCardText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error(`[Decision] Failed to edit original notification card ${cardMessageId}:`, err);
    }
  }

  return {
    success: true,
    payment: updatedPayment,
    effectiveAt,
  };
}

/**
 * Reopens a REJECTED payment (within 7 days) back to CREATED so the customer can retry,
 * and queues a `payment.reopened` webhook with the normalized snake_case Payment payload.
 */
export async function reopenRejectedPayment(
  db: Database,
  paymentId: string,
  actor: string
): Promise<{ success: boolean; payment?: Payment; reason?: 'not_found' | 'invalid_state' | 'too_old' }> {
  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .get();

  if (!payment) {
    return { success: false, reason: 'not_found' };
  }

  if (payment.status !== 'REJECTED') {
    return { success: false, reason: 'invalid_state', payment };
  }

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysSeconds = 7 * 24 * 3600;
  if (now - payment.updatedAt > sevenDaysSeconds) {
    return { success: false, reason: 'too_old', payment };
  }

  const newExpiresAt = now + 24 * 3600;

  await db
    .update(payments)
    .set({
      status: 'CREATED',
      attempts: 0,
      pendingDecision: null,
      decisionEffectiveAt: null,
      expiresAt: newExpiresAt,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id));

  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: 'REJECTED',
    toStatus: 'CREATED',
    actor,
    note: 'Payment reopened for customer retry',
    createdAt: now,
  });

  const reopenedPayment: Payment = {
    ...payment,
    status: 'CREATED',
    attempts: 0,
    pendingDecision: null,
    decisionEffectiveAt: null,
    expiresAt: newExpiresAt,
    updatedAt: now,
  };

  const wallet: Wallet | null = payment.walletId
    ? (await db.select().from(wallets).where(eq(wallets.id, payment.walletId)).get()) ?? null
    : null;

  await queueWebhookDelivery(
    db,
    payment.id,
    payment.storeId,
    'payment.reopened',
    formatPaymentResponse(reopenedPayment, wallet) as unknown as Record<string, unknown>
  );

  return { success: true, payment: reopenedPayment };
}
