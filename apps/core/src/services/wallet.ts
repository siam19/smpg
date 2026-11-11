import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db';
import { merchantWallets, payments, type MerchantWallet } from '../db/schema';

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
  wallet: MerchantWallet;
  reservedToday: number;
  availableCapacity: number;
  percentageUsed: number;
}

/**
 * Calculates current day's reserved taka for all active wallets of a merchant.
 */
export async function getMerchantWalletsWithUsage(
  db: Database,
  merchantId: string,
  provider?: 'bkash' | 'nagad'
): Promise<WalletWithUsage[]> {
  const startOfDay = getDhakaStartOfDayTimestamp();

  // 1. Fetch wallets
  const whereConditions = [eq(merchantWallets.merchantId, merchantId)];
  if (provider) {
    whereConditions.push(eq(merchantWallets.provider, provider));
  }

  const wallets = await db
    .select()
    .from(merchantWallets)
    .where(and(...whereConditions))
    .orderBy(merchantWallets.priority, merchantWallets.createdAt);

  if (wallets.length === 0) {
    return [];
  }

  const walletIds = wallets.map((w) => w.id);

  // 2. Query today's active reserved payments
  // Count payments in CREATED, SUBMITTED, CONFIRMED, or PAID created today
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

  return wallets.map((w) => {
    const reservedToday = usageMap.get(w.id) ?? 0;
    const availableCapacity = Math.max(0, w.dailyLimit - reservedToday);
    const percentageUsed = w.dailyLimit > 0 ? Math.min(100, Math.round((reservedToday / w.dailyLimit) * 100)) : 0;

    return {
      wallet: w,
      reservedToday,
      availableCapacity,
      percentageUsed,
    };
  });
}

/**
 * Selects an optimal active wallet for an incoming payment based on rotation strategy.
 */
export async function assignWalletForPayment(
  db: Database,
  merchantId: string,
  provider: 'bkash' | 'nagad',
  amount: number,
  strategy: 'balanced' | 'fill_first' = 'balanced'
): Promise<MerchantWallet | null> {
  const walletsWithUsage = await getMerchantWalletsWithUsage(db, merchantId, provider);

  // Filter only active wallets that have sufficient capacity
  const eligible = walletsWithUsage.filter(
    (w) => w.wallet.active === 1 && w.reservedToday + amount <= w.wallet.dailyLimit
  );

  if (eligible.length === 0) {
    return null;
  }

  if (strategy === 'fill_first') {
    // Pick the first by priority that still has room
    eligible.sort((a, b) => a.wallet.priority - b.wallet.priority);
    return eligible[0].wallet;
  }

  // Balanced strategy: pick the one with lowest reserved_today
  eligible.sort((a, b) => {
    if (a.reservedToday !== b.reservedToday) {
      return a.reservedToday - b.reservedToday;
    }
    return a.wallet.priority - b.wallet.priority;
  });

  return eligible[0].wallet;
}
