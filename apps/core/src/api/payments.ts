import { Hono } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { createDb } from '../db';
import {
  paymentEvents,
  payments,
  webhookDeliveries,
  type Payment,
} from '../db/schema';
import { generatePrefixedId } from '../services/crypto';
import { assignWalletForPayment } from '../services/wallet';
import { finalizeDueDecisions } from '../services/decision';
import type { Env, PaymentMethod, PaymentStatus } from '../types';
import type { ApiVariables } from './auth';

export function formatPaymentResponse(row: Payment, publicBaseUrl: string) {
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

  return c.json(formatPaymentResponse(paymentRecord, c.env.PUBLIC_BASE_URL), 201);
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

  return c.json(formatPaymentResponse(payment, c.env.PUBLIC_BASE_URL), 200);
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
