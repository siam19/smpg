-- SMPG Initial Database Schema (Cloudflare D1 SQLite)

CREATE TABLE IF NOT EXISTS merchants (
  id                TEXT PRIMARY KEY,            -- mrc_xxx
  telegram_chat_id  INTEGER NOT NULL UNIQUE,
  store_name        TEXT,
  logo_key          TEXT,                         -- R2 object key
  brand_color       TEXT,
  cod_enabled       INTEGER NOT NULL DEFAULT 1,
  rotation_strategy TEXT NOT NULL DEFAULT 'balanced',   -- balanced | fill_first
  webhook_url       TEXT,
  webhook_secret    TEXT NOT NULL,                -- encrypted at rest (AES-GCM)
  test_mode         INTEGER NOT NULL DEFAULT 1,
  paused            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_wallets (
  id           TEXT PRIMARY KEY,                  -- wal_xxx
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  provider     TEXT NOT NULL CHECK (provider IN ('bkash', 'nagad')),
  number       TEXT NOT NULL,
  label        TEXT,
  daily_limit  INTEGER NOT NULL DEFAULT 25000,    -- BDT
  priority     INTEGER NOT NULL DEFAULT 100,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE (merchant_id, provider, number)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  key_hash     TEXT NOT NULL UNIQUE,              -- SHA-256 of key
  prefix       TEXT NOT NULL,                     -- e.g. smpg_live_ab12 (display only)
  mode         TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT PRIMARY KEY,         -- pay_xxx
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  mode                  TEXT NOT NULL,            -- test | live
  external_order_id     TEXT,                     -- merchant's own order id
  method                TEXT NOT NULL CHECK (method IN ('cod', 'bkash', 'nagad')),
  wallet_id             TEXT REFERENCES merchant_wallets(id),
  amount                INTEGER NOT NULL,         -- BDT, whole taka
  status                TEXT NOT NULL,            -- CREATED, SUBMITTED, CONFIRMED, PAID, REJECTED, EXPIRED, CANCELLED
  trx_id                TEXT,                     -- latest submitted TrxID/TxnID
  sender_number         TEXT,
  customer_name         TEXT,
  customer_phone        TEXT,
  parent_payment_id     TEXT REFERENCES payments(id), -- reserved for future COD advance
  verification_method   TEXT,                     -- telegram | sms
  success_url           TEXT NOT NULL,
  cancel_url            TEXT,
  metadata              TEXT,                     -- JSON string, <= 2 KB
  idempotency_key       TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  pending_decision      TEXT,                     -- approve | reject | confirm | cancel (during Undo window)
  decision_actor        TEXT,                     -- telegram:@user
  decision_effective_at INTEGER,
  late_submission       INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_idem ON payments(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pay_merchant ON payments(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_pay_order ON payments(merchant_id, external_order_id);
CREATE INDEX IF NOT EXISTS ix_pay_wallet_day ON payments(wallet_id, created_at);

-- Every TrxID ever submitted; burned forever in live mode.
CREATE TABLE IF NOT EXISTS trx_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  method        TEXT NOT NULL,
  trx_id        TEXT NOT NULL,
  sender_number TEXT,
  outcome       TEXT,                             -- pending | approved | rejected
  mode          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trx ON trx_submissions(method, trx_id) WHERE mode = 'live';

-- Audit trail for payment status transitions
CREATE TABLE IF NOT EXISTS payment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,                      -- customer | telegram:@user | sms | system | api
  note        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  payment_id      TEXT NOT NULL REFERENCES payments(id),
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status     INTEGER,
  delivered_at    INTEGER
);
