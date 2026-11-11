import { Bot } from 'grammy';
import type { Database } from '../db';
import type { Env } from '../types';
import type { BotContext } from './context';
import { authMiddleware, requireMerchant } from './middleware/auth';
import { handleBotError } from './middleware/error';
import { handleStartCommand } from './commands/start';
import {
  handleAddWalletCommand,
  handleWalletsCommand,
} from './commands/wallets';
import {
  handleBrandColorCommand,
  handleCodToggleCommand,
  handleHelpCommand,
  handleSettingsCommand,
  handleStoreNameCommand,
  handleWebhookCommand,
} from './commands/settings';
import { handleKeysCommand, handleStorePauseCommand } from './commands/keys';
import { handlePaymentsListCommand, handleReopenCommand } from './commands/payments';
import { handleDecisionCallback } from './callbacks/decision';
import { handleUndoCallback } from './callbacks/undo';
import { handleMenuCallback } from './callbacks/menu';
import { handleTextReply } from './handlers/text';

/**
 * Creates and configures the grammY bot instance.
 */
export function createBot(env: Env, db: Database): Bot<BotContext> {
  const botOptions: any = {};

  if (env.BOT_INFO) {
    try {
      botOptions.botInfo = JSON.parse(env.BOT_INFO);
    } catch {
      // Ignore if malformed, grammY will lazily fetch
    }
  }

  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN, botOptions);

  // Inbound error boundary
  bot.catch(handleBotError);

  // Context injection middleware
  bot.use(async (ctx, next) => {
    ctx.env = env;
    ctx.db = db;
    await next();
  });

  // Authentication middleware
  bot.use(authMiddleware);

  // Public / onboarding commands
  bot.command('start', handleStartCommand);
  bot.command('help', handleHelpCommand);

  // Primary interactive dashboards
  bot.command('wallets', requireMerchant, handleWalletsCommand);
  bot.command('settings', requireMerchant, handleSettingsCommand);
  bot.command('payments', requireMerchant, handlePaymentsListCommand);
  bot.command('keys', requireMerchant, handleKeysCommand);

  // Quick action commands (support both direct args & ForceReply prompts)
  bot.command('add_bkash', requireMerchant, (ctx) => handleAddWalletCommand(ctx, 'bkash'));
  bot.command('add_nagad', requireMerchant, (ctx) => handleAddWalletCommand(ctx, 'nagad'));
  bot.command('store_name', requireMerchant, handleStoreNameCommand);
  bot.command('brand_color', requireMerchant, handleBrandColorCommand);
  bot.command('cod', requireMerchant, handleCodToggleCommand);
  bot.command('webhook', requireMerchant, handleWebhookCommand);
  bot.command('pause', requireMerchant, (ctx) => handleStorePauseCommand(ctx, true));
  bot.command('resume', requireMerchant, (ctx) => handleStorePauseCommand(ctx, false));
  bot.command('reopen', requireMerchant, handleReopenCommand);

  // Payment decision callbacks: v1:approve:pay_123:nonce
  bot.callbackQuery(/^v1:(approve|reject|confirm|cancel):([^:]+):.+$/, async (ctx) => {
    const match = ctx.match;
    const action = match[1] as 'approve' | 'reject' | 'confirm' | 'cancel';
    const paymentId = match[2];
    await handleDecisionCallback(ctx, action, paymentId);
  });

  // Payment 90s undo callback: v1:undo:pay_123:nonce
  bot.callbackQuery(/^v1:undo:([^:]+):.+$/, async (ctx) => {
    const paymentId = ctx.match[1];
    await handleUndoCallback(ctx, paymentId);
  });

  // Dashboard navigation and interactive action callbacks
  bot.callbackQuery(/^(menu|wallet|settings|keys|pay):.+$/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    await handleMenuCallback(ctx, data);
  });

  // Handle interactive text replies (from ForceReply prompts)
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.reply_to_message) {
      await handleTextReply(ctx);
      return;
    }
    await next();
  });

  return bot;
}
