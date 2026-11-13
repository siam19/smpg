# Sprint 2: Core Payments REST API

> **Status**: Completed  
> **Reference**: [SMPG Master Plan - Section 6 (State Machine), Section 7 (Data Model), Section 8 (REST API v1)](../../SMPG_Plan.md)

---

## Sprint Objectives
Build and deploy the primary merchant REST API (`/v1/payments`) on `apps/core` (Hono on Cloudflare Workers), enabling e-commerce storefronts and the SDK to create, retrieve, list, and cancel payment sessions with API key authentication and idempotency protection.

---

## Deliverables & Scope

1. **Authentication Middleware**:
   - Extract `Authorization: Bearer <key>` header (`smpg_live_...` or `smpg_test_...`).
   - Compute SHA-256 hash using Web Crypto API and look up `api_keys` where `revoked_at IS NULL`.
   - Attach authenticated `merchant` and `mode` (`live` | `test`) to Hono request context.
   - Return standard `401 Unauthorized` error if token is invalid or missing.

2. **`POST /v1/payments` (Create Payment Session)**:
   - Accept payload:
     ```json
     {
       "amount": 1250,
       "method": "bkash",
       "external_order_id": "ORD-1042",
       "customer": { "name": "Rafi", "phone": "017XXXXXXXX" },
       "success_url": "https://shop.example/orders/ORD-1042/thanks",
       "cancel_url": "https://shop.example/cart",
       "metadata": { "cart_id": "c_9" }
     }
     ```
   - Support `Idempotency-Key` header via database unique index `(merchant_id, idempotency_key)` to prevent duplicate payments on retries.
   - Integer BDT validation (`amount >= 1`).
   - Method assignment:
     - If `method === 'bkash' | 'nagad'`: pre-assign wallet using rotation algorithm (`assignWalletForPayment`). If no wallet has capacity, return `no_wallet_available` error.
     - If `method === 'cod'`: create payment and dispatch COD confirmation card to merchant's Telegram chat.
     - If `method` is omitted: leave wallet unassigned until customer selects method on hosted checkout.
   - Compute `expires_at = now + 60 minutes`.
   - Return `201 Created` with payment object including `checkout_url` (`${PUBLIC_BASE_URL}/c/pay_xxx`).

3. **`GET /v1/payments/:id` (Retrieve Payment)**:
   - Retrieve payment details scoped to the authenticated merchant.
   - Lazy finalization check: if `pending_decision IS NOT NULL` and `decision_effective_at <= now`, finalize inline before returning response.
   - Return full payment details: `status`, `amount`, `method`, `trx_id`, `sender_number`, `pending_decision`, `expires_at`.

4. **`GET /v1/payments` (List Payments)**:
   - Filter by `external_order_id`, `status`.
   - Cursor-based or limit/offset pagination (`limit` default 20, max 100).
   - Return `{ data: Payment[], has_more: boolean }`.

5. **`POST /v1/payments/:id/cancel` (Cancel Payment)**:
   - Allow cancellation from `CREATED` or `CONFIRMED` states.
   - Transition status atomically to `CANCELLED`, write audit row in `payment_events`, and queue outbound webhook.

6. **Standard Error Handling**:
   - Standard RFC-compliant error format:
     ```json
     {
       "error": {
         "code": "invalid_request",
         "message": "Detailed error explanation",
         "param": "amount"
       }
     }
     ```

7. **Automated Testing**:
   - Unit and integration tests for API routes, idempotency handling, and authentication.
