import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const merchants = sqliteTable(
  'merchants',
  {
    id: text('id').primaryKey(), // mrc_xxx
    telegramChatId: integer('telegram_chat_id').notNull().unique(),
    ownerName: text('owner_name'),
    phoneNumber: text('phone_number'),
    canProvideNid: integer('can_provide_nid').default(0),
    onboardingStep: text('onboarding_step').default('completed'), // 'name' | 'phone' | 'nid' | 'ready_to_create_store' | 'store_name' | 'brand_color' | 'completed'
    storeName: text('store_name'),
    logoKey: text('logo_key'),
    brandColor: text('brand_color'),
    codEnabled: integer('cod_enabled').notNull().default(1),
    rotationStrategy: text('rotation_strategy').notNull().default('balanced'), // 'balanced' | 'fill_first'
    webhookUrl: text('webhook_url'),
    webhookSecret: text('webhook_secret').notNull(), // AES-GCM encrypted
    testMode: integer('test_mode').notNull().default(1),
    paused: integer('paused').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  }
);

export const merchantWallets = sqliteTable(
  'merchant_wallets',
  {
    id: text('id').primaryKey(), // wal_xxx
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    provider: text('provider').notNull(), // 'bkash' | 'nagad'
    number: text('number').notNull(),
    label: text('label'),
    dailyLimit: integer('daily_limit').notNull().default(25000), // BDT
    priority: integer('priority').notNull().default(100),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_merchant_provider_num').on(table.merchantId, table.provider, table.number),
  ]
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    keyHash: text('key_hash').notNull().unique(),
    prefix: text('prefix').notNull(), // e.g. smpg_live_ab12
    mode: text('mode').notNull(), // 'test' | 'live'
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  }
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(), // pay_xxx
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    mode: text('mode').notNull(), // 'test' | 'live'
    externalOrderId: text('external_order_id'),
    method: text('method').notNull(), // 'cod' | 'bkash' | 'nagad'
    walletId: text('wallet_id').references(() => merchantWallets.id),
    amount: integer('amount').notNull(), // BDT
    status: text('status').notNull(), // CREATED, SUBMITTED, CONFIRMED, PAID, REJECTED, EXPIRED, CANCELLED
    trxId: text('trx_id'),
    senderNumber: text('sender_number'),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    parentPaymentId: text('parent_payment_id'),
    verificationMethod: text('verification_method'), // 'telegram' | 'sms'
    successUrl: text('success_url').notNull(),
    cancelUrl: text('cancel_url'),
    metadata: text('metadata'),
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
    index('ix_pay_merchant').on(table.merchantId, table.createdAt),
    index('ix_pay_order').on(table.merchantId, table.externalOrderId),
    index('ix_pay_wallet_day').on(table.walletId, table.createdAt),
  ]
);

export const trxSubmissions = sqliteTable(
  'trx_submissions',
  {
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
  }
);

export const paymentEvents = sqliteTable(
  'payment_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  }
);

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull(),
    attempt: integer('attempt').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    lastStatus: integer('last_status'),
    deliveredAt: integer('delivered_at'),
  }
);

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;

export type MerchantWallet = typeof merchantWallets.$inferSelect;
export type NewMerchantWallet = typeof merchantWallets.$inferInsert;

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
