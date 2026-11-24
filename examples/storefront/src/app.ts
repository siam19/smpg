import { Hono } from 'hono';
import { SMPG, type PaymentMethod } from 'send-money-payment-gateway';
import { OrderStore, type Order } from './db';

export interface StorefrontOptions {
  smpgBaseUrl?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLayout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f6f7f9;
      color: #111827;
      margin: 0;
      padding: 24px 16px;
    }
    .card {
      max-width: 520px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p.muted { color: #6b7280; margin: 0 0 16px; font-size: 14px; }
    .summary {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .amount { font-size: 22px; font-weight: 700; }
    .methods { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 20px; }
    .method-btn {
      padding: 12px 8px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
    }
    .method-btn.active { border-color: #111827; background: #111827; color: #fff; }
    .wallet-box {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 16px;
    }
    .wallet-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-top: 6px;
    }
    .wallet-num { font-family: monospace; font-size: 18px; font-weight: 700; }
    .btn {
      display: inline-block;
      padding: 10px 16px;
      border-radius: 8px;
      border: none;
      background: #111827;
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn-secondary { background: #e5e7eb; color: #111827; }
    .btn-full { width: 100%; text-align: center; }
    .field { margin-bottom: 12px; }
    .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .field input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: #e5e7eb;
    }
    .badge-PAID, .badge-COD_CONFIRMED { background: #dcfce7; color: #166534; }
    .badge-AWAITING_VERIFICATION { background: #fef3c7; color: #92400e; }
    .badge-PAYMENT_REJECTED, .badge-CANCELLED { background: #fee2e2; color: #991b1b; }
    .alert {
      padding: 12px 14px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
    .alert-info { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;
}

function renderCheckoutPage(order: Order): string {
  const wallet = order.assignedWallet;
  const methods = order.availableMethods?.length
    ? order.availableMethods
    : (['bkash', 'nagad', 'cod'] as PaymentMethod[]);

  const methodLabels: Record<PaymentMethod, string> = {
    bkash: 'bKash',
    nagad: 'Nagad',
    cod: 'Cash on Delivery',
  };

  const methodButtons = methods
    .map(
      (m) =>
        `<button type="button" class="method-btn${order.paymentMethod === m ? ' active' : ''}" data-method="${m}">${methodLabels[m]}</button>`
    )
    .join('');

  const showSendMoney = order.paymentMethod === 'bkash' || order.paymentMethod === 'nagad';

  const body = `
    <h1>Complete Your Payment</h1>
    <p class="muted">Order <strong>${escapeHtml(order.id)}</strong> &middot; ${escapeHtml(order.customerName)}</p>

    <div class="summary">
      <span>Total Payable</span>
      <span class="amount">&#2547;${order.totalAmount}</span>
    </div>

    <div id="error-box" class="alert alert-error hidden"></div>

    <p style="font-size: 13px; font-weight: 600; margin: 0 0 8px;">1. Select Payment Method</p>
    <div class="methods" id="method-buttons">${methodButtons}</div>

    <div id="send-money-panel" class="${showSendMoney && wallet ? '' : 'hidden'}">
      <div class="wallet-box">
        <div style="font-size: 13px; color: #166534;">
          Send <strong>&#2547;${order.totalAmount}</strong> via <strong id="wallet-provider">${escapeHtml(wallet?.provider ?? '')}</strong> Send Money to:
        </div>
        <div class="wallet-row">
          <span class="wallet-num" id="wallet-number">${escapeHtml(wallet?.number ?? '')}</span>
          <button type="button" class="btn btn-secondary" id="copy-btn">Copy</button>
        </div>
      </div>

      <form id="trx-form">
        <div class="field">
          <label for="trx-id">Transaction ID (TrxID)</label>
          <input id="trx-id" name="trxId" placeholder="e.g. 9A8B7C6D5E" required autocomplete="off" />
        </div>
        <div class="field">
          <label for="sender-number">Sender Phone Number (Optional)</label>
          <input id="sender-number" name="senderNumber" placeholder="01XXXXXXXXX" />
        </div>
        <button type="submit" class="btn btn-full" id="submit-btn">Submit Transaction ID</button>
      </form>
    </div>

    <div id="cod-panel" class="${order.paymentMethod === 'cod' ? '' : 'hidden'}">
      <div class="alert alert-info">
        Cash on Delivery selected. You will pay <strong>&#2547;${order.totalAmount}</strong> upon delivery.
      </div>
      <a href="/orders/${encodeURIComponent(order.id)}" class="btn btn-full">View Order Status</a>
    </div>

    <script>
      const orderId = ${JSON.stringify(order.id)};
      const paymentId = ${JSON.stringify(order.smpgPaymentId || '')};
      const errorBox = document.getElementById('error-box');
      const sendMoneyPanel = document.getElementById('send-money-panel');
      const codPanel = document.getElementById('cod-panel');
      const walletProviderEl = document.getElementById('wallet-provider');
      const walletNumberEl = document.getElementById('wallet-number');
      const copyBtn = document.getElementById('copy-btn');
      const trxForm = document.getElementById('trx-form');

      function showError(msg) {
        errorBox.textContent = msg;
        errorBox.classList.remove('hidden');
      }

      function clearError() {
        errorBox.textContent = '';
        errorBox.classList.add('hidden');
      }

      document.querySelectorAll('.method-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          clearError();
          const method = btn.dataset.method;
          document.querySelectorAll('.method-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');

          try {
            const res = await fetch('/api/checkout/method', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId, paymentId, method }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to select method');

            if (method === 'cod') {
              sendMoneyPanel.classList.add('hidden');
              codPanel.classList.remove('hidden');
            } else if (data.assignedWallet) {
              codPanel.classList.add('hidden');
              walletProviderEl.textContent = data.assignedWallet.provider;
              walletNumberEl.textContent = data.assignedWallet.number;
              sendMoneyPanel.classList.remove('hidden');
            }
          } catch (err) {
            showError(err.message || 'Could not select payment method');
          }
        });
      });

      copyBtn.addEventListener('click', async () => {
        const num = walletNumberEl.textContent.trim();
        if (!num) return;
        try {
          await navigator.clipboard.writeText(num);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        } catch {
          copyBtn.textContent = 'Copy failed';
        }
      });

      trxForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError();
        const trxId = document.getElementById('trx-id').value.trim();
        const senderNumber = document.getElementById('sender-number').value.trim();
        if (!trxId) return;

        try {
          const res = await fetch('/api/checkout/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId, paymentId, trxId, senderNumber: senderNumber || undefined }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to submit TrxID');
          window.location.href = '/orders/' + encodeURIComponent(orderId);
        } catch (err) {
          showError(err.message || 'Submission failed');
        }
      });
    </script>
  `;

  return renderLayout(`Checkout ${order.id}`, body);
}

function renderOrderPage(order: Order): string {
  const wallet = order.assignedWallet;

  let statusSection = '';
  if (order.status === 'PENDING_PAYMENT') {
    statusSection = `
      <div class="alert alert-info">Payment has not been submitted yet.</div>
      <a href="/checkout/${encodeURIComponent(order.id)}" class="btn btn-full">Proceed to Checkout</a>
    `;
  } else if (order.status === 'AWAITING_VERIFICATION') {
    statusSection = `
      <div class="alert alert-info">
        Payment received! The seller is verifying your transaction${order.trxId ? ` (<strong>${escapeHtml(order.trxId)}</strong>)` : ''}.
      </div>
    `;
  } else if (order.status === 'PAID') {
    statusSection = `
      <div class="wallet-box">
        <strong>Payment Verified!</strong> Your order is confirmed and being prepared.
      </div>
    `;
  } else if (order.status === 'COD_CONFIRMED') {
    statusSection = `
      <div class="wallet-box">
        <strong>Cash on Delivery Confirmed!</strong> Pay &#2547;${order.totalAmount} when your parcel arrives.
      </div>
    `;
  } else if (order.status === 'PAYMENT_REJECTED') {
    statusSection = `
      <div class="alert alert-error">
        Your previous Transaction ID could not be verified. Please check your SMS/app receipt and submit the correct TrxID below.
      </div>
      ${
        wallet
          ? `<div class="wallet-box">
              <div style="font-size: 13px; color: #166534;">Send <strong>&#2547;${order.totalAmount}</strong> to (${escapeHtml(wallet.provider)}):</div>
              <div class="wallet-row">
                <span class="wallet-num" id="retry-wallet-num">${escapeHtml(wallet.number)}</span>
                <button type="button" class="btn btn-secondary" id="retry-copy-btn">Copy</button>
              </div>
            </div>`
          : ''
      }
      <div id="retry-error" class="alert alert-error hidden"></div>
      <form id="retry-form">
        <div class="field">
          <label for="retry-trx-id">New Transaction ID (TrxID)</label>
          <input id="retry-trx-id" name="trxId" placeholder="Enter correct TrxID" required autocomplete="off" />
        </div>
        <button type="submit" class="btn btn-full">Retry Submission</button>
      </form>
      <script>
        const retryForm = document.getElementById('retry-form');
        const retryError = document.getElementById('retry-error');
        const retryCopy = document.getElementById('retry-copy-btn');
        if (retryCopy) {
          retryCopy.addEventListener('click', async () => {
            const num = document.getElementById('retry-wallet-num').textContent.trim();
            await navigator.clipboard.writeText(num);
            retryCopy.textContent = 'Copied!';
            setTimeout(() => { retryCopy.textContent = 'Copy'; }, 1500);
          });
        }
        retryForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          retryError.classList.add('hidden');
          const trxId = document.getElementById('retry-trx-id').value.trim();
          try {
            const res = await fetch('/api/checkout/submit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                orderId: ${JSON.stringify(order.id)},
                paymentId: ${JSON.stringify(order.smpgPaymentId || '')},
                trxId,
              }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Retry failed');
            window.location.reload();
          } catch (err) {
            retryError.textContent = err.message || 'Retry failed';
            retryError.classList.remove('hidden');
          }
        });
      </script>
    `;
  } else {
    statusSection = `<div class="alert alert-error">This order has been cancelled.</div>`;
  }

  const pollScript =
    order.status === 'AWAITING_VERIFICATION'
      ? `<script>
          setInterval(async () => {
            try {
              const res = await fetch('/api/orders/' + encodeURIComponent(${JSON.stringify(order.id)}));
              if (!res.ok) return;
              const data = await res.json();
              if (data.order && data.order.status !== 'AWAITING_VERIFICATION') {
                window.location.reload();
              }
            } catch {}
          }, 5000);
        </script>`
      : '';

  const body = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
      <h1>Order ${escapeHtml(order.id)}</h1>
      <span class="badge badge-${escapeHtml(order.status)}">${escapeHtml(order.status)}</span>
    </div>
    <p class="muted">${escapeHtml(order.customerName)} &middot; ${escapeHtml(order.customerPhone)}</p>
    <div class="summary">
      <span>Order Total</span>
      <span class="amount">&#2547;${order.totalAmount}</span>
    </div>
    ${statusSection}
    ${pollScript}
  `;

  return renderLayout(`Order ${order.id}`, body);
}

export function createStorefrontApp(smpgClient?: SMPG, options?: StorefrontOptions) {
  const app = new Hono();

  const smpg =
    smpgClient ||
    new SMPG(process.env.SMPG_API_KEY || 'smpg_test_mock', {
      baseUrl: options?.smpgBaseUrl || process.env.SMPG_BASE_URL || 'http://localhost:8787',
      webhookSecret: process.env.SMPG_WEBHOOK_SECRET || 'test_webhook_secret',
    });

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', service: 'reference-storefront' }));

  // Demo storefront landing page
  app.get('/', (c) => {
    const html = renderLayout(
      'SMPG Reference Storefront',
      `<h1>SMPG Reference Storefront</h1>
       <p class="muted">Self-hosted embedded checkout demo (bKash / Nagad / COD).</p>
       <div class="summary">
         <span>Cotton Panjabi &times; 1</span>
         <span class="amount">&#2547;1850</span>
       </div>
       <button type="button" class="btn btn-full" id="start-checkout">Proceed to Checkout</button>
       <script>
         document.getElementById('start-checkout').addEventListener('click', async () => {
           const res = await fetch('/api/checkout', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({
               customerName: 'Demo Customer',
               customerPhone: '01711223344',
               items: [{ id: 'item_1', name: 'Cotton Panjabi', price: 1850, quantity: 1 }],
             }),
           });
           const data = await res.json();
           if (res.ok && data.checkoutPath) {
             window.location.href = data.checkoutPath;
           }
         });
       </script>`
    );
    return c.html(html);
  });

  // Embedded Checkout Page
  app.get('/checkout/:orderId', (c) => {
    const order = OrderStore.get(c.req.param('orderId'));
    if (!order) {
      return c.html(renderLayout('Order Not Found', '<h1>Order Not Found</h1>'), 404);
    }
    return c.html(renderCheckoutPage(order));
  });

  // Order Status & Rejection Retry Page
  app.get('/orders/:orderId', (c) => {
    const order = OrderStore.get(c.req.param('orderId'));
    if (!order) {
      return c.html(renderLayout('Order Not Found', '<h1>Order Not Found</h1>'), 404);
    }
    return c.html(renderOrderPage(order));
  });

  // 1. Initiate Checkout (Golden Rule 1: Order created BEFORE payment session)
  app.post('/api/checkout', async (c) => {
    const body = await c.req.json();
    const { customerName, customerPhone, items, method } = body;

    const totalAmount = items.reduce(
      (sum: number, item: { price: number; quantity: number }) => sum + item.price * item.quantity,
      0
    );

    const orderId = `ORD-${Date.now().toString().slice(-6)}`;

    // Create local order in PENDING_PAYMENT status
    const order = OrderStore.create({
      id: orderId,
      customerName,
      customerPhone,
      items,
      totalAmount,
    });

    // Create SMPG Payment Session
    const origin = new URL(c.req.url).origin;
    const payment = await smpg.payments.create({
      amount: totalAmount,
      method: method || undefined,
      external_order_id: order.id,
      customer: {
        name: customerName,
        phone: customerPhone,
      },
      success_url: `${origin}/orders/${order.id}`,
      cancel_url: `${origin}/`,
    });

    // Store payment ID and assigned wallet with order
    OrderStore.update(order.id, {
      smpgPaymentId: payment.id,
      paymentMethod: method || undefined,
      availableMethods: payment.available_methods,
      assignedWallet: payment.assigned_wallet ?? null,
    });

    return c.json(
      {
        orderId: order.id,
        paymentId: payment.id,
        checkoutPath: `/checkout/${order.id}`,
        orderPath: `/orders/${order.id}`,
        availableMethods: payment.available_methods,
        assignedWallet: payment.assigned_wallet ?? null,
        amount: payment.amount,
      },
      201
    );
  });

  // 2. Select Payment Method from embedded checkout box
  app.post('/api/checkout/method', async (c) => {
    const { paymentId, method, orderId } = (await c.req.json()) as {
      paymentId: string;
      method: PaymentMethod;
      orderId: string;
    };

    const payment = await smpg.payments.selectMethod(paymentId, method);

    OrderStore.update(orderId, {
      paymentMethod: method,
      assignedWallet: payment.assigned_wallet ?? null,
    });

    return c.json({
      orderId,
      paymentId: payment.id,
      method: payment.method,
      paymentStatus: payment.status,
      assignedWallet: payment.assigned_wallet ?? null,
    });
  });

  // 3. Submit TrxID from custom embedded checkout box
  app.post('/api/checkout/submit', async (c) => {
    const { paymentId, trxId, senderNumber, orderId } = await c.req.json();

    const payment = await smpg.payments.submit(paymentId, {
      trx_id: trxId,
      ...(senderNumber ? { sender_number: senderNumber } : {}),
    });

    // Golden Rule 2: Move order to AWAITING_VERIFICATION (NEVER to PAID yet)
    OrderStore.update(orderId, {
      status: 'AWAITING_VERIFICATION',
      trxId,
    });

    return c.json({
      orderId,
      status: 'AWAITING_VERIFICATION',
      paymentStatus: payment.status,
    });
  });

  // 4. Order Details (Server-side source of truth)
  app.get('/api/orders/:id', (c) => {
    const id = c.req.param('id');
    const order = OrderStore.get(id);

    if (!order) {
      return c.json({ error: 'Order not found' }, 404);
    }

    return c.json({ order });
  });

  // 5. SMPG Webhook Receiver (Golden Rules 3, 4, 5, 6)
  app.post('/api/webhooks/smpg', async (c) => {
    const signature = c.req.header('x-smpg-signature');

    if (!signature) {
      return c.text('Missing x-smpg-signature header', 400);
    }

    // Must verify on RAW request body string
    const rawBody = await c.req.text();

    let event;
    try {
      event = await smpg.webhooks.constructEvent(rawBody, signature);
    } catch (err: any) {
      return c.text(`Invalid webhook signature: ${err.message}`, 400);
    }

    // Golden Rule 4: Idempotent processing
    if (OrderStore.isEventProcessed(event.id)) {
      return c.json({ received: true, deduplicated: true }, 200);
    }

    const orderId = event.data.external_order_id;
    if (!orderId) {
      return c.text('Missing external_order_id in event data', 400);
    }

    const order = OrderStore.get(orderId);
    if (!order) {
      return c.text(`Order ${orderId} not found`, 404);
    }

    // Apply state transition based on verified event type
    switch (event.type) {
      case 'payment.paid':
        OrderStore.update(orderId, {
          status: 'PAID',
          paidAt: new Date(),
        });
        break;

      case 'payment.confirmed':
        OrderStore.update(orderId, {
          status: 'COD_CONFIRMED',
        });
        break;

      case 'payment.rejected':
        OrderStore.update(orderId, {
          status: 'PAYMENT_REJECTED',
          retryUrl: `/orders/${orderId}`,
        });
        break;

      case 'payment.reopened':
        OrderStore.update(orderId, {
          status: 'AWAITING_VERIFICATION',
        });
        break;

      case 'payment.cancelled':
      case 'payment.expired':
        OrderStore.update(orderId, {
          status: 'CANCELLED',
        });
        break;
    }

    OrderStore.markEventProcessed(event.id);
    return c.json({ received: true }, 200);
  });

  return app;
}
