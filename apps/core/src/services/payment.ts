import { and, eq, lte } from 'drizzle-orm';
import type { Database } from '../db';
import {
  paymentEvents,
  payments,
  trxSubmissions,
  wallets,
  type Payment,
  type Store,
  type Wallet,
} from '../db/schema';
import { assignWalletForPayment } from './wallet';
import {
  getOwnerChatId,
  sendCodNotification,
  sendPaymentSubmissionNotification,
} from './notification';
import { queueWebhookDelivery } from './webhook';
import type { Env, PaymentMethod, PaymentStatus } from '../types';

export interface ServiceError {
  ok: false;
  status: 400 | 403 | 404;
  code: string;
  message: string;
  param?: string;
}

export type ServiceResult<T> = ({ ok: true } & T) | ServiceError;

export interface FormattedPayment {
  id: string;
  store_id: string;
  mode: 'test' | 'live';
  external_order_id: string | null;
  method: PaymentMethod | null;
  wallet_id: string | null;
  assigned_wallet: {
    id: string;
    provider: 'bkash' | 'nagad';
    number: string;
    label: string | null;
  } | null;
  available_methods?: PaymentMethod[];
  amount: number;
  status: PaymentStatus;
  trx_id: string | null;
  sender_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  success_url: string | null;
  cancel_url: string | null;
  metadata: Record<string, unknown> | null;
  pending_decision: string | null;
  attempts: number;
  attempts_remaining: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Formats a Drizzle Payment row into the canonical snake_case API & webhook payload shape.
 */
export function formatPaymentResponse(
  row: Payment,
  wallet?: Wallet | null,
  availableMethods?: PaymentMethod[]
): FormattedPayment {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = null;
    }
  }

  return {
    id: row.id,
    store_id: row.storeId,
    mode: row.mode as 'test' | 'live',
    external_order_id: row.externalOrderId ?? null,
    method: (row.method as PaymentMethod | null) ?? null,
    wallet_id: row.walletId ?? null,
    assigned_wallet: wallet
      ? {
          id: wallet.id,
          provider: wallet.provider as 'bkash' | 'nagad',
          number: wallet.number,
          label: wallet.label ?? null,
        }
      : null,
    available_methods: availableMethods ?? undefined,
    amount: row.amount,
    status: row.status as PaymentStatus,
    trx_id: row.trxId ?? null,
    sender_number: row.senderNumber ?? null,
    customer_name: row.customerName ?? null,
    customer_phone: row.customerPhone ?? null,
    success_url: row.successUrl ?? null,
    cancel_url: row.cancelUrl ?? null,
    metadata,
    pending_decision: row.pendingDecision ?? null,
    attempts: row.attempts,
    attempts_remaining: Math.max(0, 3 - row.attempts),
    expires_at: new Date(row.expiresAt * 1000).toISOString(),
    created_at: new Date(row.createdAt * 1000).toISOString(),
    updated_at: new Date(row.updatedAt * 1000).toISOString(),
  };
}

export interface SelectPaymentMethodParams {
  db: Database;
  env: Env;
  payment: Payment;
  store: Store;
  method: PaymentMethod;
  actor: 'customer' | 'api';
}

/**
 * Centralized method selection for both REST API (/v1/payments/:id/method) and Checkout API (/c/:id/method).
 * Handles COD confirmation (Telegram notification + queuing payment.confirmed webhook) and bKash/Nagad wallet assignment.
 */
export async function selectPaymentMethod(
  params: SelectPaymentMethodParams
): Promise<ServiceResult<{ payment: Payment; wallet: Wallet | null }>> {
  const { db, env, payment, store, method, actor } = params;

  if (payment.status !== 'CREATED') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_state',
      message: `Cannot change method for payment in ${payment.status} status. Method selection is only allowed in CREATED status.`,
    };
  }

  if (!['bkash', 'nagad', 'cod'].includes(method)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: "method must be 'bkash', 'nagad', or 'cod'",
      param: 'method',
    };
  }

  const now = Math.floor(Date.now() / 1000);

  if (method === 'cod') {
    if (store.codEnabled === 0) {
      return {
        ok: false,
        status: 400,
        code: 'method_not_enabled',
        message: 'Cash on Delivery (COD) is disabled for this store',
        param: 'method',
      };
    }

    await db
      .update(payments)
      .set({
        method: 'cod',
        walletId: null,
        status: 'CONFIRMED',
        updatedAt: now,
      })
      .where(eq(payments.id, payment.id));

    await db.insert(paymentEvents).values({
      paymentId: payment.id,
      fromStatus: 'CREATED',
      toStatus: 'CONFIRMED',
      actor,
      note:
        actor === 'customer'
          ? 'Customer confirmed COD order on checkout'
          : 'Payment method set to COD via REST API',
      createdAt: now,
    });

    const updatedPayment: Payment = {
      ...payment,
      method: 'cod',
      walletId: null,
      status: 'CONFIRMED',
      updatedAt: now,
    };

    // Queue payment.confirmed webhook with normalized snake_case payload
    await queueWebhookDelivery(
      db,
      payment.id,
      store.id,
      'payment.confirmed',
      formatPaymentResponse(updatedPayment, null) as unknown as Record<string, unknown>
    );

    // Dispatch COD notification card to owner's Telegram chat
    if (env.TELEGRAM_BOT_TOKEN) {
      try {
        const ownerChatId = await getOwnerChatId(db, env);
        if (ownerChatId) {
          const { createBot } = await import('../bot');
          const bot = createBot(env, db);
          const messageId = await sendCodNotification(bot, ownerChatId, store.name, updatedPayment);
          if (messageId) {
            await db
              .update(payments)
              .set({ telegramMessageId: messageId })
              .where(eq(payments.id, payment.id));
            updatedPayment.telegramMessageId = messageId;
          }
        }
      } catch (err) {
        console.error('[Payment] Telegram COD notification dispatch failed:', err);
      }
    }

    return { ok: true, payment: updatedPayment, wallet: null };
  }

  // bKash or Nagad: allocate active wallet eligible for this store
  const wallet = await assignWalletForPayment(db, store.id, method, payment.amount);

  if (!wallet) {
    return {
      ok: false,
      status: 400,
      code: 'no_wallet_available',
      message: `No active ${method} wallet has sufficient daily limit capacity for BDT ${payment.amount}`,
    };
  }

  await db
    .update(payments)
    .set({
      method,
      walletId: wallet.id,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id));

  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: 'CREATED',
    toStatus: 'CREATED',
    actor,
    note: `Payment method set to ${method} (wallet: ${wallet.number})`,
    createdAt: now,
  });

  const updatedPayment: Payment = {
    ...payment,
    method,
    walletId: wallet.id,
    updatedAt: now,
  };

  return { ok: true, payment: updatedPayment, wallet };
}

export interface SubmitPaymentTrxParams {
  db: Database;
  env: Env;
  payment: Payment;
  store: Store;
  trxId: unknown;
  senderNumber?: unknown;
  actor: 'customer' | 'api';
}

/**
 * Centralized TrxID/TxnID submission for both REST API (/v1/payments/:id/submit) and Checkout API (/c/:id/submit).
 */
export async function submitPaymentTrx(
  params: SubmitPaymentTrxParams
): Promise<ServiceResult<{ payment: Payment; wallet: Wallet | null; isLate: boolean }>> {
  const { db, env, payment, store, actor } = params;

  if (payment.status === 'PAID') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_state',
      message: 'This payment has already been approved and verified',
    };
  }

  if (payment.status === 'CANCELLED') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_state',
      message: 'This payment session has been cancelled',
    };
  }

  if (payment.status === 'SUBMITTED') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_state',
      message: 'Payment details have already been submitted and are pending verification',
    };
  }

  if (payment.status !== 'CREATED' && payment.status !== 'REJECTED' && payment.status !== 'EXPIRED') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_state',
      message: `Cannot submit payment details in ${payment.status} status`,
    };
  }

  if (payment.attempts >= 3) {
    return {
      ok: false,
      status: 400,
      code: 'too_many_attempts',
      message: 'Maximum submission attempts (3) exceeded for this payment session',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const lateSubmitHours = parseInt(env.LATE_SUBMIT_HOURS || '24', 10);
  let isLate = 0;

  if (now > payment.expiresAt) {
    if (now > payment.expiresAt + lateSubmitHours * 3600) {
      return {
        ok: false,
        status: 400,
        code: 'payment_expired',
        message: 'This payment session has expired and is outside the 24-hour late submission window',
      };
    }
    isLate = 1;
  }

  if (!payment.method || (payment.method !== 'bkash' && payment.method !== 'nagad')) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_state',
      message: 'Please select a valid mobile payment method (bKash or Nagad) before submitting',
    };
  }

  // Validate optional sender number (11-digit Bangladeshi mobile number)
  let senderNumber: string | null = null;
  if (
    params.senderNumber !== undefined &&
    params.senderNumber !== null &&
    String(params.senderNumber).trim() !== ''
  ) {
    const rawNumber = String(params.senderNumber).trim();
    if (!/^01[3-9]\d{8}$/.test(rawNumber)) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_request',
        message: 'Sender number must be a valid 11-digit Bangladeshi mobile number (013-019)',
        param: 'sender_number',
      };
    }
    senderNumber = rawNumber;
  }

  // Normalize and validate TrxID / TxnID
  const trxLabel = payment.method === 'bkash' ? 'TrxID' : 'TxnID';
  const trxId = params.trxId ? String(params.trxId).replace(/\s+/g, '').toUpperCase() : '';
  if (!trxId || !/^[A-Z0-9]{6,30}$/.test(trxId)) {
    return {
      ok: false,
      status: 400,
      code: 'trx_id_invalid_format',
      message: `Invalid ${trxLabel} format. Must be 6-30 alphanumeric characters.`,
      param: 'trx_id',
    };
  }

  // TrxID burning check in live mode
  if (payment.mode === 'live') {
    const existingSubmission = await db
      .select()
      .from(trxSubmissions)
      .where(
        and(
          eq(trxSubmissions.method, payment.method),
          eq(trxSubmissions.trxId, trxId),
          eq(trxSubmissions.mode, 'live')
        )
      )
      .get();

    if (existingSubmission) {
      return {
        ok: false,
        status: 400,
        code: 'trx_id_already_used',
        message: `This ${trxLabel} has already been submitted for another payment and cannot be reused`,
        param: 'trx_id',
      };
    }
  }

  // 1. Burn TrxID in trx_submissions table
  await db.insert(trxSubmissions).values({
    paymentId: payment.id,
    method: payment.method,
    trxId,
    senderNumber,
    outcome: 'pending',
    mode: payment.mode,
    createdAt: now,
  });

  // 2. Atomically transition payment to SUBMITTED
  const newAttempts = payment.attempts + 1;
  await db
    .update(payments)
    .set({
      status: 'SUBMITTED',
      trxId,
      senderNumber,
      attempts: newAttempts,
      lateSubmission: isLate,
      pendingDecision: null,
      decisionEffectiveAt: null,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id));

  // 3. Record audit trail entry
  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: payment.status,
    toStatus: 'SUBMITTED',
    actor,
    note: isLate ? `Submitted ${trxLabel} (late submission)` : `Submitted ${trxLabel}`,
    createdAt: now,
  });

  const updatedPayment: Payment = {
    ...payment,
    status: 'SUBMITTED',
    trxId,
    senderNumber,
    attempts: newAttempts,
    lateSubmission: isLate,
    pendingDecision: null,
    decisionEffectiveAt: null,
    updatedAt: now,
  };

  // 4. Look up assigned wallet & dispatch Telegram notification card
  const wallet = payment.walletId
    ? (await db.select().from(wallets).where(eq(wallets.id, payment.walletId)).get()) ?? null
    : null;

  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const ownerChatId = await getOwnerChatId(db, env);
      if (ownerChatId) {
        const { createBot } = await import('../bot');
        const bot = createBot(env, db);
        const messageId = await sendPaymentSubmissionNotification(
          bot,
          ownerChatId,
          store.name,
          updatedPayment,
          wallet
        );
        if (messageId) {
          await db
            .update(payments)
            .set({ telegramMessageId: messageId })
            .where(eq(payments.id, payment.id));
          updatedPayment.telegramMessageId = messageId;
        }
      }
    } catch (err) {
      console.error('[Payment] Telegram submission notification dispatch failed:', err);
    }
  }

  return { ok: true, payment: updatedPayment, wallet, isLate: isLate === 1 };
}

/**
 * Transitions stale CREATED payments past their expires_at timestamp to EXPIRED,
 * releasing their reserved daily wallet capacity and queuing payment.expired webhooks.
 */
export async function expireStalePayments(db: Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const stale = await db
    .select()
    .from(payments)
    .where(and(eq(payments.status, 'CREATED'), lte(payments.expiresAt, now)));

  if (stale.length === 0) {
    return 0;
  }

  let expiredCount = 0;

  for (const payment of stale) {
    await db
      .update(payments)
      .set({
        status: 'EXPIRED',
        updatedAt: now,
      })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'CREATED')));

    await db.insert(paymentEvents).values({
      paymentId: payment.id,
      fromStatus: 'CREATED',
      toStatus: 'EXPIRED',
      actor: 'system',
      note: 'Payment session expired automatically',
      createdAt: now,
    });

    const expiredPayment: Payment = {
      ...payment,
      status: 'EXPIRED',
      updatedAt: now,
    };

    await queueWebhookDelivery(
      db,
      payment.id,
      payment.storeId,
      'payment.expired',
      formatPaymentResponse(expiredPayment) as unknown as Record<string, unknown>
    );

    expiredCount++;
  }

  return expiredCount;
}
