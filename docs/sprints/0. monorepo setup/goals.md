# Sprint 0: Monorepo Setup & Foundation

> **Status**: Completed  
> **Reference**: [SMPG Master Plan - Section 2 & Section 17 (Milestone M0)](../../SMPG_Plan.md)

---

## Sprint Objectives
Establish the repository foundation, package workspace structure, database migrations, Cloudflare Workers scaffold, and publishable NPM SDK using **Bun**.

---

## Deliverables & Scope

1. **Monorepo Structure**:
   - Initialize Bun workspaces in `package.json` (`apps/*`, `packages/*`, `examples/*`).
   - Root `tsconfig.json` with strict TypeScript configuration.
   - Comprehensive `.gitignore`.

2. **Core Backend Scaffold (`apps/core`)**:
   - Cloudflare Worker using Hono framework.
   - `wrangler.toml` configuring D1 database (`DB`), R2 bucket (`BUCKET`), and cron triggers (`* * * * *`).
   - Initial D1 database schema migration `0001_initial_schema.sql` (`merchants`, `merchant_wallets`, `api_keys`, `payments`, `trx_submissions`, `payment_events`, `webhook_deliveries`).

3. **Publishable NPM SDK (`packages/sdk` -> `send-money-payment-gateway`)**:
   - Zero runtime dependencies using Web Crypto (`crypto.subtle`) and standard `fetch`.
   - Dual ESM (`dist/index.js`) and CommonJS (`dist/index.cjs`) output with full type definitions (`dist/index.d.ts`, `dist/index.d.cts`).
   - Verified npm packaging with `npm pack --dry-run`.
   - Webhook signature verification utility (`constructEvent()`).

4. **Hosted Checkout Scaffold (`apps/checkout`)**:
   - Scaffolded with SvelteKit minimal barebones, TypeScript, Tailwind CSS v4, and `@sveltejs/adapter-cloudflare`.

5. **API Specification**:
   - OpenAPI 3.1.0 specification in `docs/openapi.yaml`.
