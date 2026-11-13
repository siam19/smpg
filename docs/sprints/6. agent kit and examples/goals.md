# Sprint 6: Agent Integration Kit & Storefront Examples

> **Status**: Planned  
> **Reference**: [SMPG Master Plan - Section 13 (Agent Integration Kit), Section 17 (Roadmap Milestone M4)](../../SMPG_Plan.md)

---

## Sprint Objectives
Create the agent-first integration layer, machine-readable specifications, developer documentation, and reference storefront examples. Enable any developer or coding agent (Claude, Cursor, Copilot, DeepMind Antigravity) to integrate SMPG checkout into an e-commerce storefront in a single pass.

---

## Deliverables & Scope

1. **Machine-Readable Specifications**:
   - `docs/openapi.yaml`: Complete OpenAPI 3.1 schema covering `/v1/payments`, `/v1/payments/:id`, `/c/:id/*`, and webhook payloads.
   - `docs/llms.txt` & `docs/llms-full.txt`: Token-optimized, link-indexed documentation for LLM consumption.
   - `AGENTS.md`: Standard instructions to drop into any storefront repo.

2. **Integration Recipes**:
   - Complete copy-pasteable integration guides for:
     - **Next.js (App Router)**: Route handlers for webhooks (`export async function POST(req)`), server actions for payment creation.
     - **SvelteKit**: `+server.ts` webhook receiver, load function for order status.
     - **Cloudflare Workers (Hono)**: Edge-native handler using `@smpg/sdk`.
     - **Express / Node.js**: Standard middleware with raw body parsing for webhook verification.

3. **Test Mode & Simulation Tools**:
   - Support for `smpg_test_` API keys.
   - Telegram bot `/test` commands or simulation endpoints to:
     - Simulate customer TrxID submission without real mobile banking transactions.
     - Simulate merchant approval / rejection.
     - Simulate courier delivery and cancellation webhooks.
   - Verify that test payments never trigger real wallet daily limits.

4. **Reference Storefront Example (`examples/storefront`)**:
   - Scaffold a working reference storefront implementing:
     - Cart and Order creation (`orders` table schema with `external_order_id`).
     - Payment creation via `@smpg/sdk`.
     - Asynchronous order tracking page showing `payment_verifying`, `paid`, `payment_rejected`, `cod_confirmed`.
     - Webhook endpoint verifying signatures via `smpg.webhooks.constructEvent()` on raw request bodies.
     - Rejection recovery flow using `retry_url`.

5. **Definition of Done Verification**:
   - Complete the Milestone M4 Acceptance Checklist:
     - [ ] Order created before redirect; order id passed as `external_order_id`.
     - [ ] Success page shows "verifying" for prepaid orders and never marks them paid.
     - [ ] Webhook verifies signature on raw body and rejects stale timestamps (> 5 min).
     - [ ] `applyPaymentEvent` is idempotent and handles every event type.
     - [ ] Order page re-fetches status server-side instead of trusting URL parameters.
     - [ ] All 3 payment methods (bKash, Nagad, COD) function end-to-end in test mode.
