import { describe, expect, test } from 'bun:test';
import { getDhakaStartOfDayTimestamp } from '../src/services/wallet';

describe('Wallet Rotation Services', () => {
  test('Dhaka start of day timestamp is within the last 24 hours', () => {
    const startOfDay = getDhakaStartOfDayTimestamp();
    const now = Math.floor(Date.now() / 1000);

    expect(startOfDay).toBeLessThanOrEqual(now);
    expect(now - startOfDay).toBeLessThan(86400);
  });
});
