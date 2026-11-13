# Sprint 3: Customer Checkout Endpoints Log

## Date: 2026-11-13

### Status
Planned / Next in Queue

---

### Planned Tasks
- [ ] Implement `GET /c/:id/data` (public session metadata, merchant branding, available payment methods)
- [ ] Implement `POST /c/:id/method` (dynamic wallet assignment with rotation logic, COD handling)
- [ ] Implement `POST /c/:id/submit` (TrxID normalization, uniqueness validation against `trx_submissions`, late submission flagging)
- [ ] Connect submission flow to Telegram notification card dispatch with provider-specific labels (`TrxID` vs `TxnID`)
- [ ] Implement `GET /c/:id/status` lightweight status endpoint with HTTP caching headers
- [ ] Write integration test suite in `apps/core/test/checkout-endpoints.test.ts`
- [ ] Deploy and verify endpoints on Cloudflare Workers
