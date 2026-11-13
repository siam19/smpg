# SMPG (Send Money Payment Gateway)

A hybrid, multi-tenant payment gateway designed to solve the high barrier-to-entry for merchants accepting **bKash**, **Nagad**, and **Cash on Delivery (COD)** payments in Bangladesh. Instead of requiring trade licenses and corporate merchant bank accounts, SMPG leverages personal "Send Money" transactions with a human-in-the-loop Telegram verification system.

---

## Key Features

* **Dashboard-less Merchant Management**: Merchants onboard and manage everything directly inside Telegram (`/start`, wallet rotation, branding, test/live API keys).
* **One-Tap Telegram Verification**: Merchants receive real-time notification cards with inline **[Approve]** and **[Reject]** buttons featuring a 90-second Undo window and `/reopen` capabilities.
* **Optimistic & Asynchronous Customer Flow**: Customers submit their TrxID/TxnID on the hosted checkout, immediately see a confirmation screen, and return to the merchant's store. No waiting on processing spinners.
* **Multiple Wallet Rotation**: Automatically balances daily personal limits (~৳25,000/day) across multiple merchant bKash and Nagad numbers.
* **Zero-Dependency NPM SDK (`send-money-payment-gateway`)**: Edge-ready client library using standard `fetch` and Web Crypto (`crypto.subtle`) for Next.js, SvelteKit, Cloudflare Workers, Node 18+, Bun, and Deno.
* **Cryptographically Signed Webhooks**: HMAC-SHA256 signed events (`x-smpg-signature`) with exponential backoff retries.

---

## Monorepo Architecture

```text
smpg/
├── apps/
│   ├── core/           # Cloudflare Worker (REST API, D1 SQLite, R2, Telegram Webhook, Cron)
│   └── checkout/       # SvelteKit + Tailwind CSS hosted checkout application
├── packages/
│   └── sdk/            # send-money-payment-gateway NPM package
└── docs/               # OpenAPI spec, architecture plans, and sprint logs
```

---

## Quick Start (Local Development)

### Prerequisites

* [Bun](https://bun.sh) (v1.2+)
* [Cloudflare Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Setup

```bash
# 1. Install all dependencies
bun install

# 2. Run database migrations locally (Cloudflare D1)
cd apps/core
bun run d1:migrate:local
cd ../..

# 3. Build SDK and packages
bun run build

# 4. Typecheck all workspaces
bun run typecheck

# 5. Run SDK test suite
bun test
```


## License

MIT
