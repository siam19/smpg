import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const botConfig = sqliteTable('bot_config', {
  id: text('id').primaryKey(),
  ownerTelegramChatId: integer('owner_telegram_chat_id').unique(),
  rotationStrategy: text('rotation_strategy').notNull().default('balanced'), // 'balanced' | 'fill_first'
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(), // str_xxx
  name: text('name').notNull(),
  codEnabled: integer('cod_enabled').notNull().default(1),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret').notNull(), // AES-GCM encrypted
  paused: integer('paused').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const wallets = sqliteTable(
  'wallets',
  {
    id: text('id').primaryKey(), // wal_xxx
    storeId: text('store_id').references(() => stores.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(), // 'bkash' | 'nagad'
    number: text('number').notNull(),
    label: text('label'),
    dailyLimit: integer('daily_limit').notNull().default(25000), // BDT
    priority: integer('priority').notNull().default(100),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('uq_wallet_provider_number').on(table.provider, table.number)]
);

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => stores.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull().unique(),
  encryptedKey: text('encrypted_key'), // AES-GCM encrypted full key for owner retrieval in Telegram
  prefix: text('prefix').notNull(), // e.g. smpg_live_ab12
  mode: text('mode').notNull(), // 'test' | 'live'
  revokedAt: integer('revoked_at'),
  createdAt: integer('created_at').notNull(),
});

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(), // pay_xxx
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id),
    mode: text('mode').notNull(), // 'test' | 'live'
    externalOrderId: text('external_order_id'),
    method: text('method'), // 'cod' | 'bkash' | 'nagad' | null
    walletId: text('wallet_id').references(() => wallets.id),
    amount: integer('amount').notNull(), // BDT
    status: text('status').notNull(), // CREATED, SUBMITTED, CONFIRMED, PAID, REJECTED, EXPIRED, CANCELLED
    trxId: text('trx_id'),
    senderNumber: text('sender_number'),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    parentPaymentId: text('parent_payment_id'),
    verificationMethod: text('verification_method'), // 'telegram' | 'sms'
    successUrl: text('success_url'),
    cancelUrl: text('cancel_url'),
    metadata: text('metadata'),
    telegramMessageId: integer('telegram_message_id'),
    idempotencyKey: text('idempotency_key'),
    attempts: integer('attempts').notNull().default(0),
    pendingDecision: text('pending_decision'), // 'approve' | 'reject' | 'confirm' | 'cancel'
    decisionActor: text('decision_actor'), // 'telegram:@username'
    decisionEffectiveAt: integer('decision_effective_at'),
    lateSubmission: integer('late_submission').notNull().default(0),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('ix_pay_store').on(table.storeId, table.createdAt),
    index('ix_pay_order').on(table.storeId, table.externalOrderId),
    index('ix_pay_wallet_day').on(table.walletId, table.createdAt),
  ]
);

export const trxSubmissions = sqliteTable('trx_submissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paymentId: text('payment_id')
    .notNull()
    .references(() => payments.id),
  method: text('method').notNull(),
  trxId: text('trx_id').notNull(),
  senderNumber: text('sender_number'),
  outcome: text('outcome'), // pending | approved | rejected
  mode: text('mode').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const paymentEvents = sqliteTable('payment_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paymentId: text('payment_id')
    .notNull()
    .references(() => payments.id),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actor: text('actor').notNull(),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
});

export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id')
    .notNull()
    .references(() => payments.id),
  storeId: text('store_id')
    .notNull()
    .references(() => stores.id),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(),
  attempt: integer('attempt').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at'),
  lastStatus: integer('last_status'),
  deliveredAt: integer('delivered_at'),
});

export type BotConfig = typeof botConfig.$inferSelect;
export type NewBotConfig = typeof botConfig.$inferInsert;

export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

export type TrxSubmission = typeof trxSubmissions.$inferSelect;
export type NewTrxSubmission = typeof trxSubmissions.$inferInsert;

export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
