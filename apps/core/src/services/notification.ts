import { Bot } from 'grammy';
import type { Database } from '../db';
import { botConfig, type Payment, type Wallet } from '../db/schema';
import type { Env } from '../types';
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
 * Resolves the single owner's Telegram chat ID from OWNER_TELEGRAM_ID env var or bot_config.
 */
export async function getOwnerChatId(
  db: Database,
  env?: Pick<Env, 'OWNER_TELEGRAM_ID'>
): Promise<number | null> {
  if (env?.OWNER_TELEGRAM_ID) {
    const parsed = parseInt(env.OWNER_TELEGRAM_ID.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const config = await db.select().from(botConfig).limit(1).get();
  return config?.ownerTelegramChatId ?? null;
}

/**
 * Dispatches a payment submission card to the owner's Telegram chat.
 */
export async function sendPaymentSubmissionNotification(
  bot: Bot<any>,
  ownerChatId: number,
  storeName: string,
  payment: Payment,
  wallet?: Wallet | null
): Promise<number | null> {
  try {
    const text = (formatSubmittedCard as (p: Payment, w?: Wallet | null, s?: string) => string)(
      payment,
      wallet,
      storeName
    );
    const keyboard = createPaymentActionKeyboard(payment.id);

    const message = await bot.api.sendMessage(ownerChatId, text, {
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
 * Dispatches a COD confirmation card to the owner's Telegram chat.
 */
export async function sendCodNotification(
  bot: Bot<any>,
  ownerChatId: number,
  storeName: string,
  payment: Payment
): Promise<number | null> {
  try {
    const text = (formatCodCard as (p: Payment, s?: string) => string)(payment, storeName);
    const keyboard = createCodActionKeyboard(payment.id);

    const message = await bot.api.sendMessage(ownerChatId, text, {
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
 * Updates an existing notification card to show the Undo button during the grace window.
 */
export async function updateCardToGracePeriod(
  bot: Bot<any>,
  chatId: number,
  messageId: number,
  originalText: string,
  action: 'approve' | 'reject' | 'confirm' | 'cancel',
  actor: string,
  paymentId: string,
  undoWindowSeconds = 90
): Promise<boolean> {
  try {
    const now = new Date();
    const effectiveAt = new Date(now.getTime() + undoWindowSeconds * 1000);
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
  baseCardText: string,
  decision: string,
  actor: string
): Promise<boolean> {
  try {
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      timeZone: 'Asia/Dhaka',
    });

    const finalText = appendFinalDecisionStatus(baseCardText, decision, actor, timeStr);

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
