---
name: smpg-integration
description: |
  Comprehensive integration guide and instructions for AI coding agents to integrate SMPG
  (Send Money Payment Gateway) into any e-commerce storefront or web application.
  Supports Next.js, Express, Hono, Remix, React, Python (FastAPI/Flask), PHP (Laravel),
  and any REST/webhook environment. Covers hosted checkout, embedded custom checkout boxes,
  and raw-body HMAC webhook verification.
---

# SMPG Integration Skill (Send Money Payment Gateway)

> **Role & Purpose**: You are an expert software engineer integrating **SMPG (Send Money Payment Gateway)** into an e-commerce storefront or application. Follow these instructions strictly to ensure resilient, fraud-proof payment processing.

---

## 1. Overview & Core Architecture

SMPG enables merchants in Bangladesh to accept **bKash Personal Send Money**, **Nagad Personal Send Money**, and **Cash on Delivery (COD)** without requiring commercial merchant accounts or paying transaction fee percentages.

### Key Architectural Tenets:
1. **Dynamic Wallet Rotation**: The gateway automatically balances incoming payments across the merchant's configured personal numbers to prevent hitting daily limits (BDT 25,000/day per personal SIM).
2. **Asynchronous Verification**: Customers send money and submit their Transaction ID (TrxID). The merchant reviews the payment inside their private Telegram bot and clicks **Approve** or **Reject** (or replies `"ok"` / `"y"` directly from notification badges).
3. **90-Second Undo Window**: Any accidental click by the merchant can be undone within 90 seconds before the state is permanently committed and webhooks fire.
4. **Strict Webhook-Driven Fulfillment**: Customer redirect to `success_url` happens optimistically when the TrxID is submitted. The storefront database must **NEVER** mark an order as `PAID` upon redirect; orders are only marked `PAID` when a cryptographically signed webhook arrives.

---

## 2. The 6 Non-Negotiable Golden Rules

Every AI coding agent integrating SMPG must adhere to these 6 golden rules:

### Rule 1: Create Local Order BEFORE Creating Payment Session
Always persist the order record in your local database with status `PENDING_PAYMENT` *before* invoking SMPG. Pass your local order identifier as `external_order_id`:
```typescript
const order = await db.orders.create({ total: 1850, status: 'PENDING_PAYMENT' });

const payment = await smpg.payments.create({
  amount: order.total,
  external_order_id: order.id,
  success_url: `https://mystore.com/orders/${order.id}/thanks`,
  cancel_url: `https://mystore.com/cart`,
});
```

### Rule 2: NEVER Mark Orders as "PAID" on Redirect
When the customer lands on `success_url`, they have only submitted their TrxID. The merchant has **NOT** verified the funds yet.
- Prepaid orders (bKash/Nagad) must be set to `AWAITING_VERIFICATION` or `PAYMENT_PENDING`.
- Show a message: *"Payment received! We are verifying your transaction with the provider."*
- **NEVER** update order status to `PAID` based on redirect query parameters or URL hits.

### Rule 3: Verify Webhooks on UNTOUCHED RAW Request Bodies
Webhook signatures use HMAC-SHA256 (`SMPG-Signature: t=<timestamp>,v1=<hex>`).
- Always pass the raw, unparsed string or Buffer to `smpg.webhooks.constructEvent(rawBody, signatureHeader)`.
- Never verify re-serialized JSON (e.g. `JSON.stringify(req.body)`), as altered whitespace or key ordering will invalidate the signature.
- Reject requests with invalid or missing signatures with HTTP 400.

### Rule 4: Ensure Idempotent Webhook Processing
Webhooks can be retried up to 5 times with exponential backoff on network failures.
- Store processed `event.id` values or check if `order.status === 'PAID'` before executing fulfillment transitions.
- Return HTTP 200 immediately for duplicate events to acknowledge receipt.

### Rule 5: Handle `payment.rejected` and Customer Retries
When a seller rejects an incorrect TrxID:
- The webhook event `payment.rejected` includes `event.data.retry_url`.
- Update the order state to `PAYMENT_REJECTED`.
- Send an SMS/Email or display the `retry_url` so the customer can submit their correct TrxID (up to 3 attempts within 24 hours).

### Rule 6: COD Orders Are Confirmed Immediately
When a customer selects Cash on Delivery:
- SMPG transitions the payment directly to `CONFIRMED`.
- The webhook event sent is `payment.confirmed`.
- Update your local order to `CONFIRMED_COD` and proceed directly with fulfillment.

---

## 3. Integration Patterns

Choose the pattern that matches the user's requirements:

### Pattern A: Hosted Checkout (Redirect Flow)
Simplest flow. The customer is redirected to SMPG's hosted checkout page (`payment.checkout_url`), where they select a method, see payment instructions, and enter their TrxID.
1. Backend calls `smpg.payments.create(...)`.
2. Backend redirects customer to `payment.checkout_url`.
3. Customer submits TrxID; SMPG redirects customer back to `payment.success_url`.
4. Merchant verifies funds in Telegram -> SMPG sends signed webhook to your server -> Server fulfills order.

### Pattern B: Embedded / Custom Checkout Box (In-Page Flow)
Keeps the customer entirely on the merchant's checkout page without any redirects.
1. Backend calls `smpg.payments.create(...)` and returns `payment.id` to the frontend.
2. Frontend uses `SMPGCheckout` (safe for browser; requires **no** secret API key):
   - `checkout.getSession()`: gets store branding, amount, available methods.
   - `checkout.selectMethod('bkash')`: returns the dynamically assigned wallet number to send money to.
   - `checkout.submit({ trx_id })`: submits customer TrxID directly.
3. Merchant verifies funds in Telegram -> SMPG sends signed webhook to your server -> Server fulfills order.

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

### Initializing the Server Client
```typescript
import { SMPG } from 'send-money-payment-gateway';

export const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!, // e.g. https://smpg-core.your-domain.workers.dev
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
  timeoutMs: 15000,
});
```

### Creating Payment Session (Server)
```typescript
const payment = await smpg.payments.create({
  amount: 1850,                       // Positive integer in BDT
  external_order_id: 'ORD-9823',       // Your local store order ID
  method: 'bkash',                     // Optional: 'bkash' | 'nagad' | 'cod' (or omit to let user pick)
  customer: {
    name: 'Fahim Hasan',
    phone: '01711223344',
  },
  success_url: 'https://store.com/orders/ORD-9823/thanks',
  cancel_url: 'https://store.com/cart',
  metadata: { cart_id: 'cart_123' },
}, {
  idempotencyKey: 'order_ORD-9823',     // Prevents duplicate charges
});

console.log(payment.checkout_url);     // Hosted checkout link
console.log(payment.assigned_wallet);  // { id, provider, number, label }
```

### Embedded Client (`SMPGCheckout` - Browser Safe)
```typescript
import { SMPGCheckout } from 'send-money-payment-gateway';

// Client-safe: uses public customer endpoints, NO secret API key needed
const checkout = new SMPGCheckout(paymentId, {
  baseUrl: 'https://smpg-core.your-domain.workers.dev',
});

// 1. Load session details
const session = await checkout.getSession();

// 2. Customer selects a payment method
const { wallet } = await checkout.selectMethod('bkash');
console.log(`Send ৳${session.amount} to ${wallet.number} (${wallet.type})`);

// 3. Customer submits TrxID
const result = await checkout.submit({ trx_id: '9A8B7C6D5E' });
console.log(result.status); // "SUBMITTED"
```

---

## 5. Webhook Verification & Handling

SMPG signs all webhook payloads with HMAC-SHA256 in the `SMPG-Signature` header:
`t=<timestamp_seconds>,v1=<signature_hex>`

The signature is computed over: `${timestamp}.${rawBody}`

### Webhook Event Types
| Event Type | Trigger | Required Action |
|------------|---------|-----------------|
| `payment.paid` | Merchant approved TrxID in Telegram | Mark local order `PAID`, trigger fulfillment |
| `payment.confirmed` | Customer confirmed Cash on Delivery | Mark local order `CONFIRMED_COD`, ship parcel |
| `payment.rejected` | Merchant rejected invalid TrxID | Mark order `PAYMENT_REJECTED`, notify customer with `event.data.retry_url` |
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
  const signature = req.headers.get('smpg-signature');
  if (!signature) {
    return new NextResponse('Missing signature header', { status: 400 });
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
        data: { status: 'PAYMENT_REJECTED', retryUrl: event.data.retry_url },
      });
      // Optionally dispatch SMS/email notification to customer with retryUrl
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
    data: { total, customerName: customerInfo.name, customerPhone: customerInfo.phone, status: 'PENDING_PAYMENT' },
  });

  // 2. Create SMPG session
  const payment = await smpg.payments.create({
    amount: order.total,
    external_order_id: order.id,
    customer: { name: customerInfo.name, phone: customerInfo.phone },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/orders/${order.id}/thanks`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/cart`,
  });

  return NextResponse.json({
    orderId: order.id,
    paymentId: payment.id,
    checkoutUrl: payment.checkout_url,
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
    const signature = req.headers['smpg-signature'] as string;
    const rawBody = req.body.toString('utf-8');

    try {
      const event = await smpg.webhooks.constructEvent(rawBody, signature);

      if (event.type === 'payment.paid') {
        await fulfillOrder(event.data.external_order_id);
      } else if (event.type === 'payment.confirmed') {
        await shipCodOrder(event.data.external_order_id);
      } else if (event.type === 'payment.rejected') {
        await handlePaymentRejection(event.data.external_order_id, event.data.retry_url);
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
  const payment = await smpg.payments.create({
    amount,
    external_order_id: orderId,
    customer,
    success_url: `https://example.com/orders/${orderId}/thanks`,
    cancel_url: `https://example.com/cart`,
  });
  return res.json({ checkoutUrl: payment.checkout_url });
});
```

---

### Python (FastAPI)

For projects written in Python, verify the signature directly using standard library `hmac` and `hashlib`:

```python
import hmac
import hashlib
import time
from fastapi import FastAPI, Request, HTTPException, Header

app = FastAPI()
WEBHOOK_SECRET = "your_smpg_webhook_secret"

def verify_smpg_signature(raw_body: bytes, signature_header: str, secret: str, tolerance: int = 300):
    if not signature_header:
        raise HTTPException(status_code=400, detail="Missing signature header")

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
async def smpg_webhook(request: Request, smpg_signature: str = Header(None, alias="smpg-signature")):
    raw_body = await request.body()
    verify_smpg_signature(raw_body, smpg_signature, WEBHOOK_SECRET)
    
    event = await request.json()
    event_type = event.get("type")
    data = event.get("data", {})
    order_id = data.get("external_order_id")

    if event_type == "payment.paid":
        # Mark order PAID idempotently
        mark_order_paid(order_id)
    elif event_type == "payment.confirmed":
        mark_order_cod_confirmed(order_id)
    elif event_type == "payment.rejected":
        mark_order_rejected(order_id, data.get("retry_url"))

    return {"received": True}
```

---

### PHP (Laravel)

```php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class SmpgWebhookController extends Controller
{
    public function handle(Request $request)
    {
        $signatureHeader = $request->header('smpg-signature');
        $rawBody = $request->getContent(); // Get unparsed raw string
        $secret = config('services.smpg.webhook_secret');

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
                Order::where('id', $orderId)->update([
                    'status' => 'PAYMENT_REJECTED',
                    'retry_url' => $event['data']['retry_url']
                ]);
                break;
        }

        return response()->json(['received' => true]);
    }
}
```

---

## 7. Embedded Checkout UI Component (React / Next.js)

If building an in-page custom checkout widget using `SMPGCheckout`:

```tsx
'use client';

import React, { useEffect, useState } from 'react';
import { SMPGCheckout, CheckoutSessionData, AssignedWallet } from 'send-money-payment-gateway';

interface Props {
  paymentId: string;
  baseUrl: string;
  onSuccess: () => void;
}

export function EmbeddedPaymentBox({ paymentId, baseUrl, onSuccess }: Props) {
  const [checkout] = useState(() => new SMPGCheckout(paymentId, { baseUrl }));
  const [session, setSession] = useState<CheckoutSessionData | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<'bkash' | 'nagad' | 'cod' | null>(null);
  const [wallet, setWallet] = useState<AssignedWallet | null>(null);
  const [trxId, setTrxId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkout.getSession().then(setSession).catch(err => setError(err.message));
  }, [checkout]);

  const handleSelectMethod = async (method: 'bkash' | 'nagad' | 'cod') => {
    setSelectedMethod(method);
    setError(null);
    try {
      const res = await checkout.selectMethod(method);
      if (res.assigned_wallet) {
        setWallet(res.assigned_wallet);
      }
      if (method === 'cod') {
        onSuccess();
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
      await checkout.submit({ trx_id: trxId });
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!session) return <div>Loading payment options...</div>;

  return (
    <div className="p-4 border rounded-lg max-w-md bg-white shadow-sm">
      <h3 className="font-semibold text-lg mb-2">Pay ৳{session.amount}</h3>

      {/* Payment Method Selector */}
      <div className="flex gap-2 mb-4">
        {session.available_methods.map(method => (
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
            <p>1. Open your {wallet.provider.toUpperCase()} App.</p>
            <p>2. Send <strong>৳{session.amount}</strong> to <strong>{wallet.number}</strong> ({wallet.label}).</p>
            <p>3. Copy the TrxID and paste it below.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Transaction ID (TrxID)</label>
            <input
              type="text"
              required
              value={trxId}
              onChange={e => setTrxId(e.target.value)}
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
            {submitting ? 'Verifying...' : 'Submit Payment'}
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
   - Payments created in test mode will be clearly flagged with `mode: 'test'`.
   - In test mode, merchants can use Telegram commands like `/test` to simulate instant customer submissions and webhook triggers without sending real money.
2. **Local Webhook Testing**:
   - Use [ngrok](https://ngrok.com) or Cloudflare Tunnel to expose your local development server:
     `ngrok http 3000`
   - Set your SMPG webhook URL to `https://<your-subdomain>.ngrok-free.app/api/webhooks/smpg`.
3. **Common Pitfalls to Avoid**:
   - ❌ Never compute HMAC on `JSON.stringify(req.body)`. Always use raw unparsed bytes/string.
   - ❌ Never mark an order `PAID` because the customer arrived at `/orders/ORD-123/thanks`.
   - ❌ Never ignore `payment.rejected` events. Always save `retry_url` and let the customer resubmit.
   - ❌ Never assume webhooks arrive only once. Always enforce database idempotency.

---

## 9. Integration Acceptance Checklist

Before considering an SMPG integration task complete, verify the following:

- [ ] Local order record is created in database before initiating SMPG payment session.
- [ ] `external_order_id` in SMPG payment matches local order record ID.
- [ ] Success page displays "Payment Awaiting Verification" and does **NOT** update DB to `PAID`.
- [ ] Webhook route accesses the raw, unparsed request body string/buffer.
- [ ] Webhook signature verification fails with HTTP 400 when tested with tampered or unsigned payloads.
- [ ] Webhook route handles `payment.paid` idempotently (ignores duplicate events).
- [ ] Webhook route handles `payment.confirmed` for Cash on Delivery.
- [ ] Webhook route handles `payment.rejected` and exposes `retry_url` for customer recovery.
- [ ] Environment variables configured: `SMPG_SECRET_KEY`, `SMPG_CORE_URL`, `SMPG_WEBHOOK_SECRET`.
