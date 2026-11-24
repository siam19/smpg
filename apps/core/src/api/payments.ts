import { Hono } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { createDb } from '../db';
import {
  paymentEvents,
  payments,
  wallets,
  type Payment,
  type Wallet,
} from '../db/schema';
import { generatePrefixedId } from '../services/crypto';
import { assignWalletForPayment, getAvailableMethodsForStore } from '../services/wallet';
import { finalizeDueDecisions } from '../services/decision';
import {
  formatPaymentResponse,
  selectPaymentMethod,
  submitPaymentTrx,
} from '../services/payment';
import { queueWebhookDelivery } from '../services/webhook';
import type { Env, PaymentMethod } from '../types';
import type { ApiVariables } from './auth';

export { formatPaymentResponse } from '../services/payment';

export const paymentsRouter = new Hono<{
  Bindings: Env;
  Variables: ApiVariables;
}>();

// POST /v1/payments (Create Payment Session)
paymentsRouter.post('/', async (c) => {
  const store = c.get('store');
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
          eq(payments.storeId, store.id),
          eq(payments.idempotencyKey, idempotencyKey)
        )
      )
      .get();

    if (existing) {
      const existingWallet = existing.walletId
        ? (await db.select().from(wallets).where(eq(wallets.id, existing.walletId)).get()) ?? null
        : null;
      return c.json(formatPaymentResponse(existing, existingWallet), 200);
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

  // Validate optional success_url
  let successUrl: string | null = null;
  if (body.success_url !== undefined && body.success_url !== null && body.success_url !== '') {
    if (typeof body.success_url !== 'string') {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'success_url must be a valid HTTP or HTTPS URL',
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
      successUrl = body.success_url.trim();
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
  }

  // Validate optional cancel_url
  let cancelUrl: string | null = null;
  if (body.cancel_url !== undefined && body.cancel_url !== null && body.cancel_url !== '') {
    if (typeof body.cancel_url !== 'string') {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'cancel_url must be a valid HTTP or HTTPS URL',
            param: 'cancel_url',
          },
        },
        400
      );
    }
    try {
      const parsed = new URL(body.cancel_url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error();
      }
      cancelUrl = body.cancel_url.trim();
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
  let assignedWallet: Wallet | null = null;
  if (body.method === 'bkash' || body.method === 'nagad') {
    const wallet = await assignWalletForPayment(db, store.id, body.method, body.amount);

    if (!wallet) {
      return c.json(
        {
          error: {
            code: 'no_wallet_available',
            message: `No active ${body.method} wallet has sufficient daily limit capacity for BDT ${body.amount}`,
          },
        },
        400
      );
    }
    assignedWalletId = wallet.id;
    assignedWallet = wallet;
  } else if (body.method === 'cod') {
    if (store.codEnabled === 0) {
      return c.json(
        {
          error: {
            code: 'method_not_enabled',
            message: 'Cash on Delivery (COD) is disabled for this store',
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
    storeId: store.id,
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
    successUrl,
    cancelUrl,
    metadata: metadataStr,
    telegramMessageId: null,
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

  const availableMethods = await getAvailableMethodsForStore(
    db,
    store.id,
    body.amount,
    store.codEnabled
  );

  return c.json(formatPaymentResponse(paymentRecord, assignedWallet, availableMethods), 201);
});

// GET /v1/payments/:id (Retrieve Payment)
paymentsRouter.get('/:id', async (c) => {
  const store = c.get('store');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  let payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.storeId, store.id)))
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
      .where(and(eq(payments.id, paymentId), eq(payments.storeId, store.id)))
      .get();
    if (refreshed) {
      payment = refreshed;
    }
  }

  let wallet: Wallet | null = null;
  if (payment.walletId) {
    wallet =
      (await db
        .select()
        .from(wallets)
        .where(eq(wallets.id, payment.walletId))
        .get()) ?? null;
  }

  const availableMethods = await getAvailableMethodsForStore(
    db,
    store.id,
    payment.amount,
    store.codEnabled
  );

  return c.json(formatPaymentResponse(payment, wallet, availableMethods), 200);
});

// GET /v1/payments (List Payments)
paymentsRouter.get('/', async (c) => {
  const store = c.get('store');
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

  const conditions = [eq(payments.storeId, store.id)];

  if (externalOrderId) {
    conditions.push(eq(payments.externalOrderId, externalOrderId));
  }

  if (status) {
    conditions.push(eq(payments.status, status));
  }

  if (cursor) {
    const cursorRow = await db
      .select({ createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.id, cursor), eq(payments.storeId, store.id)))
      .get();

    if (cursorRow) {
      conditions.push(lt(payments.createdAt, cursorRow.createdAt));
    }
  }

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
      data: resultRows.map((r) => formatPaymentResponse(r)),
      has_more: hasMore,
    },
    200
  );
});

// POST /v1/payments/:id/cancel (Cancel Payment)
paymentsRouter.post('/:id/cancel', async (c) => {
  const store = c.get('store');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.storeId, store.id)))
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

  await db
    .update(payments)
    .set({
      status: 'CANCELLED',
      pendingDecision: null,
      decisionEffectiveAt: null,
      updatedAt: now,
    })
    .where(and(eq(payments.id, payment.id), eq(payments.storeId, store.id)));

  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    fromStatus: payment.status,
    toStatus: 'CANCELLED',
    actor: 'api',
    note: 'Payment cancelled via REST API',
    createdAt: now,
  });

  const updated: Payment = {
    ...payment,
    status: 'CANCELLED',
    pendingDecision: null,
    decisionEffectiveAt: null,
    updatedAt: now,
  };

  const formatted = formatPaymentResponse(updated);

  await queueWebhookDelivery(
    db,
    payment.id,
    store.id,
    'payment.cancelled',
    formatted as unknown as Record<string, unknown>
  );

  return c.json(formatted, 200);
});

// POST /v1/payments/:id/method (Set/Update payment method via REST API)
paymentsRouter.post('/:id/method', async (c) => {
  const store = c.get('store');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.storeId, store.id)))
    .get();

  if (!payment) {
    return c.json(
      { error: { code: 'not_found', message: `Payment not found: ${paymentId}`, param: 'id' } },
      404
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'invalid_request', message: 'Malformed JSON payload' } }, 400);
  }

  const result = await selectPaymentMethod({
    db,
    env: c.env,
    payment,
    store,
    method: body.method as PaymentMethod,
    actor: 'api',
  });

  if (!result.ok) {
    return c.json(
      {
        error: {
          code: result.code,
          message: result.message,
          ...(result.param ? { param: result.param } : {}),
        },
      },
      result.status
    );
  }

  return c.json(formatPaymentResponse(result.payment, result.wallet), 200);
});

// POST /v1/payments/:id/submit (Submit TrxID via authenticated REST API)
paymentsRouter.post('/:id/submit', async (c) => {
  const store = c.get('store');
  const db = createDb(c.env.DB);
  const paymentId = c.req.param('id');

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.storeId, store.id)))
    .get();

  if (!payment) {
    return c.json(
      { error: { code: 'not_found', message: `Payment not found: ${paymentId}`, param: 'id' } },
      404
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'invalid_request', message: 'Malformed JSON payload' } }, 400);
  }

  const result = await submitPaymentTrx({
    db,
    env: c.env,
    payment,
    store,
    trxId: body.trx_id,
    senderNumber: body.sender_number,
    actor: 'api',
  });

  if (!result.ok) {
    return c.json(
      {
        error: {
          code: result.code,
          message: result.message,
          ...(result.param ? { param: result.param } : {}),
        },
      },
      result.status
    );
  }

  return c.json(formatPaymentResponse(result.payment, result.wallet), 200);
});
