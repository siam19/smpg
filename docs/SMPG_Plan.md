# SMPG: Send Money Payment Gateway: Architecture Plan (v4 - Self-Hosted Single-Owner)

> Audience: the maintainer **and coding agents**. This plan reflects the Sprint 7 architectural pivot to a **self-hosted, single-owner, multi-store Cloudflare Worker + D1** gateway with embedded custom checkout UIs.

---

## 0. Decisions log

| Topic | Decision |
|---|---|
| Payment methods | Cash on Delivery (COD), bKash Send Money, Nagad Send Money |
| Hosting model | Open source, **self-hosted on Cloudflare Workers + D1** (`apps/core` only). Free tier, **no Cloudflare R2** (no credit card required). |
| Tenancy | **Single-owner, multi-store.** Each deployer owns one private Telegram bot locked via `OWNER_TELEGRAM_ID` or one-time `/start <SETUP_TOKEN>` claim, and can manage multiple stores from it. |
| Checkout UI | **Embedded custom checkout** inside the storefront using `SMPG` (server) or `SMPGCheckout` (browser-safe `/c/:id/*` endpoints). No separate hosted checkout worker (`apps/checkout` removed). |
| Customer experience | **Optimistic and asynchronous.** After submitting a TrxID/TxnID in the storefront's checkout UI, the customer sees "Awaiting Verification". Verification happens later in Telegram. |
| Undo window | **90 seconds** for owner decisions; `/reopen` ships in v1. |
| Telegram bot copy | English only, **zero emojis** across all cards, buttons, menus, and alerts. |
| Wallet numbers | Owner adds **multiple bKash and Nagad personal numbers** (shared across all stores by default, or scoped to one store), rotated automatically under the ~৳25,000/day per-SIM cap aggregated across all stores. |
| Webhook header | Standardised to `x-smpg-signature` (`t=<unix>,v1=<hex_hmac>`). |
| COD advance payment | Deferred (not v1); schema hook kept (`parent_payment_id`). |
| Couriers | Future milestone: Steadfast, Pathao, Carrybee via webhooks only. |

---

## 1. Goal

Let any merchant in Bangladesh self-host a private payment gateway for **COD**, **bKash Send Money**, and **Nagad Send Money** across one or more custom websites with no trade license, no corporate bank account, no central server, and no web dashboard. The owner manages everything from their private Telegram bot, and developers (or coding agents) embed checkout UIs directly into storefronts with a zero-dependency SDK.

### Design principles
1. **One payment object, three methods.** Same API, states, webhooks and SDK calls; only `method` differs.
2. **Async by default.** Customers are never blocked on a human. The storefront owns the "payment is being verified" experience; SMPG tells it when the outcome changes via signed webhooks.
3. **Agent-first DX.** Few concepts, predictable names, copy-pasteable recipes, a test mode, machine-readable docs (OpenAPI + `llms.txt`).
4. **Zero-dependency, edge-native.** Single Cloudflare Worker + D1 core (no R2). The SDK uses only `fetch` and Web Crypto, running on Workers, Vercel (Node and Edge), Deno, Bun, and browsers.
5. **Single-owner privacy.** No public tenant signup, no KYC storage, no shared database.

---

## 2. System overview

```
 Customer ──► Storefront (Next.js / Hono / Laravel / any)
                 │  smpg.payments.create()              ▲ signed webhooks (x-smpg-signature)
                 │  SMPGCheckout (/c/:id/*)             │
                 ▼                                      │
          ┌───────────── SMPG Core (Cloudflare Worker + D1) ─────────────┐
          │ REST API (/v1/*) │ Public Checkout API (/c/*) │ Telegram Bot │
          │ Wallet Rotation  │ Webhook Dispatcher         │ 1-min Cron   │
          └─────────────────────────────────┬────────────────────────────┘
                                            │
                                   Owner on Telegram
                                [Approve] [Reject] [Undo]
```

### Components (monorepo)
| Package | Purpose |
|---|---|
| `apps/core` | Single Cloudflare Worker: REST API, public `/c/:id/*` checkout endpoints, single-owner multi-store Telegram bot, webhook dispatcher, 1-minute cron |
| `packages/sdk` | NPM `send-money-payment-gateway`: typed server client (`SMPG`), browser-safe client (`SMPGCheckout`), and HMAC webhook verifier |
| `examples/storefront` | Reference Hono storefront with embedded checkout UI, `x-smpg-signature` webhook verification, and tests |
| `examples/react` | Drop-in React/Next.js embedded checkout component (`SMPGCheckoutBox.tsx`) |
| `scripts/setup.ts` | 1-command interactive self-hosted setup & deploy CLI (`bun run setup`) |
| `docs/` | `openapi.yaml`, `llms.txt`, `llms-full.txt`, sprint logs |
| `skills/` | AI coding agent integration skill (`SKILL.md`) |

---

## 3. Customer experience (embedded async model)

1. Storefront creates a local order (`PENDING_PAYMENT`) and calls `smpg.payments.create({ amount, external_order_id })`.
2. Storefront renders its own embedded checkout UI using `SMPGCheckout` (or proxies through its backend):
   - **COD:** selecting `cod` transitions immediately to `CONFIRMED` and queues the `payment.confirmed` webhook.
   - **bKash/Nagad:** selecting a method assigns an eligible wallet number; the UI shows the number, exact `৳` amount, copy button, and TrxID/TxnID input. Submitting transitions the payment to `SUBMITTED`.
3. Owner verifies the TrxID in their wallet app and taps **Approve** or **Reject** in Telegram (or replies `"ok"` / `"y"`).
4. After the 90-second Undo window, SMPG finalizes the decision and delivers a signed webhook (`payment.paid` or `payment.rejected`).
5. On `payment.rejected`, the storefront directs the customer back to its own order/checkout page to resubmit a corrected TrxID (up to 3 attempts).

---

## 4. Payment state machine

```
 bKash / Nagad
 CREATED ──customer submits──► SUBMITTED ──Approve (90s)──► PAID
    │                              │ └────Reject (90s)────► REJECTED ──resubmit (<=3)──► SUBMITTED
    │                              │                            └────/reopen (7d)──────► SUBMITTED
    │                              └──72 h without decision──► EXPIRED
    ├──60 min without submission──► EXPIRED (late submission accepted for 24 h)
    └──cancel──► CANCELLED

 COD
 CREATED ──select COD──► CONFIRMED ──manual/future courier──► PAID
    └──cancel──► CANCELLED
```

- Every transition writes a `payment_events` audit row.
- Stale `CREATED` payments are expired automatically by the 1-minute cron to release reserved wallet capacity.
- When the 90-second undo window closes, the Telegram notification card is finalized via `payment.telegram_message_id` (removing the Undo button) and the normalized snake_case webhook payload is dispatched.

---

## 5. Data model (D1 — `0001_initial_schema.sql`)

- `bot_config(id, owner_telegram_chat_id, rotation_strategy, created_at, updated_at)`
- `stores(id [str_...], name, cod_enabled, webhook_url, webhook_secret, paused, created_at)`
- `wallets(id [wal_...], store_id [nullable], provider, number, label, daily_limit, priority, active, created_at, UNIQUE(provider, number))`
- `api_keys(id, store_id, key_hash, prefix, mode, revoked_at, created_at)`
- `payments(id [pay_...], store_id, mode, external_order_id, method, wallet_id, amount, status, trx_id, sender_number, customer_name, customer_phone, parent_payment_id, verification_method, success_url, cancel_url, metadata, telegram_message_id, idempotency_key, attempts, pending_decision, decision_actor, decision_effective_at, late_submission, expires_at, created_at, updated_at)`
- `trx_submissions(id, payment_id, method, trx_id, sender_number, outcome, mode, created_at)` with `UNIQUE(method, trx_id) WHERE mode='live'`
- `payment_events(id, payment_id, from_status, to_status, actor, note, created_at)`
- `webhook_deliveries(id, payment_id, store_id, event_type, payload, attempt, next_attempt_at, last_status, delivered_at)`

---

## 6. Telegram bot (single-owner, multi-store, zero emojis)

- **Access control**: Only `OWNER_TELEGRAM_ID` or the account that claimed `bot_config.owner_telegram_chat_id` via `/start <SETUP_TOKEN>` can interact with the bot. All other users are rejected immediately.
- **Zero emojis**: Every card, button, menu, and alert uses clean plain text without emojis.
- **Commands**:
  - `/start [setup_token]` — Claim ownership (first time) and open main menu / create first store.
  - `/stores` — Manage stores (create, rename, COD toggle, webhook URL + test ping, pause/resume, API keys & webhook secret, delete).
  - `/wallets` — Manage personal bKash/Nagad SIMs (shared across all stores or scoped to one store, daily Asia/Dhaka usage vs cap, rotation strategy `balanced` / `fill_first`).
  - `/payments` — Recent payments labeled by store name.
  - `/reopen <payment_id>` — Reopen a rejected payment within 7 days (emits `payment.reopened`).
  - `/test` — Simulate bKash/Nagad/COD submissions for a selected store.
  - `/help` — Command list.

---

## 7. Outbound webhooks

- Header: `x-smpg-signature: t=<unix_seconds>,v1=<hex_hmac>` (`HMAC-SHA256(webhook_secret, "<t>.<rawBody>")`).
- Payload: `{ id, type, created, data: <normalized snake_case Payment> }`.
- Events: `payment.created`, `payment.submitted`, `payment.confirmed`, `payment.paid`, `payment.rejected`, `payment.reopened`, `payment.expired`, `payment.cancelled`.
- Retries with exponential backoff (up to 5 attempts); owner alerted in Telegram after repeated failures.

---

## 8. Self-hosted deployment (1 command)

No central instance, no Cloudflare R2, and no custom domain are required:

```bash
git clone https://github.com/siam19/smpg.git
cd smpg
bun install
bun run setup
```

`scripts/setup.ts` verifies Wrangler auth, validates your `@BotFather` token via `getMe`, provisions D1, writes `apps/core/wrangler.toml`, applies remote migrations, generates and uploads `ENCRYPTION_KEY`, `TELEGRAM_WEBHOOK_SECRET`, `BOT_INFO`, and `OWNER_TELEGRAM_ID` / `SETUP_TOKEN`, deploys `apps/core`, and registers the Telegram webhook automatically.
