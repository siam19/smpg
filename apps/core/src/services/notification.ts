import { Bot } from 'grammy';
import type { Database } from '../db';
import type { Merchant, MerchantWallet, Payment } from '../db/schema';
import {
  appendFinalDecisionStatus,
  appendGracePeriodStatus,
  formatCodCard,
  formatSubmittedCard,
} from '../bot/views/cards';
import {
  createCodActionKeyboard,
  createPaymentActionKeyboard,
  createUndoKeyboard,
} from '../bot/views/keyboards';

/**
 * Dispatches a payment submission card to the merchant's Telegram chat.
 */
export async function sendPaymentSubmissionNotification(
  bot: Bot<any>,
  merchant: Merchant,
  payment: Payment,
  wallet?: MerchantWallet | null
): Promise<number | null> {
  try {
    const text = formatSubmittedCard(payment, wallet);
    const keyboard = createPaymentActionKeyboard(payment.id);

    const message = await bot.api.sendMessage(merchant.telegramChatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    return message.message_id;
  } catch (err) {
    console.error(`[Notification] Failed to send submission card for payment ${payment.id}:`, err);
    return null;
  }
}

/**
 * Dispatches a COD confirmation card to the merchant's Telegram chat.
 */
export async function sendCodNotification(
  bot: Bot<any>,
  merchant: Merchant,
  payment: Payment
): Promise<number | null> {
  try {
    const text = formatCodCard(payment);
    const keyboard = createCodActionKeyboard(payment.id);

    const message = await bot.api.sendMessage(merchant.telegramChatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    return message.message_id;
  } catch (err) {
    console.error(`[Notification] Failed to send COD card for payment ${payment.id}:`, err);
    return null;
  }
}

/**
 * Updates an existing notification card to show the 90-second Undo button.
 */
export async function updateCardToGracePeriod(
  bot: Bot<any>,
  chatId: number,
  messageId: number,
  originalText: string,
  action: 'approve' | 'reject' | 'confirm' | 'cancel',
  actor: string,
  paymentId: string
): Promise<boolean> {
  try {
    const now = new Date();
    const effectiveAt = new Date(now.getTime() + 90 * 1000);
    const timeStr = effectiveAt.toLocaleTimeString('en-US', {
      hour12: false,
      timeZone: 'Asia/Dhaka',
    });

    const newText = appendGracePeriodStatus(originalText, action, actor, timeStr);
    const keyboard = createUndoKeyboard(paymentId);

    await bot.api.editMessageText(chatId, messageId, newText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    return true;
  } catch (err) {
    console.error(`[Notification] Failed to update card ${messageId} to grace period:`, err);
    return false;
  }
}

/**
 * Freezes the notification card permanently with a static badge and no buttons.
 */
export async function finalizeNotificationCard(
  bot: Bot<any>,
  chatId: number,
  messageId: number,
  originalCardText: string,
  decision: string,
  actor: string
): Promise<boolean> {
  try {
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      timeZone: 'Asia/Dhaka',
    });

    // Strip previous grace status if present
    const baseCard = originalCardText.split('\n\n<b>⏳')[0].split('\n\n<b>❌ Rejecting')[0];
    const finalText = appendFinalDecisionStatus(baseCard, decision, actor, timeStr);

    await bot.api.editMessageText(chatId, messageId, finalText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });

    return true;
  } catch (err) {
    console.error(`[Notification] Failed to finalize card ${messageId}:`, err);
    return false;
  }
}
