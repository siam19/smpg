import { Hono } from 'hono';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { createDb } from '../db';
import {
  merchantWallets,
  paymentEvents,
  payments,
  trxSubmissions,
  webhookDeliveries,
  type MerchantWallet,
  type Payment,
} from '../db/schema';
import { generatePrefixedId } from '../services/crypto';
import { assignWalletForPayment, getMerchantWalletsWithUsage } from '../services/wallet';
import { finalizeDueDecisions } from '../services/decision';
import { createBot } from '../bot';
import { sendPaymentSubmissionNotification } from '../services/notification';
import type { Env, PaymentMethod, PaymentStatus } from '../types';
import type { ApiVariables } from './auth';

export async function getAvailableMethodsForMerchant(
  db: any,
  merchantId: string,
  amount: number,
  codEnabled: number
): Promise<PaymentMethod[]> {
  const methods: PaymentMethod[] = [];
  if (codEnabled === 1) {
    methods.push('cod');
  }

  const bkashWallets = await getMerchantWalletsWithUsage(db, merchantId, 'bkash');
  if (
    bkashWallets.some(
      (w) => w.wallet.active === 1 && w.reservedToday + amount <= w.wallet.dailyLimit
    )
  ) {
    methods.push('bkash');
  }

  const nagadWallets = await getMerchantWalletsWithUsage(db, merchantId, 'nagad');
  if (
    nagadWallets.some(
      (w) => w.wallet.active === 1 && w.reservedToday + amount <= w.wallet.dailyLimit
    )
  ) {
    methods.push('nagad');
  }

  return methods;
}

export function formatPaymentResponse(
  row: Payment,
  publicBaseUrl: string,
  wallet?: MerchantWallet | null,
  availableMethods?: PaymentMethod[]
) {
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
    merchant_id: row.merchantId,
    mode: row.mode as 'test' | 'live',
    external_order_id: row.externalOrderId ?? null,
    method: row.method as PaymentMethod | null,
    wallet_id: row.walletId ?? null,
    assigned_wallet: wallet
      ? {
          id: wallet.id,
          provider: wallet.provider as PaymentMethod,
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
    success_url: row.successUrl,
    cancel_url: row.cancelUrl ?? null,
    checkout_url: `${publicBaseUrl.replace(/\/+$/, '')}/c/${row.id}`,
    metadata,
    pending_decision: row.pendingDecision ?? null,
    expires_at: new Date(row.expiresAt * 1000).toISOString(),
    created_at: new Date(row.createdAt * 1000).toISOString(),
    updated_at: new Date(row.updatedAt * 1000).toISOString(),
  };
}

export const paymentsRouter = new Hono<{
  Bindings: Env;
  Variables: ApiVariables;
}>();

// POST /v1/payments (Create Payment Session)
paymentsRouter.post('/', async (c) => {
  const merchant = c.get('merchant');
  const mode = c.get('mode');
  const db = createDb(c.env.DB);

  // 1. Check Idempotency-Key
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (idempotencyKey) {
    const existing = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.merchantId, merchant.id),
          eq(payments.idempotencyKey, idempotencyKey)
        )
      )
      .get();

    if (existing) {
      return c.json(formatPaymentResponse(existing, c.env.PUBLIC_BASE_URL), 200);
    }
  }

  // 2. Parse & Validate JSON body
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Malformed JSON payload in request body',
        },
      },
      400
    );
  }

  // Validate amount (integer >= 1)
  if (typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount < 1) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'amount must be a positive integer BDT (>= 1)',
          param: 'amount',
        },
      },
      400
    );
  }

  // Validate success_url
  if (!body.success_url || typeof body.success_url !== 'string') {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'success_url is required and must be a valid URL',
          param: 'success_url',
        },
      },
      400
    );
  }

  try {
    const parsed = new URL(body.success_url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'success_url must be an HTTP or HTTPS URL',
          param: 'success_url',
        },
      },
      400
    );
  }

  // Validate cancel_url
  if (body.cancel_url) {
    try {
      const parsed = new URL(body.cancel_url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error();
      }
    } catch {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'cancel_url must be an HTTP or HTTPS URL',
            param: 'cancel_url',
          },
        },
        400
      );
    }
  }

  // Validate method
  if (body.method !== undefined && body.method !== null) {
    if (!['cod', 'bkash', 'nagad'].includes(body.method)) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: "method must be one of 'cod', 'bkash', or 'nagad'",
            param: 'method',
          },
        },
        400
      );
    }
  }

  // Validate metadata length
  let metadataStr: string | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object') {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'metadata must be a JSON object',
            param: 'metadata',
          },
        },
        400
      );
    }
    metadataStr = JSON.stringify(body.metadata);
    if (metadataStr.length > 2048) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'metadata must not exceed 2048 bytes when serialized',
            param: 'metadata',
          },
        },
        400
      );
    }
  }

  // 3. Process Method & Wallet Allocation
  let assignedWalletId: string | null = null;
  let assignedWallet: MerchantWallet | null = null;
  if (body.method === 'bkash' || body.method === 'nagad') {
    const wallet = await assignWalletForPayment(
      db,
      merchant.id,
      body.method,
      body.amount,
      merchant.rotationStrategy as 'balanced' | 'fill_first'
    );

    if (!wallet) {
      return c.json(
        {
          error: {
            code: 'no_wallet_available',
            message: `No active ${body.method} wallet has sufficient daily limit capacity for ৳${body.amount}`,
          },
        },
        400
      );
    }
    assignedWalletId = wallet.id;
    assignedWallet = wallet;
  } else if (body.method === 'cod') {
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
  }

  // 4. Compute Timestamps and ID
  const now = Math.floor(Date.now() / 1000);
  const createdTtlMinutes = parseInt(c.env.CREATED_TTL_MINUTES || '60', 10);
  const expiresAt = now + createdTtlMinutes * 60;
  const paymentId = generatePrefixedId('pay');

  const paymentRecord: Payment = {
    id: paymentId,
    merchantId: merchant.id,
    mode,
    externalOrderId: body.external_order_id?.trim() || null,
    method: body.method || null,
    walletId: assignedWalletId,
    amount: body.amount,
    status: 'CREATED',
    trxId: null,
    senderNumber: null,
    customerName: body.customer?.name?.trim() || null,
    customerPhone: body.customer?.phone?.trim() || null,
    parentPaymentId: null,
    verificationMethod: null,
    successUrl: body.success_url.trim(),
    cancelUrl: body.cancel_url?.trim() || null,
    metadata: metadataStr,
    idempotencyKey: idempotencyKey || null,
    attempts: 0,
    pendingDecision: null,
    decisionActor: null,
    decisionEffectiveAt: null,
    lateSubmission: 0,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  // 5. Insert Record and Audit Event
  await db.insert(payments).values(paymentRecord);

  await db.insert(paymentEvents).values({
    paymentId,
    fromStatus: null,
    toStatus: 'CREATED',
    actor: 'api',
    note: 'Payment session created via REST API',
    createdAt: now,
  });

  const availableMethods = await getAvailableMethodsForMerchant(
    db,
    merchant.id,
    body.amount,
    merchant.codEnabled
  );

  return c.json(
    formatPaymentResponse(paymentRecord, c.env.PUBLIC_BASE_URL, assignedWallet, availableMethods),
    201
  );
});

// GET /v1/payments/:id (Retrieve Payment)
paymentsRouter.get('/:id', async (c) => {
  const merchant = c.get('merchant');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  let payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchant.id)))
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

  // Lazy undo finalization check
  const now = Math.floor(Date.now() / 1000);
  if (
    payment.pendingDecision &&
    payment.decisionEffectiveAt &&
    payment.decisionEffectiveAt <= now
  ) {
    await finalizeDueDecisions(db);
    const refreshed = await db
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchant.id)))
      .get();
    if (refreshed) {
      payment = refreshed;
    }
  }

  let wallet: MerchantWallet | null = null;
  if (payment.walletId) {
    wallet =
      (await db
        .select()
        .from(merchantWallets)
        .where(eq(merchantWallets.id, payment.walletId))
        .get()) ?? null;
  }

  const availableMethods = await getAvailableMethodsForMerchant(
    db,
    merchant.id,
    payment.amount,
    merchant.codEnabled
  );

  return c.json(
    formatPaymentResponse(payment, c.env.PUBLIC_BASE_URL, wallet, availableMethods),
    200
  );
});

// GET /v1/payments (List Payments)
paymentsRouter.get('/', async (c) => {
  const merchant = c.get('merchant');
  const db = createDb(c.env.DB);

  const externalOrderId = c.req.query('external_order_id')?.trim();
  const status = c.req.query('status')?.trim().toUpperCase();
  const cursor = c.req.query('cursor')?.trim();
  const rawLimit = c.req.query('limit');

  let limit = 20;
  if (rawLimit) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 100) {
      limit = parsed;
    }
  }

  const conditions = [eq(payments.merchantId, merchant.id)];

  if (externalOrderId) {
    conditions.push(eq(payments.externalOrderId, externalOrderId));
  }

  if (status) {
    conditions.push(eq(payments.status, status));
  }

  if (cursor) {
    // Cursor pagination based on createdAt / id
    const cursorRow = await db
      .select({ createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.id, cursor), eq(payments.merchantId, merchant.id)))
      .get();

    if (cursorRow) {
      conditions.push(lt(payments.createdAt, cursorRow.createdAt));
    }
  }

  // Fetch limit + 1 to calculate has_more
  const rows = await db
    .select()
    .from(payments)
    .where(and(...conditions))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;

  return c.json(
    {
      data: resultRows.map((r) => formatPaymentResponse(r, c.env.PUBLIC_BASE_URL)),
      has_more: hasMore,
    },
    200
  );
});

// POST /v1/payments/:id/cancel (Cancel Payment)
paymentsRouter.post('/:id/cancel', async (c) => {
  const merchant = c.get('merchant');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchant.id)))
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

  if (payment.status !== 'CREATED' && payment.status !== 'CONFIRMED') {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: `Cannot cancel payment in ${payment.status} state. Only CREATED or CONFIRMED payments can be cancelled.`,
        },
      },
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // Atomically update payment to CANCELLED
  await db
    .update(payments)
    .set({
      status: 'CANCELLED',
      pendingDecision: null,
      decisionEffectiveAt: null,
      updatedAt: now,
    })
    .where(and(eq(payments.id, payment.id), eq(payments.merchantId, merchant.id)));

  // Record in audit log
  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: payment.status,
    toStatus: 'CANCELLED',
    actor: 'api',
    note: 'Payment cancelled via REST API',
    createdAt: now,
  });

  // Queue outbound webhook delivery
  const payloadObj = {
    id: generatePrefixedId('evt'),
    type: 'payment.cancelled',
    created: now,
    data: {
      ...payment,
      status: 'CANCELLED',
    },
  };

  await db.insert(webhookDeliveries).values({
    id: generatePrefixedId('dlv'),
    paymentId: payment.id,
    eventType: 'payment.cancelled',
    payload: JSON.stringify(payloadObj),
    attempt: 0,
    nextAttemptAt: now,
  });

  const updated: Payment = {
    ...payment,
    status: 'CANCELLED',
    pendingDecision: null,
    decisionEffectiveAt: null,
    updatedAt: now,
  };

  return c.json(formatPaymentResponse(updated, c.env.PUBLIC_BASE_URL), 200);
});

// POST /v1/payments/:id/method (Set/Update payment method via REST API)
paymentsRouter.post('/:id/method', async (c) => {
  const merchant = c.get('merchant');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchant.id)))
    .get();

  if (!payment) {
    return c.json(
      { error: { code: 'not_found', message: `Payment not found: ${paymentId}`, param: 'id' } },
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
    return c.json({ error: { code: 'invalid_request', message: 'Malformed JSON payload' } }, 400);
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

  const now = Math.floor(Date.now() / 1000);

  if (method === 'cod') {
    if (merchant.codEnabled === 0) {
      return c.json(
        {
          error: {
            code: 'method_not_enabled',
            message: 'Cash on Delivery (COD) is disabled for this merchant',
          },
        },
        400
      );
    }

    await db
      .update(payments)
      .set({
        method: 'cod',
        status: 'CONFIRMED',
        updatedAt: now,
      })
      .where(eq(payments.id, payment.id));

    await db.insert(paymentEvents).values({
      paymentId: payment.id,
      fromStatus: 'CREATED',
      toStatus: 'CONFIRMED',
      actor: 'merchant_api',
      note: 'Payment method set to COD via REST API',
      createdAt: now,
    });

    const updated = (await db.select().from(payments).where(eq(payments.id, payment.id)).get())!;
    return c.json(formatPaymentResponse(updated, c.env.PUBLIC_BASE_URL, null), 200);
  }

  // bKash or Nagad: allocate active wallet
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

  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: 'CREATED',
    toStatus: 'CREATED',
    actor: 'merchant_api',
    note: `Payment method set to ${method} (wallet: ${wallet.number}) via REST API`,
    createdAt: now,
  });

  const updated = (await db.select().from(payments).where(eq(payments.id, payment.id)).get())!;
  return c.json(formatPaymentResponse(updated, c.env.PUBLIC_BASE_URL, wallet), 200);
});

// POST /v1/payments/:id/submit (Submit TrxID via authenticated REST API)
paymentsRouter.post('/:id/submit', async (c) => {
  const merchant = c.get('merchant');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.merchantId, merchant.id)))
    .get();

  if (!payment) {
    return c.json(
      { error: { code: 'not_found', message: `Payment not found: ${paymentId}`, param: 'id' } },
      404
    );
  }

  if (payment.status === 'PAID') {
    return c.json({ error: { code: 'invalid_state', message: 'Payment is already PAID' } }, 400);
  }
  if (payment.status === 'CANCELLED') {
    return c.json(
      { error: { code: 'invalid_state', message: 'Payment session has been CANCELLED' } },
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
      { error: { code: 'invalid_state', message: `Cannot submit payment in ${payment.status} status` } },
      400
    );
  }

  if (payment.attempts >= 3) {
    return c.json(
      { error: { code: 'too_many_attempts', message: 'Maximum submission attempts (3) exceeded' } },
      400
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const lateSubmitHours = parseInt(c.env.LATE_SUBMIT_HOURS || '24', 10);
  let isLate = 0;
  if (now > payment.expiresAt) {
    if (now > payment.expiresAt + lateSubmitHours * 3600) {
      return c.json(
        {
          error: {
            code: 'payment_expired',
            message: 'Payment expired outside 24h grace window',
          },
        },
        400
      );
    }
    isLate = 1;
  }

  if (!payment.method || (payment.method !== 'bkash' && payment.method !== 'nagad')) {
    return c.json(
      {
        error: {
          code: 'invalid_state',
          message: 'Please select a mobile payment method (bKash or Nagad) before submitting TrxID',
        },
      },
      400
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'invalid_request', message: 'Malformed JSON payload' } }, 400);
  }

  // Validate optional sender number
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
            message: 'Invalid 11-digit Bangladeshi mobile number',
            param: 'sender_number',
          },
        },
        400
      );
    }
    senderNumber = rawNumber;
  }

  // Validate TrxID
  const trxId = body.trx_id ? String(body.trx_id).replace(/\s+/g, '').toUpperCase() : '';
  if (!trxId || !/^[A-Z0-9]{6,30}$/.test(trxId)) {
    return c.json(
      {
        error: {
          code: 'trx_id_invalid_format',
          message: 'Invalid TrxID format. Must be 6-30 alphanumeric characters.',
          param: 'trx_id',
        },
      },
      400
    );
  }

  // Burn TrxID in live mode
  if (payment.mode === 'live') {
    const existing = await db
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

    if (existing) {
      return c.json(
        {
          error: {
            code: 'trx_id_already_used',
            message: 'TrxID has already been submitted for another payment',
            param: 'trx_id',
          },
        },
        400
      );
    }
  }

  // 1. Burn TrxID in trx_submissions
  await db.insert(trxSubmissions).values({
    paymentId: payment.id,
    method: payment.method,
    trxId,
    senderNumber,
    outcome: 'pending',
    mode: payment.mode,
    createdAt: now,
  });

  // 2. Update payment
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

  // 3. Record audit event
  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: payment.status,
    toStatus: 'SUBMITTED',
    actor: 'merchant_api',
    note: isLate ? 'TrxID submitted via REST API (late)' : 'TrxID submitted via REST API',
    createdAt: now,
  });

  const updated = (await db.select().from(payments).where(eq(payments.id, payment.id)).get())!;

  // 4. Dispatch Telegram card
  let wallet: MerchantWallet | null = null;
  if (updated.walletId) {
    wallet =
      (await db
        .select()
        .from(merchantWallets)
        .where(eq(merchantWallets.id, updated.walletId))
        .get()) ?? null;
  }

  if (c.env.TELEGRAM_BOT_TOKEN) {
    try {
      const bot = createBot(c.env, db);
      const messageId = await sendPaymentSubmissionNotification(bot, merchant, updated, wallet);
      if (messageId) {
        let existingMeta: Record<string, any> = {};
        if (updated.metadata) {
          try {
            existingMeta = JSON.parse(updated.metadata);
          } catch {}
        }
        existingMeta.telegram_message_id = messageId;
        await db
          .update(payments)
          .set({ metadata: JSON.stringify(existingMeta) })
          .where(eq(payments.id, payment.id));
      }
    } catch (err) {
      console.error('[Payments] Telegram notification dispatch failed:', err);
    }
  }

  return c.json(formatPaymentResponse(updated, c.env.PUBLIC_BASE_URL, wallet), 200);
});
