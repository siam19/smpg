import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Database } from '../db';
import type { Env } from '../types';
import {
  merchants,
  merchantWallets,
  paymentEvents,
  payments,
  trxSubmissions,
  webhookDeliveries,
  type Payment,
} from '../db/schema';
import { generatePrefixedId } from './crypto';
import { finalizeNotificationCard } from './notification';
import { appendGracePeriodStatus, formatCodCard, formatSubmittedCard } from '../bot/views/cards';
import { createUndoKeyboard } from '../bot/views/keyboards';

/**
 * Finalizes any payment whose 90-second Undo window has passed.
 * Can be called from the 1-minute cron backstop or lazily during GET /v1/payments/:id.
 */
export async function finalizeDueDecisions(
  db: Database,
  bot?: Bot<any>
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

    // 2. Update payment status atomically
    await db
      .update(payments)
      .set({
        status: targetStatus,
        verificationMethod: payment.verificationMethod || (decision === 'approve' ? 'telegram' : null),
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
      note: `Finalized after 90s undo window`,
      createdAt: now,
    });

    // 5. Queue outbound webhook delivery
    if (eventType) {
      const payloadObj = {
        id: generatePrefixedId('evt'),
        type: eventType,
        created: now,
        data: {
          ...payment,
          status: targetStatus,
          retry_url: targetStatus === 'REJECTED' ? `${payment.successUrl}?retry=true` : undefined,
        },
      };

      await db.insert(webhookDeliveries).values({
        id: generatePrefixedId('dlv'),
        paymentId: payment.id,
        eventType,
        payload: JSON.stringify(payloadObj),
        attempt: 0,
        nextAttemptAt: now,
      });
    }

    finalizedCount++;
  }

  return finalizedCount;
}

export interface ApplyDecisionParams {
  db: Database;
  env: Env;
  merchantId: string;
  telegramChatId: number;
  paymentId: string;
  action: 'approve' | 'reject' | 'confirm' | 'cancel';
  actorName: string;
  actorDb: string;
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
    merchantId,
    telegramChatId,
    paymentId,
    action,
    actorName,
    actorDb,
    bot,
    originalMessageId,
  } = params;

  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchantId)))
    .limit(1);

  if (!payment) {
    return { success: false, reason: 'not_found' };
  }

  const allowedStatuses =
    action === 'confirm' || action === 'cancel' ? ['CREATED'] : ['SUBMITTED'];

  if (!allowedStatuses.includes(payment.status) || payment.pendingDecision !== null) {
    return { success: false, reason: 'already_decided', payment };
  }

  const now = Math.floor(Date.now() / 1000);
  const undoWindowSeconds = parseInt(env.UNDO_WINDOW_SECONDS || '90', 10);
  const effectiveAt = now + undoWindowSeconds;

  const updatedPayments = await db
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
        eq(payments.merchantId, merchantId),
        inArray(payments.status, allowedStatuses),
        isNull(payments.pendingDecision)
      )
    )
    .returning();

  if (updatedPayments.length === 0) {
    return { success: false, reason: 'already_decided', payment };
  }

  const updatedPayment = updatedPayments[0];

  // If a Telegram notification card message ID is known, edit the original card
  if (bot && originalMessageId) {
    try {
      let baseCard = '';
      if (updatedPayment.method === 'cod') {
        baseCard = formatCodCard(updatedPayment);
      } else {
        let wallet = null;
        if (updatedPayment.walletId) {
          const [w] = await db
            .select()
            .from(merchantWallets)
            .where(eq(merchantWallets.id, updatedPayment.walletId))
            .limit(1);
          wallet = w ?? null;
        }
        baseCard = formatSubmittedCard(updatedPayment, wallet);
      }

      const timeString = new Date(effectiveAt * 1000).toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: 'Asia/Dhaka',
      });
      const newCardText = appendGracePeriodStatus(baseCard, action, actorName, timeString);
      const keyboard = createUndoKeyboard(paymentId);

      await bot.api.editMessageText(telegramChatId, originalMessageId, newCardText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error(`[Decision] Failed to edit original notification card ${originalMessageId}:`, err);
    }
  }

  return {
    success: true,
    payment: updatedPayment,
    effectiveAt,
  };
}
