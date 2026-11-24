import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestD1 } from './helpers/mock-d1';
import { botConfig, payments, stores, wallets } from '../src/db/schema';
import {
  assignWalletForPayment,
  getDhakaStartOfDayTimestamp,
  getWalletsWithUsage,
} from '../src/services/wallet';
import { expireStalePayments } from '../src/services/payment';

describe('Wallet Rotation & Cross-Store Daily Cap Services', () => {
  let db: any;

  beforeEach(async () => {
    const setup = createTestD1();
    db = setup.db;

    const now = Math.floor(Date.now() / 1000);

    await db.insert(botConfig).values({
      id: 'default',
      ownerTelegramChatId: 11223344,
      rotationStrategy: 'balanced',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(stores).values([
      {
        id: 'str_alpha',
        name: 'Alpha Shop',
        codEnabled: 1,
        webhookUrl: null,
        webhookSecret: 'enc_alpha',
        paused: 0,
        createdAt: now,
      },
      {
        id: 'str_beta',
        name: 'Beta Shop',
        codEnabled: 1,
        webhookUrl: null,
        webhookSecret: 'enc_beta',
        paused: 0,
        createdAt: now,
      },
    ]);

    await db.insert(wallets).values([
      {
        id: 'wal_shared_1',
        storeId: null, // Shared across all stores
        provider: 'bkash',
        number: '01711111111',
        label: 'Shared bKash',
        dailyLimit: 25000,
        priority: 100,
        active: 1,
        createdAt: now,
      },
      {
        id: 'wal_beta_only',
        storeId: 'str_beta', // Dedicated to Beta Shop
        provider: 'bkash',
        number: '01722222222',
        label: 'Beta Dedicated bKash',
        dailyLimit: 25000,
        priority: 50,
        active: 1,
        createdAt: now,
      },
    ]);
  });

  test('Dhaka start of day timestamp is within the last 24 hours', () => {
    const startOfDay = getDhakaStartOfDayTimestamp();
    const now = Math.floor(Date.now() / 1000);

    expect(startOfDay).toBeLessThanOrEqual(now);
    expect(now - startOfDay).toBeLessThan(86400);
  });

  test('store-scoped wallet is only eligible for its own store', async () => {
    const alphaWallets = await getWalletsWithUsage(db, { storeId: 'str_alpha', provider: 'bkash' });
    expect(alphaWallets.map((w) => w.wallet.id)).toEqual(['wal_shared_1']);

    const betaWallets = await getWalletsWithUsage(db, { storeId: 'str_beta', provider: 'bkash' });
    expect(betaWallets.map((w) => w.wallet.id)).toEqual(['wal_beta_only', 'wal_shared_1']);
  });

  test('enforces daily SIM cap across multiple stores sharing the same wallet', async () => {
    const now = Math.floor(Date.now() / 1000);

    // Store Alpha reserves 20,000 BDT on shared wallet
    await db.insert(payments).values({
      id: 'pay_alpha_1',
      storeId: 'str_alpha',
      mode: 'live',
      method: 'bkash',
      walletId: 'wal_shared_1',
      amount: 20000,
      status: 'PAID',
      expiresAt: now + 3600,
      createdAt: now,
      updatedAt: now,
    });

    // Store Beta queries usage — shared wallet should reflect 20,000 reserved from Alpha
    const usage = await getWalletsWithUsage(db, { storeId: 'str_beta', provider: 'bkash' });
    const sharedUsage = usage.find((w) => w.wallet.id === 'wal_shared_1')!;
    expect(sharedUsage.reservedToday).toBe(20000);
    expect(sharedUsage.availableCapacity).toBe(5000);

    // Store Alpha tries to reserve 6,000 more (exceeds 25,000 cap) -> null
    const assigned = await assignWalletForPayment(db, 'str_alpha', 'bkash', 6000);
    expect(assigned).toBeNull();

    // Store Alpha tries 5,000 -> succeeds on wal_shared_1
    const assignedOk = await assignWalletForPayment(db, 'str_alpha', 'bkash', 5000);
    expect(assignedOk?.id).toBe('wal_shared_1');
  });

  test('expireStalePayments releases reserved wallet capacity automatically', async () => {
    const now = Math.floor(Date.now() / 1000);

    // Expired CREATED payment holding 24,000 BDT on wal_shared_1
    await db.insert(payments).values({
      id: 'pay_stale_1',
      storeId: 'str_alpha',
      mode: 'live',
      method: 'bkash',
      walletId: 'wal_shared_1',
      amount: 24000,
      status: 'CREATED',
      expiresAt: now - 60,
      createdAt: now - 120,
      updatedAt: now - 120,
    });

    // Before expiry, 5,000 cannot fit
    expect(await assignWalletForPayment(db, 'str_alpha', 'bkash', 5000)).toBeNull();

    // Run expiration
    const expiredCount = await expireStalePayments(db);
    expect(expiredCount).toBe(1);

    // After expiry, capacity is released
    const assigned = await assignWalletForPayment(db, 'str_alpha', 'bkash', 5000);
    expect(assigned?.id).toBe('wal_shared_1');
  });
});
