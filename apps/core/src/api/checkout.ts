import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db';
import {
  merchants,
  merchantWallets,
  paymentEvents,
  payments,
  trxSubmissions,
  type Payment,
} from '../db/schema';
import { createBot } from '../bot';
import { assignWalletForPayment, getMerchantWalletsWithUsage } from '../services/wallet';
import {
  sendCodNotification,
  sendPaymentSubmissionNotification,
} from '../services/notification';
import type { Env, PaymentMethod } from '../types';

export const checkoutRouter = new Hono<{ Bindings: Env }>();

// GET /c/:id/data (Public checkout session information)
checkoutRouter.get('/:id/data', async (c) => {
  const paymentId = c.req.param('id');
  const db = createDb(c.env.DB);

  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .get();

  if (!payment) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: `Payment not found: ${paymentId}`,
          param: 'id',
        },
      },
      404
    );
  }

  const merchant = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, payment.merchantId))
    .get();

  if (!merchant) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Merchant record not found for this payment session',
        },
      },
      404
    );
  }

  if (merchant.paused === 1) {
    return c.json(
      {
        error: {
          code: 'merchant_paused',
          message: 'This merchant account is currently paused. Please contact seller.',
        },
      },
      403
    );
  }

  // Determine available methods with capacity
  const availableMethods: PaymentMethod[] = [];
  if (merchant.codEnabled === 1) {
    availableMethods.push('cod');
  }

  const bkashWallets = await getMerchantWalletsWithUsage(db, merchant.id, 'bkash');
  if (
    bkashWallets.some(
      (w) => w.wallet.active === 1 && w.reservedToday + payment.amount <= w.wallet.dailyLimit
    )
  ) {
    availableMethods.push('bkash');
  }

  const nagadWallets = await getMerchantWalletsWithUsage(db, merchant.id, 'nagad');
  if (
    nagadWallets.some(
      (w) => w.wallet.active === 1 && w.reservedToday + payment.amount <= w.wallet.dailyLimit
    )
  ) {
    availableMethods.push('nagad');
  }

  // Look up assigned wallet if already assigned
  let assignedWallet: {
    id: string;
    provider: string;
    number: string;
    label: string | null;
  } | null = null;

  if (payment.walletId) {
    const wallet = await db
      .select()
      .from(merchantWallets)
      .where(eq(merchantWallets.id, payment.walletId))
      .get();

    if (wallet) {
      assignedWallet = {
        id: wallet.id,
        provider: wallet.provider,
        number: wallet.number,
        label: wallet.label,
      };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const lateSubmitHours = parseInt(c.env.LATE_SUBMIT_HOURS || '24', 10);
  const isExpired = now > payment.expiresAt;
  const canLateSubmit =
    isExpired &&
    now <= payment.expiresAt + lateSubmitHours * 3600 &&
    payment.attempts < 3;

  return c.json(
    {
      id: payment.id,
      amount: payment.amount,
      currency: 'BDT',
      external_order_id: payment.externalOrderId,
      status: payment.status,
      store: {
        name: merchant.storeName || 'Store',
        brand_color: merchant.brandColor || '#10B981',
        logo_key: merchant.logoKey || null,
      },
      available_methods: availableMethods,
      method: payment.method as PaymentMethod | null,
      assigned_wallet: assignedWallet,
      trx_id: payment.trxId,
      sender_number: payment.senderNumber,
      attempts: payment.attempts,
      attempts_remaining: Math.max(0, 3 - payment.attempts),
      expires_at: new Date(payment.expiresAt * 1000).toISOString(),
      is_expired: isExpired,
      can_late_submit: canLateSubmit,
      success_url: payment.successUrl,
      cancel_url: payment.cancelUrl,
    },
    200
  );
});

// POST /c/:id/method (Customer chooses payment method)
checkoutRouter.post('/:id/method', async (c) => {
  const paymentId = c.req.param('id');
  const db = createDb(c.env.DB);

  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .get();

  if (!payment) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: `Payment not found: ${paymentId}`,
          param: 'id',
        },
      },
      404
    );
  }

  if (payment.status !== 'CREATED') {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: `Cannot change method for payment in ${payment.status} status. Method selection is only allowed in CREATED status.`,
        },
      },
      400
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Malformed JSON payload',
        },
      },
      400
    );
  }

  const method = body.method as PaymentMethod;
  if (!['bkash', 'nagad', 'cod'].includes(method)) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: "method must be 'bkash', 'nagad', or 'cod'",
          param: 'method',
        },
      },
      400
    );
  }

  const merchant = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, payment.merchantId))
    .get();

  if (!merchant) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Merchant record not found',
        },
      },
      404
    );
  }

  const now = Math.floor(Date.now() / 1000);

  if (method === 'cod') {
    if (merchant.codEnabled === 0) {
      return c.json(
        {
          error: {
            code: 'method_not_enabled',
            message: 'Cash on Delivery (COD) is disabled for this merchant',
            param: 'method',
          },
        },
        400
      );
    }

    // Atomically move to CONFIRMED
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
      actor: 'customer',
      note: 'Customer confirmed COD order on checkout',
      createdAt: now,
    });

    // Dispatch COD card to Telegram
    if (c.env.TELEGRAM_BOT_TOKEN) {
      try {
        const bot = createBot(c.env, db);
        const messageId = await sendCodNotification(bot, merchant, {
          ...payment,
          method: 'cod',
          status: 'CONFIRMED',
          updatedAt: now,
        });
        if (messageId) {
          let existingMeta: Record<string, any> = {};
          if (payment.metadata) {
            try {
              existingMeta = JSON.parse(payment.metadata);
            } catch {}
          }
          existingMeta.telegram_message_id = messageId;
          await db
            .update(payments)
            .set({ metadata: JSON.stringify(existingMeta) })
            .where(eq(payments.id, payment.id));
        }
      } catch (err) {
        console.error('[Checkout] Telegram COD notification dispatch failed:', err);
      }
    }

    return c.json(
      {
        id: payment.id,
        method: 'cod',
        status: 'CONFIRMED',
        redirect_url: `${payment.successUrl}${payment.successUrl.includes('?') ? '&' : '?'}payment_id=${payment.id}&status=confirmed`,
      },
      200
    );
  }

  // bKash or Nagad: Allocate active wallet
  const wallet = await assignWalletForPayment(
    db,
    merchant.id,
    method,
    payment.amount,
    merchant.rotationStrategy as 'balanced' | 'fill_first'
  );

  if (!wallet) {
    return c.json(
      {
        error: {
          code: 'no_wallet_available',
          message: `No active ${method} wallet has sufficient daily limit capacity for ৳${payment.amount}`,
        },
      },
      400
    );
  }

  await db
    .update(payments)
    .set({
      method,
      walletId: wallet.id,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id));

  return c.json(
    {
      id: payment.id,
      method,
      status: payment.status,
      assigned_wallet: {
        id: wallet.id,
        provider: wallet.provider,
        number: wallet.number,
        label: wallet.label,
      },
    },
    200
  );
});

// POST /c/:id/submit (Customer submits TrxID and Sender Number)
checkoutRouter.post('/:id/submit', async (c) => {
  const paymentId = c.req.param('id');
  const db = createDb(c.env.DB);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Malformed JSON payload',
        },
      },
      400
    );
  }

  // Anti-bot honeypot check
  if (body.honeypot && String(body.honeypot).trim().length > 0) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Automated submission rejected',
        },
      },
      400
    );
  }

  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .get();

  if (!payment) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: `Payment not found: ${paymentId}`,
          param: 'id',
        },
      },
      404
    );
  }

  // Terminal state checks
  if (payment.status === 'PAID') {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: 'This payment has already been approved and verified',
        },
      },
      400
    );
  }

  if (payment.status === 'CANCELLED') {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: 'This payment session has been cancelled',
        },
      },
      400
    );
  }

  if (payment.status === 'SUBMITTED') {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: 'Payment details have already been submitted and are pending verification',
        },
      },
      400
    );
  }

  if (payment.status !== 'CREATED' && payment.status !== 'REJECTED') {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: `Cannot submit payment details in ${payment.status} status`,
        },
      },
      400
    );
  }

  // Attempt limit check (max 3 submissions)
  if (payment.attempts >= 3) {
    return c.json(
      {
        error: {
          code: 'too_many_attempts',
          message: 'Maximum submission attempts (3) exceeded for this payment session',
        },
      },
      400
    );
  }

  // Expiration check and late submission allowance
  const now = Math.floor(Date.now() / 1000);
  const lateSubmitHours = parseInt(c.env.LATE_SUBMIT_HOURS || '24', 10);
  let isLate = 0;

  if (now > payment.expiresAt) {
    if (now > payment.expiresAt + lateSubmitHours * 3600) {
      return c.json(
        {
          error: {
            code: 'payment_expired',
            message: 'This payment session has expired and is outside the 24-hour late submission window',
          },
        },
        400
      );
    }
    isLate = 1;
  }

  // Payment method must be bKash or Nagad
  if (!payment.method || (payment.method !== 'bkash' && payment.method !== 'nagad')) {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: 'Please select a valid mobile payment method (bKash or Nagad) before submitting',
        },
      },
      400
    );
  }

  // Validate optional sender number if provided (11-digit Bangladeshi mobile number)
  let senderNumber: string | null = null;
  if (
    body.sender_number !== undefined &&
    body.sender_number !== null &&
    String(body.sender_number).trim() !== ''
  ) {
    const rawNumber = String(body.sender_number).trim();
    if (!/^01[3-9]\d{8}$/.test(rawNumber)) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'Sender number must be a valid 11-digit Bangladeshi mobile number (013-019)',
            param: 'sender_number',
          },
        },
        400
      );
    }
    senderNumber = rawNumber;
  }

  // Normalize and validate TrxID / TxnID
  const trxLabel = payment.method === 'bkash' ? 'TrxID' : 'TxnID';
  const trxId = body.trx_id ? String(body.trx_id).replace(/\s+/g, '').toUpperCase() : '';
  if (!trxId || !/^[A-Z0-9]{6,30}$/.test(trxId)) {
    return c.json(
      {
        error: {
          code: 'trx_id_invalid_format',
          message: `Invalid ${trxLabel} format. Must be 6-30 alphanumeric characters.`,
          param: 'trx_id',
        },
      },
      400
    );
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
      return c.json(
        {
          error: {
            code: 'trx_id_already_used',
            message: `This ${trxLabel} has already been submitted for another payment and cannot be reused`,
            param: 'trx_id',
          },
        },
        400
      );
    }
  }

  const merchant = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, payment.merchantId))
    .get();

  if (!merchant) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Merchant record not found',
        },
      },
      404
    );
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
    actor: 'customer',
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

  // 4. Dispatch notification card to Telegram bot
  if (c.env.TELEGRAM_BOT_TOKEN) {
    try {
      const bot = createBot(c.env, db);
      const wallet = payment.walletId
        ? await db.select().from(merchantWallets).where(eq(merchantWallets.id, payment.walletId)).get()
        : null;

      const messageId = await sendPaymentSubmissionNotification(bot, merchant, updatedPayment, wallet);
      if (messageId) {
        let existingMeta: Record<string, any> = {};
        if (payment.metadata) {
          try {
            existingMeta = JSON.parse(payment.metadata);
          } catch {}
        }
        existingMeta.telegram_message_id = messageId;
        await db
          .update(payments)
          .set({ metadata: JSON.stringify(existingMeta) })
          .where(eq(payments.id, payment.id));
      }
    } catch (err) {
      console.error('[Checkout] Telegram notification dispatch failed:', err);
    }
  }

  const redirectUrl = `${payment.successUrl}${
    payment.successUrl.includes('?') ? '&' : '?'
  }payment_id=${payment.id}&status=submitted`;

  return c.json(
    {
      status: 'SUBMITTED',
      message: 'Thank you! We received your payment details. The seller will verify them shortly.',
      payment_id: payment.id,
      redirect_url: redirectUrl,
      attempts_remaining: Math.max(0, 3 - newAttempts),
    },
    200
  );
});

// GET /c/:id/status (Fast, cacheable status check for thank-you/order tracking page)
checkoutRouter.get('/:id/status', async (c) => {
  const paymentId = c.req.param('id');
  const db = createDb(c.env.DB);

  c.header('Cache-Control', 'public, max-age=5');

  const row = await db
    .select({
      id: payments.id,
      status: payments.status,
    })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .get();

  if (!row) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: `Payment not found: ${paymentId}`,
          param: 'id',
        },
      },
      404
    );
  }

  return c.json(
    {
      id: row.id,
      status: row.status,
    },
    200
  );
});
