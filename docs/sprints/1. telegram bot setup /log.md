# Sprint 1: Telegram Bot Setup Log

## Date: 2026-11-11

### Summary of Changes
Completed the architectural design and full implementation of the **SMPG Payments Bot** using [grammY](https://grammy.dev), TypeScript, Drizzle ORM, and Cloudflare D1 within `apps/core`.

---

### Files Added / Modified

#### Environment & Configuration
- [`.env.example`](file:///home/bast0k/projects/smpg/.env.example): Root environment variable reference.
- [`apps/core/.env.example`](file:///home/bast0k/projects/smpg/apps/core/.env.example): Complete environment template for `apps/core` including `PUBLIC_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ENCRYPTION_KEY`, and TTL configurations.
- [`apps/core/wrangler.toml`](file:///home/bast0k/projects/smpg/apps/core/wrangler.toml): Renamed R2 bucket binding to `BUCKET`.
- [`apps/core/src/types.ts`](file:///home/bast0k/projects/smpg/apps/core/src/types.ts): Updated `Env` type definition with `BUCKET: R2Bucket`.

#### Database & ORM
- [`apps/core/package.json`](file:///home/bast0k/projects/smpg/apps/core/package.json): Added `grammy`, `drizzle-orm`, and `drizzle-kit`.
- [`apps/core/src/db/schema.ts`](file:///home/bast0k/projects/smpg/apps/core/src/db/schema.ts): Type-safe Drizzle ORM schema mapping SQLite D1 tables (`merchants`, `merchant_wallets`, `api_keys`, `payments`, `trx_submissions`, `payment_events`, `webhook_deliveries`).
- [`apps/core/src/db/index.ts`](file:///home/bast0k/projects/smpg/apps/core/src/db/index.ts): Drizzle D1 client factory (`createDb`).

#### Core Services
- [`apps/core/src/services/crypto.ts`](file:///home/bast0k/projects/smpg/apps/core/src/services/crypto.ts): Standard Web Crypto utilities: AES-GCM-256 encryption/decryption, SHA-256 hashing, and random ID generators (`mrc_...`, `pay_...`, `wal_...`).
- [`apps/core/src/services/wallet.ts`](file:///home/bast0k/projects/smpg/apps/core/src/services/wallet.ts): Wallet rotation algorithms (`balanced`, `fill_first`), Asia/Dhaka daily limit boundary calculations, and capacity tracking.
- [`apps/core/src/services/notification.ts`](file:///home/bast0k/projects/smpg/apps/core/src/services/notification.ts): Dispatches Telegram cards, edits messages during grace periods, and finalizes cards.
- [`apps/core/src/services/decision.ts`](file:///home/bast0k/projects/smpg/apps/core/src/services/decision.ts): Finalizes decisions after the 90-second Undo window has passed, writes audit events, and queues outbound webhooks.

#### Telegram Bot (grammY)
- [`apps/core/src/bot/context.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/context.ts): Custom `BotContext` with `env`, `db`, and `merchant`.
- [`apps/core/src/bot/middleware/error.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/middleware/error.ts): Inbound error boundary ensuring 200 OK responses to Telegram.
- [`apps/core/src/bot/middleware/auth.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/middleware/auth.ts): Merchant chat lookup and `requireMerchant` guard.
- [`apps/core/src/bot/commands/start.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/commands/start.ts): Onboarding command generating merchant record, API keys (`smpg_live_...`, `smpg_test_...`), and encrypted webhook secrets.
- [`apps/core/src/bot/commands/wallets.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/commands/wallets.ts): `/wallets` with visual capacity progress bars, `/add_bkash`, `/add_nagad`, `/wallet_limit`, `/wallet_pause`, `/wallet_resume`, `/rotation`.
- [`apps/core/src/bot/commands/settings.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/commands/settings.ts): `/store_name`, `/brand_color`, `/cod on|off`, `/webhook` (with test ping), `/help`.
- [`apps/core/src/bot/commands/keys.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/commands/keys.ts): `/keys`, `/keys rotate live|test`, `/pause`, `/resume`.
- [`apps/core/src/bot/commands/payments.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/commands/payments.ts): `/payments` (last 10), `/reopen <payment_id>` (reopens rejected payment within 7 days).
- [`apps/core/src/bot/views/cards.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/views/cards.ts): HTML notification card formatters for bKash, Nagad, COD, and grace countdown.
- [`apps/core/src/bot/views/keyboards.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/views/keyboards.ts): Inline keyboards (`[Approve]`, `[Reject]`, `[Undo]`).
- [`apps/core/src/bot/callbacks/decision.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/callbacks/decision.ts): Atomic conditional SQL update (`pending_decision IS NULL`) initiating 90s grace window.
- [`apps/core/src/bot/callbacks/undo.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/callbacks/undo.ts): Reverts `pending_decision` and restores original action buttons.
- [`apps/core/src/bot/index.ts`](file:///home/bast0k/projects/smpg/apps/core/src/bot/index.ts): Bot factory with `botInfo` pre-caching to eliminate cold-start latency.
- [`apps/core/src/index.ts`](file:///home/bast0k/projects/smpg/apps/core/src/index.ts): Mounted `POST /v1/telegram-webhook` with `X-Telegram-Bot-Api-Secret-Token` check and connected scheduled cron handler.

#### Tests
- [`apps/core/test/crypto.test.ts`](file:///home/bast0k/projects/smpg/apps/core/test/crypto.test.ts): AES-GCM encryption/decryption, SHA-256, key generation tests.
- [`apps/core/test/wallet.test.ts`](file:///home/bast0k/projects/smpg/apps/core/test/wallet.test.ts): Asia/Dhaka day boundary tests.
- [`apps/core/test/bot.test.ts`](file:///home/bast0k/projects/smpg/apps/core/test/bot.test.ts): Webhook secret token authentication tests, card formatting assertions.

---

### Verification Results
1. `bun test`: All 9 unit tests passed across 4 test suites (88ms).
2. `bun run typecheck`: Passed across `@smpg/core`, `@smpg/checkout`, and `send-money-payment-gateway` (0 errors, 0 warnings).
3. `bun run build`: Built `@smpg/checkout` and `send-money-payment-gateway` successfully.
