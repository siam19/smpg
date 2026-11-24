import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createDb } from '../db';
import { payments, stores, wallets } from '../db/schema';
import { getAvailableMethodsForStore } from '../services/wallet';
import { selectPaymentMethod, submitPaymentTrx } from '../services/payment';
import type { Env, PaymentMethod } from '../types';

export const checkoutRouter = new Hono<{ Bindings: Env }>();

function buildRedirectUrl(
  successUrl: string | null,
  paymentId: string,
  status: string
): string | null {
  if (!successUrl) return null;
  const sep = successUrl.includes('?') ? '&' : '?';
  return `${successUrl}${sep}payment_id=${paymentId}&status=${status}`;
}

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

  const store = await db
    .select()
    .from(stores)
    .where(eq(stores.id, payment.storeId))
    .get();

  if (!store) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Store record not found for this payment session',
        },
      },
      404
    );
  }

  if (store.paused === 1) {
    return c.json(
      {
        error: {
          code: 'store_paused',
          message: 'This store is currently paused. Please contact seller.',
        },
      },
      403
    );
  }

  const availableMethods = await getAvailableMethodsForStore(
    db,
    store.id,
    payment.amount,
    store.codEnabled
  );

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
      .from(wallets)
      .where(eq(wallets.id, payment.walletId))
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
        id: store.id,
        name: store.name,
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

  const store = await db
    .select()
    .from(stores)
    .where(eq(stores.id, payment.storeId))
    .get();

  if (!store) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Store record not found',
        },
      },
      404
    );
  }

  if (store.paused === 1) {
    return c.json(
      {
        error: {
          code: 'store_paused',
          message: 'This store is currently paused. Please contact seller.',
        },
      },
      403
    );
  }

  const result = await selectPaymentMethod({
    db,
    env: c.env,
    payment,
    store,
    method: body.method as PaymentMethod,
    actor: 'customer',
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

  if (result.payment.method === 'cod') {
    return c.json(
      {
        id: result.payment.id,
        method: 'cod',
        status: 'CONFIRMED',
        redirect_url: buildRedirectUrl(result.payment.successUrl, result.payment.id, 'confirmed'),
      },
      200
    );
  }

  return c.json(
    {
      id: result.payment.id,
      method: result.payment.method,
      status: result.payment.status,
      assigned_wallet: result.wallet
        ? {
            id: result.wallet.id,
            provider: result.wallet.provider,
            number: result.wallet.number,
            label: result.wallet.label,
          }
        : null,
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

  const store = await db
    .select()
    .from(stores)
    .where(eq(stores.id, payment.storeId))
    .get();

  if (!store) {
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Store record not found',
        },
      },
      404
    );
  }

  if (store.paused === 1) {
    return c.json(
      {
        error: {
          code: 'store_paused',
          message: 'This store is currently paused. Please contact seller.',
        },
      },
      403
    );
  }

  const result = await submitPaymentTrx({
    db,
    env: c.env,
    payment,
    store,
    trxId: body.trx_id,
    senderNumber: body.sender_number,
    actor: 'customer',
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

  return c.json(
    {
      status: 'SUBMITTED',
      message: 'Thank you! We received your payment details. The seller will verify them shortly.',
      payment_id: result.payment.id,
      redirect_url: buildRedirectUrl(result.payment.successUrl, result.payment.id, 'submitted'),
      attempts_remaining: Math.max(0, 3 - result.payment.attempts),
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
