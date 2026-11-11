import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Database } from '../db';
import {
  merchants,
  paymentEvents,
  payments,
  trxSubmissions,
  webhookDeliveries,
  type Payment,
} from '../db/schema';
import { generatePrefixedId } from './crypto';
import { finalizeNotificationCard } from './notification';

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
