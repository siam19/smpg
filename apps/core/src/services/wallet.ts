import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { botConfig, payments, wallets, type Wallet } from '../db/schema';
import type { PaymentMethod } from '../types';

/**
 * Returns the unix timestamp for 00:00:00 AM of today in Asia/Dhaka (UTC+6).
 */
export function getDhakaStartOfDayTimestamp(): number {
  const now = new Date();
  // Dhaka is UTC+6 (offset = 6 * 3600 seconds)
  const dhakaOffsetMs = 6 * 60 * 60 * 1000;
  const dhakaNow = new Date(now.getTime() + dhakaOffsetMs);

  const year = dhakaNow.getUTCFullYear();
  const month = dhakaNow.getUTCMonth();
  const date = dhakaNow.getUTCDate();

  const startOfDayDhakaUtc = Date.UTC(year, month, date) - dhakaOffsetMs;
  return Math.floor(startOfDayDhakaUtc / 1000);
}

export interface WalletWithUsage {
  wallet: Wallet;
  reservedToday: number;
  availableCapacity: number;
  percentageUsed: number;
}

/**
 * Reads the owner's configured wallet rotation strategy from bot_config.
 */
export async function getRotationStrategy(db: Database): Promise<'balanced' | 'fill_first'> {
  const config = await db.select().from(botConfig).limit(1).get();
  return config?.rotationStrategy === 'fill_first' ? 'fill_first' : 'balanced';
}

/**
 * Calculates current day's reserved taka for eligible wallets.
 * - When `storeId` is provided, returns shared wallets (store_id IS NULL) and wallets scoped to that store.
 * - When `storeId` is omitted, returns all owner wallets (e.g. for /wallets dashboard).
 * - Always aggregates `reservedToday` across ALL stores referencing each wallet_id to enforce the SIM daily cap.
 */
export async function getWalletsWithUsage(
  db: Database,
  options?: {
    storeId?: string;
    provider?: 'bkash' | 'nagad';
  }
): Promise<WalletWithUsage[]> {
  const startOfDay = getDhakaStartOfDayTimestamp();

  const whereConditions = [];
  if (options?.storeId) {
    whereConditions.push(or(isNull(wallets.storeId), eq(wallets.storeId, options.storeId)));
  }
  if (options?.provider) {
    whereConditions.push(eq(wallets.provider, options.provider));
  }

  const walletRows = await db
    .select()
    .from(wallets)
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
    .orderBy(wallets.priority, wallets.createdAt);

  if (walletRows.length === 0) {
    return [];
  }

  const walletIds = walletRows.map((w) => w.id);

  // Aggregate today's active reserved payments across ALL stores for each wallet_id
  const activeStatuses = ['CREATED', 'SUBMITTED', 'CONFIRMED', 'PAID'];

  const usageRows = await db
    .select({
      walletId: payments.walletId,
      totalAmount: sql<number>`COALESCE(SUM(${payments.amount}), 0)`,
    })
    .from(payments)
    .where(
      and(
        inArray(payments.walletId, walletIds),
        inArray(payments.status, activeStatuses),
        gte(payments.createdAt, startOfDay)
      )
    )
    .groupBy(payments.walletId);

  const usageMap = new Map<string, number>();
  for (const row of usageRows) {
    if (row.walletId) {
      usageMap.set(row.walletId, Number(row.totalAmount));
    }
  }

  return walletRows.map((w) => {
    const reservedToday = usageMap.get(w.id) ?? 0;
    const availableCapacity = Math.max(0, w.dailyLimit - reservedToday);
    const percentageUsed =
      w.dailyLimit > 0 ? Math.min(100, Math.round((reservedToday / w.dailyLimit) * 100)) : 0;

    return {
      wallet: w,
      reservedToday,
      availableCapacity,
      percentageUsed,
    };
  });
}

/**
 * Selects an optimal active wallet eligible for a store based on rotation strategy.
 */
export async function assignWalletForPayment(
  db: Database,
  storeId: string,
  provider: 'bkash' | 'nagad',
  amount: number,
  strategy?: 'balanced' | 'fill_first'
): Promise<Wallet | null> {
  const effectiveStrategy = strategy ?? (await getRotationStrategy(db));
  const walletsWithUsage = await getWalletsWithUsage(db, { storeId, provider });

  // Filter only active wallets that have sufficient remaining daily capacity
  const eligible = walletsWithUsage.filter(
    (w) => w.wallet.active === 1 && w.reservedToday + amount <= w.wallet.dailyLimit
  );

  if (eligible.length === 0) {
    return null;
  }

  if (effectiveStrategy === 'fill_first') {
    eligible.sort((a, b) => a.wallet.priority - b.wallet.priority);
    return eligible[0].wallet;
  }

  // Balanced strategy: pick the wallet with the lowest reservedToday
  eligible.sort((a, b) => {
    if (a.reservedToday !== b.reservedToday) {
      return a.reservedToday - b.reservedToday;
    }
    return a.wallet.priority - b.wallet.priority;
  });

  return eligible[0].wallet;
}

/**
 * Returns the list of payment methods currently available for a store and amount.
 */
export async function getAvailableMethodsForStore(
  db: Database,
  storeId: string,
  amount: number,
  codEnabled: number
): Promise<PaymentMethod[]> {
  const methods: PaymentMethod[] = [];
  if (codEnabled === 1) {
    methods.push('cod');
  }

  const bkashWallets = await getWalletsWithUsage(db, { storeId, provider: 'bkash' });
  if (
    bkashWallets.some(
      (w) => w.wallet.active === 1 && w.reservedToday + amount <= w.wallet.dailyLimit
    )
  ) {
    methods.push('bkash');
  }

  const nagadWallets = await getWalletsWithUsage(db, { storeId, provider: 'nagad' });
  if (
    nagadWallets.some(
      (w) => w.wallet.active === 1 && w.reservedToday + amount <= w.wallet.dailyLimit
    )
  ) {
    methods.push('nagad');
  }

  return methods;
}
