# Sprint 0: Monorepo Setup & Foundation Log

## Date: 2026-11-11

### Summary of Changes
Initialized the Send Money Payment Gateway (SMPG) monorepo using **Bun** workspaces and established the foundation for the Cloudflare Worker core API, local SQLite D1 database migrations, and the publishable NPM SDK.

---

### Files Added / Modified

#### Root & Monorepo Configuration
- [`.gitignore`](file:///home/bast0k/projects/smpg/.gitignore): Ignores `node_modules`, `dist`, `.wrangler`, `.mf`, environment files, and local logs.
- [`package.json`](file:///home/bast0k/projects/smpg/package.json): Root configuration defining Bun workspaces (`apps/*`, `packages/*`, `examples/*`) and root lifecycle scripts (`dev`, `build`, `typecheck`, `test`).
- [`tsconfig.json`](file:///home/bast0k/projects/smpg/tsconfig.json): Base TypeScript configuration tailored for Bun and modern bundlers.

#### Core Engine (`apps/core`)
- [`apps/core/package.json`](file:///home/bast0k/projects/smpg/apps/core/package.json): Worker package configuration with Hono framework, Wrangler, and Workers types.
- [`apps/core/tsconfig.json`](file:///home/bast0k/projects/smpg/apps/core/tsconfig.json): TypeScript setup with `@cloudflare/workers-types`.
- [`apps/core/wrangler.toml`](file:///home/bast0k/projects/smpg/apps/core/wrangler.toml): Cloudflare Worker configuration containing:
  - D1 database binding (`DB` -> `smpg`)
  - R2 bucket binding (`LOGOS` -> `smpg-logos`)
  - Environment variables: `PUBLIC_BASE_URL`, `UNDO_WINDOW_SECONDS` (90s), `SUBMITTED_TTL_HOURS` (72h), `CREATED_TTL_MINUTES` (60m), `LATE_SUBMIT_HOURS` (24h)
  - Cron trigger (`* * * * *`) for scheduled tasks (Undo window finalization, stale reminders, expiration, webhook retries).
- [`apps/core/migrations/0001_initial_schema.sql`](file:///home/bast0k/projects/smpg/apps/core/migrations/0001_initial_schema.sql): Initial D1 database schema for:
  - `merchants`: Merchant settings, Telegram chat ID, API key hash, branding, rotation strategy.
  - `merchant_wallets`: Multiple wallet numbers per provider (`bkash`, `nagad`), daily limit tracking, priority, status.
  - `api_keys`: Hashed keys (`smpg_live_`, `smpg_test_`), mode, revocation status.
  - `payments`: Core payment state machine records, customer info, idempotency, undo window tracking (`pending_decision`, `decision_effective_at`).
  - `trx_submissions`: Record of every submitted TrxID/TxnID with unique live-mode index to prevent reuse.
  - `payment_events`: Audit trail for state transitions.
  - `webhook_deliveries`: Outbound webhook dispatch and retry queue.
  *(Note: Courier tables and fields were deliberately excluded from initial schema pending further provider research).*
- [`apps/core/src/types.ts`](file:///home/bast0k/projects/smpg/apps/core/src/types.ts): Environment and core type definitions.
- [`apps/core/src/index.ts`](file:///home/bast0k/projects/smpg/apps/core/src/index.ts): Hono-based router entrypoint, healthcheck endpoint, and scheduled cron handler scaffold.

#### SDK Package (`packages/sdk` -> `send-money-payment-gateway`)
- [`packages/sdk/package.json`](file:///home/bast0k/projects/smpg/packages/sdk/package.json): Configured for publication to npm:
  - Name: `send-money-payment-gateway`
  - Dual ESM/CommonJS distribution (`dist/index.js`, `dist/index.cjs`)
  - Full TypeScript declaration exports (`dist/index.d.ts`, `dist/index.d.cts`)
  - Zero runtime dependencies (`sideEffects: false`)
- [`packages/sdk/tsconfig.json`](file:///home/bast0k/projects/smpg/packages/sdk/tsconfig.json): Build settings for SDK typing.
- [`packages/sdk/src/types.ts`](file:///home/bast0k/projects/smpg/packages/sdk/src/types.ts): Public types for payments, methods, statuses, and webhook payloads.
- [`packages/sdk/src/webhooks.ts`](file:///home/bast0k/projects/smpg/packages/sdk/src/webhooks.ts): `constructEvent()` utility verifying `x-smpg-signature` (HMAC-SHA256) via standard Web Crypto API with constant-time equality check and timestamp replay tolerance.
- [`packages/sdk/src/client.ts`](file:///home/bast0k/projects/smpg/packages/sdk/src/client.ts): Client class `SMPG` handling `payments.create`, `payments.retrieve`, `payments.list`, `payments.cancel`, and `webhooks.constructEvent`.
- [`packages/sdk/src/index.ts`](file:///home/bast0k/projects/smpg/packages/sdk/src/index.ts): Public entrypoint exporting `SMPG`, `SMPGError`, and types.
- [`packages/sdk/README.md`](file:///home/bast0k/projects/smpg/packages/sdk/README.md): Documentation with quickstart integration guides.
- [`packages/sdk/test/webhooks.test.ts`](file:///home/bast0k/projects/smpg/packages/sdk/test/webhooks.test.ts): Unit tests verifying signature validation, tampering rejection, and timestamp expiry (all passing via `bun test`).

#### Hosted Checkout App (`apps/checkout`)
- Created using `bun create cloudflare@latest apps/checkout --framework svelte --platform workers --lang ts` with SvelteKit minimal barebones template, Tailwind CSS v4, and `@sveltejs/adapter-cloudflare`.
- [`apps/checkout/package.json`](file:///home/bast0k/projects/smpg/apps/checkout/package.json): Named `@smpg/checkout` with scripts for `dev`, `build`, `check`, `typecheck`, `deploy`, and `preview`.
- [`apps/checkout/vite.config.ts`](file:///home/bast0k/projects/smpg/apps/checkout/vite.config.ts): Configured with `@tailwindcss/vite` and `@sveltejs/adapter-cloudflare`.
- [`apps/checkout/wrangler.jsonc`](file:///home/bast0k/projects/smpg/apps/checkout/wrangler.jsonc): Cloudflare Workers configuration with static assets.
- [`apps/checkout/src/routes/+layout.svelte`](file:///home/bast0k/projects/smpg/apps/checkout/src/routes/+layout.svelte) & [`+page.svelte`](file:///home/bast0k/projects/smpg/apps/checkout/src/routes/+page.svelte): Clean minimal root layout and page styled with Tailwind.

#### Documentation
- [`docs/openapi.yaml`](file:///home/bast0k/projects/smpg/docs/openapi.yaml): OpenAPI 3.1.0 specification for SMPG REST API (`/v1/payments`, checkout status, errors).

---

### Verification Performed
1. Tested SDK compilation using `tsup` — generates ESM, CJS, and `.d.ts`/`.d.cts` files in under 2 seconds.
2. Verified `npm pack --dry-run` — confirmed package structure and files (`dist/`, `package.json`, `README.md`) ready for npm publishing.
3. Executed `wrangler d1 migrations apply smpg --local` — verified all 13 schema DDL commands execute cleanly against local SQLite.
4. Ran `bun run typecheck` across all workspaces (`@smpg/checkout`, `@smpg/core`, `send-money-payment-gateway`) — 0 errors and 0 warnings.
5. Ran `bun run build` across all workspaces — built `@smpg/checkout` via Vite + `@sveltejs/adapter-cloudflare` and `send-money-payment-gateway` via `tsup`.

---

### Things to Look Out For / Future Tasks
1. **Courier Integration**: Revisit Steadfast, Pathao, and Carrybee schemas/adapters once API specifications and merchant auth patterns are verified.
2. **Secret Encryption**: Ensure AES-GCM encryption helper is implemented for `webhook_secret` storage in D1.
3. **Telegram Webhook**: Implement Telegram Bot webhook handling with `X-Telegram-Bot-Api-Secret-Token` validation and atomic transition locking.
4. **CI Setup**: Set up GitHub Actions workflow for linting, typechecking, and running test suites across packages.
