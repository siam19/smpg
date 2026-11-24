export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ENCRYPTION_KEY: string;
  BOT_INFO?: string;
  OWNER_TELEGRAM_ID?: string;
  SETUP_TOKEN?: string;
  UNDO_WINDOW_SECONDS: string;
  SUBMITTED_TTL_HOURS: string;
  CREATED_TTL_MINUTES: string;
  LATE_SUBMIT_HOURS: string;
}

export type PaymentMethod = 'cod' | 'bkash' | 'nagad';

export type PaymentStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'PAID'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export type VerificationMethod = 'telegram' | 'sms';
