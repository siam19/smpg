-- Migration: Make payment method nullable to allow customers to choose method on hosted checkout
PRAGMA foreign_keys=off;

CREATE TABLE payments_new (
  id                    TEXT PRIMARY KEY,
  merchant_id           TEXT NOT NULL REFERENCES merchants(id),
  mode                  TEXT NOT NULL,
  external_order_id     TEXT,
  method                TEXT CHECK (method IS NULL OR method IN ('cod', 'bkash', 'nagad')),
  wallet_id             TEXT REFERENCES merchant_wallets(id),
  amount                INTEGER NOT NULL,
  status                TEXT NOT NULL,
  trx_id                TEXT,
  sender_number         TEXT,
  customer_name         TEXT,
  customer_phone        TEXT,
  parent_payment_id     TEXT REFERENCES payments(id),
  verification_method   TEXT,
  success_url           TEXT NOT NULL,
  cancel_url            TEXT,
  metadata              TEXT,
  idempotency_key       TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  pending_decision      TEXT,
  decision_actor        TEXT,
  decision_effective_at INTEGER,
  late_submission       INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

INSERT INTO payments_new SELECT * FROM payments;
DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE UNIQUE INDEX IF NOT EXISTS uq_idem ON payments(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_pay_merchant ON payments(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_pay_order ON payments(merchant_id, external_order_id);
CREATE INDEX IF NOT EXISTS ix_pay_wallet_day ON payments(wallet_id, created_at);

PRAGMA foreign_keys=on;
