import { InlineKeyboard } from 'grammy';
import { randomBytesHex } from '../../services/crypto';

/**
 * Creates inline buttons for new bKash / Nagad submissions.
 */
export function createPaymentActionKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard()
    .text('✅ Approve', `v1:approve:${paymentId}:${nonce}`)
    .text('❌ Reject', `v1:reject:${paymentId}:${nonce}`);
}

/**
 * Creates inline buttons for new COD orders.
 */
export function createCodActionKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard()
    .text('✅ Confirm', `v1:confirm:${paymentId}:${nonce}`)
    .text('❌ Cancel', `v1:cancel:${paymentId}:${nonce}`);
}

/**
 * Creates inline button for the 90-second Undo grace period.
 */
export function createUndoKeyboard(paymentId: string): InlineKeyboard {
  const nonce = randomBytesHex(4);
  return new InlineKeyboard().text('↩ Undo', `v1:undo:${paymentId}:${nonce}`);
}
