/**
 * Cryptographic utilities using standard Web Crypto API (supported on Cloudflare Workers & Node 18+).
 */

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.trim();
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Computes a SHA-256 hash returned as a lowercase hex string.
 */
export async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Generates a random alphanumeric or hex string of specified byte length.
 */
export function randomBytesHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Generates a prefixed ID (e.g. mrc_9a8b7c, pay_123abc, wal_xyz).
 */
export function generatePrefixedId(prefix: string): string {
  const random = randomBytesHex(8);
  return `${prefix}_${random}`;
}

/**
 * Generates an API key pair string (e.g. smpg_live_..., smpg_test_...).
 */
export function generateApiKey(mode: 'test' | 'live'): { key: string; prefix: string } {
  const random = randomBytesHex(16);
  const prefix = `smpg_${mode}_${random.slice(0, 6)}`;
  const key = `${prefix}_${random.slice(6)}`;
  return { key, prefix };
}

/**
 * Generates a merchant webhook secret (whsec_...).
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytesHex(24)}`;
}

/**
 * Encrypts a plaintext string using AES-GCM-256.
 *
 * @param plaintext Text to encrypt
 * @param hexKey 64-character hex key (256 bits)
 * @returns Encrypted string in format "iv_hex:ciphertext_hex"
 */
export async function encryptAesGcm(plaintext: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV standard for AES-GCM

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.sign
    ? await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plaintext))
    : await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(plaintext));

  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypts an AES-GCM-256 encrypted string ("iv_hex:ciphertext_hex").
 *
 * @param encrypted Encrypted string
 * @param hexKey 64-character hex key (256 bits)
 * @returns Plaintext string
 */
export async function decryptAesGcm(encrypted: string, hexKey: string): Promise<string> {
  const [ivHex, cipherHex] = encrypted.split(':');
  if (!ivHex || !cipherHex) {
    throw new Error('Malformed encrypted payload');
  }

  const keyBytes = hexToBytes(hexKey);
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(cipherHex);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}
