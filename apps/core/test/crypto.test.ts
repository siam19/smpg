import { describe, expect, test } from 'bun:test';
import {
  decryptAesGcm,
  encryptAesGcm,
  generateApiKey,
  generatePrefixedId,
  generateWebhookSecret,
  sha256,
} from '../src/services/crypto';

describe('Crypto Utilities', () => {
  const testKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  test('generates valid IDs and keys', () => {
    const mrcId = generatePrefixedId('mrc');
    expect(mrcId.startsWith('mrc_')).toBeTrue();

    const liveKey = generateApiKey('live');
    expect(liveKey.key.startsWith('smpg_live_')).toBeTrue();
    expect(liveKey.prefix.startsWith('smpg_live_')).toBeTrue();

    const secret = generateWebhookSecret();
    expect(secret.startsWith('whsec_')).toBeTrue();
  });

  test('SHA-256 generates consistent hex output', async () => {
    const hash1 = await sha256('hello world');
    const hash2 = await sha256('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  test('AES-GCM encrypts and decrypts accurately', async () => {
    const plaintext = 'whsec_my_super_secret_webhook_key_999';
    const encrypted = await encryptAesGcm(plaintext, testKeyHex);

    expect(encrypted).toContain(':');
    expect(encrypted).not.toBe(plaintext);

    const decrypted = await decryptAesGcm(encrypted, testKeyHex);
    expect(decrypted).toBe(plaintext);
  });
});
