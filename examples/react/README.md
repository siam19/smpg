# React / Next.js Embedded Checkout Example

`SMPGCheckoutBox.tsx` is a self-contained, dependency-free React component that embeds a native **bKash / Nagad / Cash on Delivery** checkout box directly inside your React or Next.js storefront using the browser-safe `SMPGCheckout` client from `send-money-payment-gateway`.

## What It Demonstrates

- **Method selection**: Lets the customer pick between `bKash`, `Nagad`, and `Cash on Delivery`.
- **Assigned wallet display**: Shows the rotated SIM wallet number with a 1-click **Copy** button and exact BDT amount.
- **TrxID submission**: Submits the customer's Transaction ID (and optional sender phone) directly to your self-hosted SMPG Worker (`/c/:id/submit`) with no API key exposed to the browser.
- **Live verification & retry**: Polls `/c/:id/status` while awaiting Telegram approval and automatically switches to an inline retry form if the payment is rejected (`attempts_remaining > 0`).

## Usage (Next.js App Router)

### 1. Install the SDK

```bash
bun add send-money-payment-gateway
```

Copy `SMPGCheckoutBox.tsx` into your project (e.g. `components/SMPGCheckoutBox.tsx`).

### 2. Create the Payment Session on Your Server

Always create your local order first and pass its ID as `external_order_id`:

```typescript
// app/api/checkout/route.ts
import { NextResponse } from 'next/server';
import { SMPG } from 'send-money-payment-gateway';

const smpg = new SMPG(process.env.SMPG_API_KEY!, {
  baseUrl: process.env.SMPG_BASE_URL!, // Your self-hosted Worker URL
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

export async function POST(req: Request) {
  const { orderId, amount, customer } = await req.json();

  const payment = await smpg.payments.create({
    amount,
    external_order_id: orderId,
    customer,
  });

  return NextResponse.json({ paymentId: payment.id });
}
```

### 3. Render `<SMPGCheckoutBox />` in Your Checkout Page

```tsx
// app/checkout/[orderId]/page.tsx
'use client';

import { SMPGCheckoutBox } from '@/components/SMPGCheckoutBox';

export default function CheckoutPage({ paymentId }: { paymentId: string }) {
  return (
    <SMPGCheckoutBox
      paymentId={paymentId}
      baseUrl={process.env.NEXT_PUBLIC_SMPG_URL!}
      onSuccess={(result) => {
        console.log('Submitted / confirmed:', result);
      }}
    />
  );
}
```

### 4. Verify Webhooks on Your Server (`x-smpg-signature`)

Never mark an order as `PAID` on the client. Wait for your server webhook to verify `x-smpg-signature` against the raw request body:

```typescript
// app/api/webhooks/smpg/route.ts
import { SMPG } from 'send-money-payment-gateway';

const smpg = new SMPG(process.env.SMPG_API_KEY!, {
  baseUrl: process.env.SMPG_BASE_URL!,
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET!,
});

export async function POST(req: Request) {
  const signature = req.headers.get('x-smpg-signature');
  if (!signature) return new Response('Missing x-smpg-signature header', { status: 400 });

  const rawBody = await req.text();
  const event = await smpg.webhooks.constructEvent(rawBody, signature);

  switch (event.type) {
    case 'payment.paid':
      // Mark order PAID and fulfill
      break;
    case 'payment.confirmed':
      // Mark COD order CONFIRMED_COD and ship
      break;
    case 'payment.rejected':
      // Mark order PAYMENT_REJECTED and link customer to /orders/${event.data.external_order_id}
      break;
    case 'payment.reopened':
      // Move order back to AWAITING_VERIFICATION
      break;
  }

  return new Response('OK', { status: 200 });
}
```
