# Sprint 7: Self-Hosted Single-Owner Multi-Store Pivot

> **Status**: Completed
> **Architectural Pivot**: Transition SMPG from a centralized multi-tenant payment gateway (one shared bot + hosted checkout worker) to a **self-hosted, single-owner, multi-store Cloudflare Worker** that each user deploys with their own Telegram bot and integrates directly into their website's checkout UI.

---

## Sprint Objectives

1. **Eliminate Central Gateway Liability**: Remove all public multi-tenant registration, KYC flows, and hardcoded central deployment URLs so SMPG is pure open-source self-hosted infrastructure — zero central servers, zero shared merchant databases.
2. **Single-Owner, Multi-Store Architecture**: Lock each deployed Telegram bot strictly to its deployer/owner while enabling that owner to create and manage **multiple stores/websites** from one personal bot and shared/scoped personal SIM wallets.
3. **Clean D1 Schema**: Squash and redesign the D1 schema from scratch (`0001_initial_schema.sql`) around `bot_config`, `stores`, and `wallets`, removing multi-tenant KYC fields, unused R2/branding fields, and metadata hacks.
4. **Remove Hosted Checkout Worker (`apps/checkout`)**: Deprecate and remove the separate SvelteKit checkout worker so self-hosters deploy **only one Cloudflare Worker + D1** (free tier, no credit card required). Provide copy-pasteable embedded checkout UI examples in `examples/` instead.
5. **Streamline the Telegram Bot**: Strip out central-gateway onboarding, branding, and redundant features; add owner lock and multi-store management.
6. **1-Command Self-Deployment & Tech-Debt Cleanup**: Add an interactive setup/deploy CLI (`bun run setup`), fix known webhook/state-machine bugs, and align the SDK, OpenAPI spec, docs, and AI agent skill with the self-hosted architecture.

---

## Architectural Decisions Locked In

| Area | Decision |
|---|---|
| **Hosting Model** | **Option A — Self-Hosted Cloudflare Worker + D1** (`apps/core` only). Stack-agnostic so storefronts can run on Next.js, Laravel, Django, WooCommerce, Express, Workers, etc. |
| **Tenancy** | **Single-owner, multi-store.** One deployer owns the bot instance and can manage multiple stores (`stores` table) from it. |
| **Owner Access Control** | Bot locked via `OWNER_TELEGRAM_ID` env var OR one-time `/start <SETUP_TOKEN>` claim persisted in `bot_config`. All other Telegram users are rejected immediately. |
| **Wallets & Daily Caps** | Wallets live in an owner-level `wallets` table with optional `store_id` (`NULL` = shared across all stores, set = dedicated to one store). Daily ৳25,000 SIM cap aggregates across all payments to that `wallet_id` regardless of store. |
| **Checkout UI** | **Remove `apps/checkout`.** Storefronts render their own native checkout UI using `SMPG` (server) or `SMPGCheckout` (browser-safe `/c/:id/*` endpoints). Provide ready-to-use UI examples in `examples/`. |
| **Cloudflare R2** | **Removed.** Eliminating the unused `BUCKET` R2 binding ensures self-hosters in Bangladesh can deploy on Cloudflare's free Workers + D1 tier with **no credit card required**. |
| **Database Migrations** | **Clean squash** into a fresh `0001_initial_schema.sql` (drop legacy `0002_merchant_onboarding.sql` and `0003_nullable_payment_method.sql`). |
| **Telegram Bot Copy Style** | **Zero emojis.** Remove ALL emojis from every Telegram bot message, payment card, inline button label, menu, and alert for clean, scannable plain-text output. |

---

## Telegram Bot Feature Audit

### Remove (Central-Gateway & Hosted-Checkout Artifacts)
- **Public Stranger Signup (`bot/middleware/auth.ts`)**: Anyone sending `/start` automatically registering as a new tenant.
- **KYC Onboarding Flow (`bot/handlers/onboarding.ts`)**:
  - Full Name prompt (`owner_name`)
  - Personal Phone Number prompt (`phone_number`)
  - NID / Passport availability prompt (`can_provide_nid`, `createNidQuestionKeyboard`)
  - Multi-step KYC state machine (`onboarding_step` column)
  - `/logout`, `/reset`, and `/restart` developer test-account wipe commands
- **Hosted Checkout Branding Controls**:
  - `/brand_color` command, `settings:brand_color` button, `createBrandColorKeyboard`, and `Set Brand Color` ForceReply handler
  - `logo_key` / `/logo` references and R2 storage dependency
- **Unused / Duplicate Internals**:
  - Unused `test_mode` column on `merchants` (live vs test is determined solely by `smpg_live_` vs `smpg_test_` API key)
  - Duplicate HMAC webhook ping code in `bot/callbacks/menu.ts` (reuse `deliverWebhookPayload` from `services/webhook.ts`)

### Keep (Core Value Proposition)
- **Payment Verification Cards**: bKash (`TrxID`), Nagad (`TxnID`), late-submission badge, COD orders — now badged with the **Store Name** so multi-store owners know which store received the payment.
- **One-Tap & Direct-Reply Decisions**: Inline `[ ✅ Approve ]` / `[ ❌ Reject ]` and `[ ✅ Confirm ]` / `[ ❌ Cancel ]` buttons + direct text replies (`"ok"`, `"y"`, `"thik ache"`, `"no"`, `"fake"`, etc.).
- **90-Second Undo Grace Window**: `[ ↩ Undo ]` button + automatic finalization that edits the card to a static final badge.
- **Wallet Dashboard (`/wallets`)**: Daily Asia/Dhaka usage progress bars, Add bKash / Add Nagad, Edit Limit, Pause/Resume, Delete, Rotation Strategy toggle (`balanced` / `fill_first`).
- **Per-Store Settings & Credentials**: Store Name, COD toggle, Webhook URL + Test Ping, Store Pause/Resume kill switch, Live/Test API key rotation & webhook secret display.
- **Payments History & Recovery (`/payments`, `/reopen`)**: Recent transactions with store labels and 1-tap reopen for rejected payments (within 7 days).
- **Test Simulator (`/test`)**: Simulate bKash/Nagad/COD submissions for a store without real money.

### Add (Self-Hosted Multi-Store Essentials)
- **Owner Auth Guard & Claim Flow**:
  - Verify `ctx.chat.id` / `ctx.from.id` against `OWNER_TELEGRAM_ID` or `bot_config.owner_telegram_chat_id`.
  - Support `/start <SETUP_TOKEN>` for secure first-time claiming when `OWNER_TELEGRAM_ID` is not pre-set.
- **Stores Management Dashboard (`/stores`)**:
  - List all stores with status badges (Active/Paused, Webhook configured).
  - `[ ➕ Create Store ]` flow (asks only for Store Name → generates Live/Test API keys + Webhook Secret).
  - Tap a store to open its Store Detail view (Rename, Webhook URL, Test Ping, COD Toggle, Pause/Resume, API Keys & Secret, Delete Store).
- **Wallet-to-Store Scope (Optional)**:
  - Allow wallets to be **Shared (All Stores)** by default or assigned to a specific store.

---

## Tasks & Deliverables

### 1. Clean D1 Database Schema & Drizzle ORM (`apps/core`)
- [x] Replace `apps/core/migrations/0001_initial_schema.sql` with the squashed single-owner, multi-store schema and delete `0002_merchant_onboarding.sql` and `0003_nullable_payment_method.sql`:
  - `bot_config` (`id`, `owner_telegram_chat_id`, `rotation_strategy`, `created_at`, `updated_at`)
  - `stores` (`id` `str_xxx`, `name`, `cod_enabled`, `webhook_url`, `webhook_secret`, `paused`, `created_at`)
  - `wallets` (`id` `wal_xxx`, `store_id` nullable, `provider`, `number`, `label`, `daily_limit`, `priority`, `active`, `created_at`, `UNIQUE(provider, number)`)
  - `api_keys` (`id`, `store_id`, `key_hash`, `prefix`, `mode`, `revoked_at`, `created_at`)
  - `payments` (update `merchant_id` → `store_id`, make `method` & `success_url` nullable, add first-class `telegram_message_id` column instead of mutating `metadata` JSON)
  - `trx_submissions`, `payment_events`, `webhook_deliveries` (with `store_id`)
- [x] Rewrite `apps/core/src/db/schema.ts` and `apps/core/src/types.ts` (remove `BUCKET`, add `OWNER_TELEGRAM_ID?`, `SETUP_TOKEN?`, drop `PUBLIC_BASE_URL` requirement).
- [x] Update `apps/core/test/helpers/mock-d1.ts` to execute only the clean `0001_initial_schema.sql`.

### 2. Core Services Refactor & Bug Fixes (`apps/core/src/services/`)
- [x] Create `apps/core/src/services/payment.ts` to centralize payment method selection, wallet assignment, TrxID validation/burning, COD confirmation, Telegram notification dispatch, and `payment.confirmed` webhook queueing (eliminating duplication between `api/payments.ts` and `api/checkout.ts`).
- [x] Update `apps/core/src/services/wallet.ts`:
  - Query eligible wallets for a `storeId` (`store_id IS NULL OR store_id = storeId`).
  - Aggregate `reservedToday` across **all** payments referencing each `wallet_id` so the ৳25,000/day SIM cap is enforced across stores.
- [x] Fix `apps/core/src/services/decision.ts`:
  - Emit normalized snake_case `Payment` payloads in outbound webhooks (fixing the raw Drizzle camelCase bug).
  - Finalize the Telegram notification card (`finalizeNotificationCard`) using `payment.telegramMessageId` once the 90s undo window ends, removing the `[ ↩ Undo ]` button.
  - Ensure `payment.reopened` webhook is queued when a payment is reopened.
  - Remove hardcoded `retry_url: ${successUrl}?retry=true` (storefronts handle retries on their own order/checkout page using `payment.id` and `external_order_id`).
- [x] Add stale payment expiration to the 1-minute cron in `apps/core/src/index.ts` so expired `CREATED` payments release reserved wallet capacity automatically.
- [x] Update `apps/core/src/api/auth.ts`, `apps/core/src/api/payments.ts`, and `apps/core/src/api/checkout.ts` for `store` context (`store_id` instead of `merchant_id`), optional `success_url`, and no `brand_color`/`logo_key`/`checkout_url`.

### 3. Telegram Bot Overhaul (`apps/core/src/bot/`)
- [x] Rewrite `bot/middleware/auth.ts` with strict single-owner verification (`OWNER_TELEGRAM_ID` or claimed `bot_config.owner_telegram_chat_id`), rejecting strangers cleanly.
- [x] Replace `bot/handlers/onboarding.ts` with a lightweight claim + first-store setup flow (`/start [setup_token]` → claim ownership → prompt for Store Name → issue credentials).
- [x] Remove `/logout`, `/reset`, `/restart`, `/brand_color`, NID prompts, owner name/phone prompts, and branding keyboards.
- [x] Add multi-store management (`/stores` dashboard, create/select/rename/pause/delete store, per-store settings, per-store API keys, per-store webhook config + test ping using `deliverWebhookPayload`).
- [x] Update `bot/views/cards.ts`, `bot/views/keyboards.ts`, `bot/callbacks/menu.ts`, `bot/handlers/text.ts`, and `bot/commands/test.ts` to:
  - Include Store Name on every payment/COD notification card.
  - Enforce ownership on all callbacks and allow store selection for `/test` and `/payments`.
  - Use `payment.telegramMessageId` instead of `metadata.telegram_message_id`.
- [x] Remove ALL emojis from every Telegram bot message, payment card, inline button label, menu, and notification alert (clean plain-text only).

### 4. Remove Hosted Checkout Worker (`apps/checkout`)
- [x] Remove `apps/checkout` directory and any references in root scripts/docs.
- [x] Verify `/c/:id/data`, `/c/:id/method`, `/c/:id/submit`, and `/c/:id/status` in `apps/core` serve everything a custom embedded storefront checkout needs cleanly (with CORS support).

### 5. Self-Hosted Deployment Config & Interactive Setup CLI
- [x] Clean `apps/core/wrangler.toml` (remove personal `database_id`, remove hardcoded `PUBLIC_BASE_URL`, remove unused `[[r2_buckets]]` binding) and add `apps/core/wrangler.toml.example`.
- [x] Update `apps/core/.env.example` and root `.env.example` for the new env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ENCRYPTION_KEY`, `OWNER_TELEGRAM_ID` / `SETUP_TOKEN`).
- [x] Build a 1-command interactive self-deployment CLI (`scripts/setup.ts` via `bun run setup`):
  1. Verifies Wrangler auth.
  2. Prompts for `TELEGRAM_BOT_TOKEN` (with `@BotFather` instructions) and optional `OWNER_TELEGRAM_ID`.
  3. Provisions D1 database + applies `0001_initial_schema.sql`.
  4. Generates and uploads `ENCRYPTION_KEY`, `TELEGRAM_WEBHOOK_SECRET`, and one-time `SETUP_TOKEN` (if no owner ID provided).
  5. Deploys `apps/core`, fetches `BOT_INFO` via `getMe`, and registers the Telegram webhook (`setWebhook`).
  6. Prints the deployed Worker URL and private Telegram claim link.

### 6. SDK, Examples, Docs & Agent Skill Alignment
- [x] Update `packages/sdk`:
  - Remove hardcoded `https://smpg-core.fhasan-gch.workers.dev` default in `SMPGCheckout`; make `baseUrl` required and align constructor signature (`new SMPGCheckout({ baseUrl })` or `new SMPGCheckout(baseUrl)` consistently with docs).
  - Update `Payment` & `CheckoutSessionData` types (`store_id`, `store.name`, optional `success_url`, remove `brand_color`, `logo_key`, `checkout_url`).
- [x] Standardize webhook signature header to `x-smpg-signature` across `apps/core`, `packages/sdk`, `examples/storefront`, `AGENTS.md`, `README.md`, `skills/smpg-integration/SKILL.md`, `docs/llms*.txt`, and `docs/openapi.yaml`.
- [x] Build self-contained custom checkout UI examples in `examples/`:
  - Update `examples/storefront` (Hono backend + working interactive HTML/JS embedded checkout page demonstrating bKash/Nagad/COD + retry on rejection).
  - Add a clean React/Next.js embedded checkout component example in `examples/react`.
- [x] Update `README.md`, `AGENTS.md`, `docs/openapi.yaml`, `docs/llms.txt`, `docs/llms-full.txt`, `docs/SMPG_Plan.md`, and `skills/smpg-integration/SKILL.md` (and `.agents/skills/smpg-integration/SKILL.md`) to reflect the self-hosted deployment and custom-checkout architecture.

### 7. Verification
- [x] Rewrite and run all unit/integration tests across `apps/core`, `packages/sdk`, and `examples/storefront` (`bun test`) — including owner lock/rejection tests, multi-store isolation, cross-store shared SIM daily cap enforcement, and snake_case webhook verification.
- [x] Verify clean builds and typechecking (`bun run build && bun run typecheck`).
- [x] Verify local D1 migration (`bun run d1:migrate:local`) applies cleanly on a fresh database.
