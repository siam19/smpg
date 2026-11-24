---
name: smpg-integration
description: |
  Comprehensive integration guide and instructions for AI coding agents to integrate SMPG
  (Send Money Payment Gateway) into any e-commerce storefront or web application.
  Supports Next.js, Express, Hono, Remix, React, Python (FastAPI/Flask), PHP (Laravel),
  and any REST/webhook environment. Covers self-hosted deployment, embedded custom
  checkout boxes, and raw-body HMAC webhook verification (`x-smpg-signature`).
---

# SMPG Integration Skill (Send Money Payment Gateway)

> **Role & Purpose**: You are an expert software engineer integrating **SMPG (Send Money Payment Gateway)** into an e-commerce storefront or application. SMPG is a self-hosted, single-owner, multi-store Cloudflare Worker + D1 gateway designed for embedded custom checkout UIs. Follow these instructions strictly to ensure resilient, fraud-proof payment processing.

---

## 1. Overview & Core Architecture

SMPG enables merchants in Bangladesh to self-host a private payment gateway for **bKash Personal Send Money**, **Nagad Personal Send Money**, and **Cash on Delivery (COD)** without commercial trade licenses, central servers, or transaction fee percentages.

### Key Architectural Tenets
1. **Self-Hosted, Single-Owner, Multi-Store**: Each merchant deploys their own Cloudflare Worker + D1 instance (`bun run setup`) with their own private Telegram bot. One bot manages multiple stores (`str_...`) and shared or store-scoped personal SIM wallets.
2. **Embedded Custom Checkout**: There is no separate hosted checkout worker. Storefronts render their own native checkout box using `SMPG` (server) and `SMPGCheckout` (browser-safe `/c/:id/*` endpoints).
3. **Cross-Store Dynamic Wallet Rotation**: The gateway balances incoming payments across configured personal SIM numbers to prevent hitting daily limits (BDT 25,000/day per SIM), enforcing the cap across all stores.
4. **Asynchronous Verification**: Customers send money and submit their Transaction ID (TrxID). The owner receives a plain-text Telegram notification (with Store Name, amount, wallet number, and TrxID) and clicks **Approve** or **Reject** (or replies `"ok"` / `"y"`).
5. **90-Second Undo Window**: Any accidental tap in Telegram can be undone within 90 seconds before the state is finalized and webhooks fire.
6. **Strict Webhook-Driven Fulfillment**: Submitting a TrxID only moves the payment to `SUBMITTED`. The storefront database must **NEVER** mark an order as `PAID` on client submission; orders are only marked `PAID` when a cryptographically signed `payment.paid` webhook arrives (`x-smpg-signature`).

---

## 2. The 6 Non-Negotiable Golden Rules

Every AI coding agent integrating SMPG must adhere to these 6 golden rules:

### Rule 1: Create Local Order BEFORE Creating Payment Session
Always persist the order record in your local database with status `PENDING_PAYMENT` *before* invoking SMPG. Pass your local order identifier as `external_order_id` and `idempotencyKey`:
```typescript
const order = await db.orders.create({ total: 1850, status: 'PENDING_PAYMENT' });

const payment = await smpg.payments.create(
  {
    amount: order.total,
    external_order_id: order.id,
  },
  { idempotencyKey: order.id }
);
```

### Rule 2: NEVER Mark Orders as "PAID" on Client Submission
When the customer submits their TrxID via `SMPGCheckout.submit` or your backend, the owner has **NOT** verified the funds yet.
- Prepaid orders (bKash/Nagad) must be set to `AWAITING_VERIFICATION` or `PAYMENT_PENDING`.
- Show a message: *"Payment received! We are verifying your transaction with the provider."*
- **NEVER** update order status to `PAID` based on client-side submission responses or URL query parameters.

### Rule 3: Verify Webhooks on UNTOUCHED RAW Request Bodies (`x-smpg-signature`)
Webhook signatures use HMAC-SHA256 in the `x-smpg-signature` header (`t=<timestamp>,v1=<hex>`).
- Always pass the raw, unparsed string or Buffer to `smpg.webhooks.constructEvent(rawBody, signatureHeader)`.
- Never verify re-serialized JSON (e.g. `JSON.stringify(req.body)`), as altered whitespace or key ordering will invalidate the signature.
- Reject requests with invalid or missing signatures with HTTP 400.

### Rule 4: Ensure Idempotent Webhook Processing
Webhooks can be retried up to 5 times with exponential backoff on network failures.
- Store processed `event.id` values or check if `order.status === 'PAID'` before executing fulfillment transitions.
- Return HTTP 200 immediately for duplicate events to acknowledge receipt.

### Rule 5: Handle `payment.rejected`, Customer Retries, and `payment.reopened`
When the owner rejects an incorrect TrxID:
- Update the order state to `PAYMENT_REJECTED`.
- Direct the customer back to your storefront's own order/checkout page (e.g. `/orders/${event.data.external_order_id}`) where they can resubmit a corrected TrxID for `event.data.id` via `SMPGCheckout` (up to 3 attempts within 24 hours).
- If the owner later reopens the payment in Telegram (`/reopen`), SMPG sends `payment.reopened` — transition the order back to `AWAITING_VERIFICATION`.

### Rule 6: COD Orders Are Confirmed Immediately
When a customer selects Cash on Delivery:
- SMPG transitions the payment directly to `CONFIRMED`.
- The webhook event sent is `payment.confirmed`.
- Update your local order to `CONFIRMED_COD` and proceed directly with fulfillment.

---

## 3. Integration Patterns

### Pattern A: Browser-Direct Embedded Checkout Box (Recommended)
Keeps the customer entirely on your storefront without proxying TrxID submissions through your backend.
1. Storefront backend calls `smpg.payments.create(...)` and returns `{ orderId, paymentId: payment.id }` to the frontend.
2. Frontend uses `SMPGCheckout` (browser-safe; requires **no** secret API key, requires `baseUrl`):
   - `checkout.getSession(paymentId)`: gets store name, amount, available methods, and current status.
   - `checkout.selectMethod(paymentId, 'bkash')`: returns the dynamically assigned personal wallet number (or confirms COD immediately).
   - `checkout.submit(paymentId, { trx_id, sender_number })`: submits customer TrxID directly to SMPG Core.
3. Owner verifies funds in Telegram -> SMPG sends signed webhook (`x-smpg-signature`) to your server -> Server fulfills order.

### Pattern B: Server-Proxied Headless Checkout
If you prefer all browser traffic to go through your own storefront API:
1. Storefront backend calls `smpg.payments.create(...)`.
2. When the customer picks a method, your backend calls `smpg.payments.selectMethod(paymentId, method)` and returns `assigned_wallet`.
3. When the customer submits their TrxID, your backend calls `smpg.payments.submit(paymentId, { trx_id, sender_number })`.
4. Owner verifies funds in Telegram -> SMPG sends signed webhook to your server -> Server fulfills order.

---

## 4. Official SDK Usage (Node.js / Bun / Browser)

Install the zero-dependency SDK:
```bash
npm install send-money-payment-gateway
# or
bun add send-money-payment-gateway
# or
pnpm add send-money-payment-gateway
```

### Environment Variables & Retrieving Credentials

Get all server credentials in one tap from your private Telegram bot: **`/stores` -> select your store -> `View Server Credentials`** (every value is tap-to-copy, plus a ready-to-paste `.env` block):

```env
# Server-only (NEVER expose to browser)
SMPG_CORE_URL="https://smpg-core.<subdomain>.workers.dev"   # Root Worker origin ONLY (no /v1 or /v1/payments suffix!)
SMPG_SECRET_KEY="smpg_live_..."                              # Or smpg_test_... for test mode
SMPG_WEBHOOK_SECRET="whsec_..."

# Public (safe for browser-side SMPGCheckout)
NEXT_PUBLIC_SMPG_CORE_URL="https://smpg-core.<subdomain>.workers.dev"
```

### Initializing the Server Client
```typescript
import { SMPG } from 'send-money-payment-gateway';

export const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!, // Root Worker origin ONLY (e.g. https://smpg-core.<subdomain>.workers.dev — no /v1 suffix)
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
  timeoutMs: 15000,
});
```

### Creating Payment Session (Server)
```typescript
const payment = await smpg.payments.create(
  {
    amount: 1850,                       // Positive integer in BDT
    external_order_id: 'ORD-9823',      // Your local store order ID
    method: 'bkash',                    // Optional: 'bkash' | 'nagad' | 'cod'
    customer: {
      name: 'Fahim Hasan',
      phone: '01711223344',
    },
    metadata: { cart_id: 'cart_123' },
  },
  {
    idempotencyKey: 'order_ORD-9823',   // Prevents duplicate creation
  }
);

console.log(payment.id);               // Pass to embedded checkout UI
console.log(payment.store_id);         // str_...
console.log(payment.assigned_wallet);  // { id, provider, number, label } (when method is set)
```

### Embedded Client (`SMPGCheckout` - Browser Safe)
```typescript
import { SMPGCheckout } from 'send-money-payment-gateway';

// Client-safe: uses public /c/:id/* endpoints, NO secret API key needed.
// baseUrl is REQUIRED (pass string or { baseUrl }).
const checkout = new SMPGCheckout({
  baseUrl: process.env.NEXT_PUBLIC_SMPG_CORE_URL!,
});

// 1. Load session details
const session = await checkout.getSession(paymentId);

// 2. Customer selects a payment method
const { assigned_wallet } = await checkout.selectMethod(paymentId, 'bkash');
console.log(`Send ৳${session.amount} to ${assigned_wallet.number}`);

// 3. Customer submits TrxID
const result = await checkout.submit(paymentId, {
  trx_id: '9A8B7C6D5E',
  sender_number: '01711223344',
});
console.log(result.status); // "SUBMITTED"
```

---

## 5. Webhook Verification & Handling

SMPG signs all webhook payloads with HMAC-SHA256 in the `x-smpg-signature` header:
`t=<timestamp_seconds>,v1=<signature_hex>`

The signature is computed over: `${timestamp}.${rawBody}`

### Webhook Event Types
| Event Type | Trigger | Required Action |
|------------|---------|-----------------|
| `payment.paid` | Owner approved TrxID in Telegram | Mark local order `PAID`, trigger fulfillment |
| `payment.confirmed` | Customer confirmed Cash on Delivery | Mark local order `CONFIRMED_COD`, ship parcel |
| `payment.rejected` | Owner rejected invalid TrxID | Mark order `PAYMENT_REJECTED`, direct customer to your order page to retry |
| `payment.reopened` | Owner reopened a rejected payment | Move order back to `AWAITING_VERIFICATION` |
| `payment.cancelled` | Payment was cancelled | Mark local order `CANCELLED`, release reserved inventory |
| `payment.expired` | Payment timed out without submission | Mark order `EXPIRED` |

---

## 6. Implementation Recipes by Framework

### Next.js (App Router)

#### Webhook Route: `app/api/webhooks/smpg/route.ts`
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { smpg } from '@/lib/smpg';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('x-smpg-signature');
  if (!signature) {
    return new NextResponse('Missing x-smpg-signature header', { status: 400 });
  }

  // CRUCIAL: Read raw body as text before any parsing
  const rawBody = await req.text();

  let event;
  try {
    event = await smpg.webhooks.constructEvent(rawBody, signature);
  } catch (err: any) {
    console.error('Webhook signature failed:', err.message);
    return new NextResponse(`Invalid signature: ${err.message}`, { status: 400 });
  }

  const { external_order_id, id: paymentId } = event.data;

  switch (event.type) {
    case 'payment.paid':
      // Idempotent update: only update if not already paid
      await db.order.updateMany({
        where: { id: external_order_id, status: { not: 'PAID' } },
        data: { status: 'PAID', smpgPaymentId: paymentId, paidAt: new Date() },
      });
      break;

    case 'payment.confirmed':
      await db.order.updateMany({
        where: { id: external_order_id, status: { not: 'CONFIRMED_COD' } },
        data: { status: 'CONFIRMED_COD', smpgPaymentId: paymentId },
      });
      break;

    case 'payment.rejected':
      await db.order.update({
        where: { id: external_order_id },
        data: { status: 'PAYMENT_REJECTED' },
      });
      // Optionally notify customer with link to /orders/${external_order_id} to resubmit TrxID
      break;

    case 'payment.reopened':
      await db.order.update({
        where: { id: external_order_id },
        data: { status: 'AWAITING_VERIFICATION' },
      });
      break;
  }

  return NextResponse.json({ received: true });
}
```

#### Checkout API Route: `app/api/checkout/route.ts`
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { smpg } from '@/lib/smpg';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const { cartItems, customerInfo } = await req.json();

  // 1. Create local order first
  const total = calculateTotal(cartItems);
  const order = await db.order.create({
    data: {
      total,
      customerName: customerInfo.name,
      customerPhone: customerInfo.phone,
      status: 'PENDING_PAYMENT',
    },
  });

  // 2. Create SMPG session
  const payment = await smpg.payments.create(
    {
      amount: order.total,
      external_order_id: order.id,
      customer: { name: customerInfo.name, phone: customerInfo.phone },
    },
    { idempotencyKey: order.id }
  );

  // Return paymentId so the frontend can render the embedded checkout box
  return NextResponse.json({
    orderId: order.id,
    paymentId: payment.id,
  });
}
```

---

### Express.js / Node.js

> **Important**: Configure `express.raw({ type: 'application/json' })` on the webhook route so `req.body` is a raw `Buffer`. Do NOT let `express.json()` run before signature verification!

```typescript
import express from 'express';
import { SMPG } from 'send-money-payment-gateway';

const app = express();
const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!,
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

// 1. Webhook endpoint with RAW body parsing
app.post(
  '/api/webhooks/smpg',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-smpg-signature'] as string;
    const rawBody = req.body.toString('utf-8');

    try {
      const event = await smpg.webhooks.constructEvent(rawBody, signature);

      if (event.type === 'payment.paid') {
        await fulfillOrder(event.data.external_order_id);
      } else if (event.type === 'payment.confirmed') {
        await shipCodOrder(event.data.external_order_id);
      } else if (event.type === 'payment.rejected') {
        await handlePaymentRejection(event.data.external_order_id);
      } else if (event.type === 'payment.reopened') {
        await markAwaitingVerification(event.data.external_order_id);
      }

      return res.status(200).json({ received: true });
    } catch (err: any) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }
  }
);

// 2. Normal JSON parser for all subsequent endpoints
app.use(express.json());

app.post('/api/checkout', async (req, res) => {
  const { amount, orderId, customer } = req.body;
  const payment = await smpg.payments.create(
    {
      amount,
      external_order_id: orderId,
      customer,
    },
    { idempotencyKey: orderId }
  );
  return res.json({ paymentId: payment.id });
});
```

---

### Python (FastAPI)

For projects written in Python, verify the `x-smpg-signature` header using standard library `hmac` and `hashlib`:

```python
import hmac
import hashlib
import time
from fastapi import FastAPI, Request, HTTPException, Header

app = FastAPI()
WEBHOOK_SECRET = "your_smpg_webhook_secret"

def verify_smpg_signature(raw_body: bytes, signature_header: str, secret: str, tolerance: int = 300):
    if not signature_header:
        raise HTTPException(status_code=400, detail="Missing x-smpg-signature header")

    parts = dict(item.split("=") for item in signature_header.split(","))
    timestamp = int(parts.get("t", 0))
    signature = parts.get("v1", "")

    if abs(int(time.time()) - timestamp) > tolerance:
        raise HTTPException(status_code=400, detail="Timestamp out of tolerance")

    signed_payload = f"{timestamp}.".encode("utf-8") + raw_body
    computed = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed, signature):
        raise HTTPException(status_code=400, detail="Invalid signature")

@app.post("/api/webhooks/smpg")
async def smpg_webhook(request: Request, x_smpg_signature: str = Header(None, alias="x-smpg-signature")):
    raw_body = await request.body()
    verify_smpg_signature(raw_body, x_smpg_signature, WEBHOOK_SECRET)

    event = await request.json()
    event_type = event.get("type")
    data = event.get("data", {})
    order_id = data.get("external_order_id")

    if event_type == "payment.paid":
        mark_order_paid(order_id)
    elif event_type == "payment.confirmed":
        mark_order_cod_confirmed(order_id)
    elif event_type == "payment.rejected":
        mark_order_rejected(order_id)
    elif event_type == "payment.reopened":
        mark_order_awaiting_verification(order_id)

    return {"received": True}
```

---

### PHP (Laravel)

```php
namespace App\Http\Controllers;

use Illuminate\Http\Request;

class SmpgWebhookController extends Controller
{
    public function handle(Request $request)
    {
        $signatureHeader = $request->header('x-smpg-signature');
        $rawBody = $request->getContent(); // Get unparsed raw string
        $secret = config('services.smpg.webhook_secret');

        if (!$signatureHeader) {
            return response('Missing x-smpg-signature header', 400);
        }

        // Parse header t=...,v1=...
        parse_str(str_replace(',', '&', $signatureHeader), $parts);
        $timestamp = (int) ($parts['t'] ?? 0);
        $signature = $parts['v1'] ?? '';

        if (abs(time() - $timestamp) > 300) {
            return response('Timestamp expired', 400);
        }

        $expected = hash_hmac('sha256', "{$timestamp}.{$rawBody}", $secret);
        if (!hash_equals($expected, $signature)) {
            return response('Invalid signature', 400);
        }

        $event = json_decode($rawBody, true);
        $orderId = $event['data']['external_order_id'];

        switch ($event['type']) {
            case 'payment.paid':
                Order::where('id', $orderId)->update(['status' => 'PAID']);
                break;
            case 'payment.confirmed':
                Order::where('id', $orderId)->update(['status' => 'CONFIRMED_COD']);
                break;
            case 'payment.rejected':
                Order::where('id', $orderId)->update(['status' => 'PAYMENT_REJECTED']);
                break;
            case 'payment.reopened':
                Order::where('id', $orderId)->update(['status' => 'AWAITING_VERIFICATION']);
                break;
        }

        return response()->json(['received' => true]);
    }
}
```

---

## 7. Embedded Checkout UI Component (React / Next.js)

Render an in-page custom checkout widget using `SMPGCheckout` (see also `examples/react/SMPGCheckoutBox.tsx`):

```tsx
'use client';

import React, { useEffect, useState } from 'react';
import { SMPGCheckout, CheckoutSessionData, AssignedWallet } from 'send-money-payment-gateway';

interface Props {
  paymentId: string;
  baseUrl: string;
  onSubmitted: (status: string) => void;
}

export function EmbeddedPaymentBox({ paymentId, baseUrl, onSubmitted }: Props) {
  const [checkout] = useState(() => new SMPGCheckout({ baseUrl }));
  const [session, setSession] = useState<CheckoutSessionData | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<'bkash' | 'nagad' | 'cod' | null>(null);
  const [wallet, setWallet] = useState<AssignedWallet | null>(null);
  const [trxId, setTrxId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkout
      .getSession(paymentId)
      .then((data) => {
        setSession(data);
        if (data.method) setSelectedMethod(data.method);
        if (data.assigned_wallet) setWallet(data.assigned_wallet);
      })
      .catch((err) => setError(err.message));
  }, [checkout, paymentId]);

  const handleSelectMethod = async (method: 'bkash' | 'nagad' | 'cod') => {
    setSelectedMethod(method);
    setError(null);
    try {
      const res = await checkout.selectMethod(paymentId, method);
      if (res.assigned_wallet) {
        setWallet(res.assigned_wallet);
      } else {
        setWallet(null);
      }
      if (method === 'cod') {
        onSubmitted('CONFIRMED');
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trxId.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await checkout.submit(paymentId, { trx_id: trxId.trim() });
      onSubmitted(res.status);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!session) return <div>Loading payment options...</div>;

  return (
    <div className="p-4 border rounded-lg max-w-md bg-white shadow-sm">
      <h3 className="font-semibold text-lg mb-1">{session.store.name}</h3>
      <p className="text-sm text-gray-600 mb-3">Amount due: ৳{session.amount}</p>

      {session.status === 'REJECTED' && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          Your previous Transaction ID was rejected. Please submit the correct ID
          ({session.attempts_remaining} attempts remaining).
        </div>
      )}

      {/* Payment Method Selector */}
      <div className="flex gap-2 mb-4">
        {session.available_methods.map((method) => (
          <button
            key={method}
            type="button"
            className={`px-4 py-2 rounded border font-medium ${
              selectedMethod === method ? 'bg-black text-white' : 'bg-gray-100 text-gray-800'
            }`}
            onClick={() => handleSelectMethod(method)}
          >
            {method.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Instructions & TrxID Input for bKash / Nagad */}
      {wallet && (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900">
            <p className="font-semibold">Send Money Instructions:</p>
            <p>1. Open your {wallet.provider.toUpperCase()} app.</p>
            <p>
              2. Send <strong>৳{session.amount}</strong> to <strong>{wallet.number}</strong>
              {wallet.label ? ` (${wallet.label})` : ''}.
            </p>
            <p>3. Copy the Transaction ID and paste it below.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {wallet.provider === 'nagad' ? 'Transaction ID (TxnID)' : 'Transaction ID (TrxID)'}
            </label>
            <input
              type="text"
              required
              value={trxId}
              onChange={(e) => setTrxId(e.target.value)}
              placeholder="e.g. 9A8B7C6D5E"
              className="w-full px-3 py-2 border rounded font-mono uppercase focus:ring-2 focus:ring-black"
            />
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2 bg-emerald-600 text-white font-medium rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit Payment'}
          </button>
        </form>
      )}
    </div>
  );
}
```

---

## 8. Testing & Development Guidelines

1. **Test Mode Simulation**:
   - Use test API keys (`smpg_test_...`) to create test sessions.
   - Payments created in test mode are flagged with `mode: 'test'`.
   - Use the `/test` command in your private Telegram bot to simulate bKash/Nagad/COD submissions and webhook triggers without sending real money.
2. **Local Webhook Testing**:
   - Use [ngrok](https://ngrok.com) or Cloudflare Tunnel to expose your local storefront:
     `ngrok http 3000`
   - Set your store's webhook URL in Telegram (`/stores` -> select store -> Webhook URL) to `https://<your-subdomain>.ngrok-free.app/api/webhooks/smpg`.
3. **Common Pitfalls to Avoid**:
   - **Never append `/v1` or `/v1/payments` to `SMPG_CORE_URL` / `baseUrl`**: Pass ONLY the root Worker origin (e.g. `https://smpg-core.<subdomain>.workers.dev`). Appending `/v1` or `/v1/payments` causes `404 Not Found` on older SDK versions when the SDK appends `/v1/payments`.
   - Never compute HMAC on `JSON.stringify(req.body)`. Always use raw unparsed bytes/string.
   - Never read `smpg-signature`; the header is `x-smpg-signature`.
   - Never mark an order `PAID` when `checkout.submit()` resolves. Wait for the `payment.paid` webhook.
   - Never ignore `payment.rejected` or `payment.reopened` events.
   - Never assume webhooks arrive only once. Always enforce database idempotency.

---

## 9. Integration Acceptance Checklist

Before considering an SMPG integration task complete, verify the following:

- [ ] Local order record is created in database before initiating SMPG payment session.
- [ ] `external_order_id` in SMPG payment matches local order record ID.
- [ ] Client checkout UI shows "Payment Awaiting Verification" after TrxID submission and does **NOT** update DB to `PAID`.
- [ ] Webhook route reads `x-smpg-signature` and verifies against the raw, unparsed request body string/buffer.
- [ ] Webhook signature verification fails with HTTP 400 when tested with tampered or unsigned payloads.
- [ ] Webhook route handles `payment.paid` idempotently (ignores duplicate events).
- [ ] Webhook route handles `payment.confirmed` for Cash on Delivery.
- [ ] Webhook route handles `payment.rejected` (allows customer to retry on the storefront order page) and `payment.reopened`.
- [ ] Environment variables configured: `SMPG_SECRET_KEY`, `SMPG_CORE_URL` (root Worker origin without `/v1`), `SMPG_WEBHOOK_SECRET`, and (if using `SMPGCheckout`) `NEXT_PUBLIC_SMPG_CORE_URL`.
