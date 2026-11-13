# Sprint 2: Core Payments REST API Log

## Date: 2026-11-13

### Status
Planned / Ready to Start

---

### Planned Tasks
- [ ] Implement API key authentication middleware (`apps/core/src/api/auth.ts`)
- [ ] Implement `POST /v1/payments` with `Idempotency-Key` and wallet assignment
- [ ] Implement `GET /v1/payments/:id` with lazy undo window evaluation
- [ ] Implement `GET /v1/payments` list endpoint with filters and pagination
- [ ] Implement `POST /v1/payments/:id/cancel`
- [ ] Add unit and route tests in `apps/core/test/payments.test.ts`
- [ ] Deploy to Cloudflare Workers and verify live endpoints
