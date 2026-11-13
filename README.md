# SMPG (Send Money Payment Gateway)

Accept **bKash Personal Send Money**, **Nagad Personal Send Money**, and **Cash on Delivery (COD)** on any e-commerce storefront with **0% transaction fees** and **no corporate trade license required**.

[![NPM Version](https://img.shields.io/npm/v/send-money-payment-gateway?color=blue)](https://www.npmjs.com/package/send-money-payment-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](packages/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org)

---

## Quick Start

### 1. Install the SDK

Install the official client library for your storefront or backend project:

```bash
# npm
npm install send-money-payment-gateway

# bun
bun add send-money-payment-gateway

# pnpm
pnpm add send-money-payment-gateway
```

### 2. Install the AI Coding Agent Skill

When building with AI coding assistants (such as Cursor, Claude Code, Antigravity, or Codex), install the integration skill to give agents full integration guidelines, validation rules, and multi-framework templates:

```bash
npx skills add siam19/smpg --skill smpg-integration
```

---

## Merchant Setup & API Keys

SMPG does not require commercial trade licenses, physical bank accounts, or approval waiting periods. All merchant onboarding, personal wallet configuration, and payment verification are managed through Telegram:

**Telegram Bot**: [t.me/spmg_payments_bot](https://t.me/spmg_payments_bot)

1. **Sign Up**: Open [t.me/spmg_payments_bot](https://t.me/spmg_payments_bot) and send `/start`.
2. **Configure Store**: Provide your Store Name, Support Contact, and optional Brand Color.
3. **Add Personal Wallets**: Add your bKash and Nagad personal mobile numbers. SMPG automatically rotates between them to balance volume and stay below Bangladesh Bank daily regulatory limits (BDT 25,000/day per SIM).
4. **Retrieve API Keys**: Send `/keys` to receive your API secret key (`smpg_live_...` or `smpg_test_...`) and webhook signing secret.
5. **Set Webhook URL**: Set your storefront's webhook endpoint URL (e.g., `https://mystore.com/api/webhooks/smpg`).

---

## How SMPG Works

```text
+----------+              +------------+             +-----------+          +-------------------+
| Customer |              | Storefront |             | SMPG Core |          | Merchant Telegram |
+----+-----+              +-----+------+             +-----+-----+          +---------+---------+
     |                          |                          |                          |
     |--- 1. Place Order ------>|                          |                          |
     |    (total: BDT 1,850)    |--- 2. Create Payment --->|                          |
     |                          |    (POST /v1/payments)   |                          |
     |                          |<-- Return Session URL ---|                          |
     |<-- 3. Checkout Page -----|                          |                          |
     |                          |                          |                          |
     |--- 4. Send Money via App +------------------------->|                          |
     |    and submit TrxID      |                          |--- 5. Payment Alert ---->|
     |                          |                          |    with Approve/Reject   |
     |                          |                          |                          |
     |                          |                          |<-- 6. Tap "Approve" -----|
     |                          |                          |    (or reply "ok")       |
     |                          |                          |    [90s Undo Window]     |
     |                          |                          |           |              |
     |                          |<-- 7. Signed Webhook ----|<----------+              |
     |                          |    ("payment.paid")      |                          |
     |                          |                          |                          |
     |<-- 8. Fulfill Order -----|                          |                          |
```

### Key Workflow Principles:
- **0% Cut**: Payments go directly from customer to your personal bKash/Nagad SIM.
- **Dynamic SIM Rotation**: Outgoing payments are distributed across your configured personal numbers to prevent individual wallet threshold exhaustion.
- **Telegram Verification**: When a customer submits a Transaction ID (TrxID), you receive a Telegram push notification. Check your mobile wallet statement and tap **Approve** or **Reject** (or reply directly `"ok"` / `"y"` to the notification).
- **90-Second Undo Window**: Any accidental tap can be reversed within 90 seconds before the state finalizes and webhooks fire.
- **Signed Webhook Fulfillment**: Your server only fulfills orders when a cryptographically signed HMAC-SHA256 webhook (`payment.paid` or `payment.confirmed`) arrives.

---

## Integration Examples

### 1. Server-Side: Create Payment Session
```typescript
import { SMPG } from 'send-money-payment-gateway';

const smpg = new SMPG(process.env.SMPG_SECRET_KEY!, {
  baseUrl: process.env.SMPG_CORE_URL!, // e.g. https://smpg-core.your-domain.workers.dev
  webhookSecret: process.env.SMPG_WEBHOOK_SECRET,
});

// 1. Create order in your database first with PENDING_PAYMENT status
const order = await db.orders.create({ total: 1850, status: 'PENDING_PAYMENT' });

// 2. Create SMPG session passing your local order ID
const payment = await smpg.payments.create({
  amount: order.total,
  external_order_id: order.id,
  customer: { name: 'Customer Name', phone: '017XXXXXXXX' },
  success_url: `https://yourstore.com/orders/${order.id}/thanks`,
  cancel_url: `https://yourstore.com/cart`,
});

// Redirect customer to hosted checkout:
console.log(payment.checkout_url);
```

### 2. Client-Side: Embedded Custom Checkout Box
If you prefer keeping customers on your site without redirecting, use `SMPGCheckout` (safe for browser; no secret key required):

```typescript
import { SMPGCheckout } from 'send-money-payment-gateway';

const checkout = new SMPGCheckout(payment.id, {
  baseUrl: 'https://smpg-core.your-domain.workers.dev',
});

// 1. Get session details (amount, available methods, store branding)
const session = await checkout.getSession();

// 2. Customer selects method (e.g. bkash)
const { wallet } = await checkout.selectMethod('bkash');
console.log(`Send BDT ${session.amount} to ${wallet.number} (${wallet.type})`);

// 3. Customer submits TrxID
const result = await checkout.submit({ trx_id: '9A8B7C6D5E' });
console.log(result.status); // "SUBMITTED"
```

### 3. Server-Side: Webhook Verification (Next.js / Node)
```typescript
// app/api/webhooks/smpg/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { smpg } from '@/lib/smpg';

export async function POST(req: NextRequest) {
  const signature = req.headers.get('smpg-signature');
  const rawBody = await req.text(); // Raw unparsed body required for HMAC

  try {
    const event = await smpg.webhooks.constructEvent(rawBody, signature!);

    if (event.type === 'payment.paid') {
      // Verified prepaid transaction: mark order PAID
      await fulfillOrder(event.data.external_order_id);
    } else if (event.type === 'payment.confirmed') {
      // Confirmed Cash on Delivery: ship order
      await shipOrder(event.data.external_order_id);
    } else if (event.type === 'payment.rejected') {
      // Rejected TrxID: send retry_url to customer
      await notifyCustomerRetry(event.data.external_order_id, event.data.retry_url);
    }

    return NextResponse.json({ received: true });
  } catch (err: any) {
    return new NextResponse(`Webhook error: ${err.message}`, { status: 400 });
  }
}
```

---

## Monorepo Structure

```text
smpg/
├── apps/
│   ├── core/           # Cloudflare Worker (REST API, SQLite D1, Telegram Bot, Cron)
│   └── checkout/       # SvelteKit + Tailwind CSS hosted checkout web application
├── packages/
│   └── sdk/            # send-money-payment-gateway NPM package (ESM + CJS + Types)
├── examples/
│   └── storefront/     # Reference storefront (Hono + Webhook verification + Tests)
├── skills/
│   └── smpg-integration/ # AI coding agent skill (SKILL.md)
└── docs/               # OpenAPI specification, LLM context, and sprint logs
```

---

## Local Development

### Prerequisites
* [Bun](https://bun.sh) (v1.2+)
* [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
# 1. Install dependencies
bun install

# 2. Run local database migrations
cd apps/core && bun run d1:migrate:local && cd ../..

# 3. Build SDK packages
bun run build

# 4. Run type checks
bun run typecheck

# 5. Run full test suite
bun test
```

---

## License

[MIT](LICENSE) © SMPG Contributors
