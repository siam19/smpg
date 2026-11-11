import { Bot } from 'grammy';
import type { Database } from '../db';
import type { Env } from '../types';
import type { BotContext } from './context';
import { authMiddleware, requireMerchant } from './middleware/auth';
import { handleBotError } from './middleware/error';
import { handleStartCommand } from './commands/start';
import {
  handleAddWalletCommand,
  handleRotationCommand,
  handleWalletLimitCommand,
  handleWalletsCommand,
  handleWalletToggleCommand,
} from './commands/wallets';
import {
  handleBrandColorCommand,
  handleCodToggleCommand,
  handleHelpCommand,
  handleStoreNameCommand,
  handleWebhookCommand,
} from './commands/settings';
import { handleKeysCommand, handleStorePauseCommand } from './commands/keys';
import { handlePaymentsListCommand, handleReopenCommand } from './commands/payments';
import { handleDecisionCallback } from './callbacks/decision';
import { handleUndoCallback } from './callbacks/undo';

/**
 * Creates and configures the grammY bot instance.
 */
export function createBot(env: Env, db: Database): Bot<BotContext> {
  const botOptions: any = {};

  // Pre-supplied bot info to avoid getMe API network latency on worker cold start
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

  // Merchant-protected commands
  bot.command('wallets', requireMerchant, handleWalletsCommand);
  bot.command('add_bkash', requireMerchant, (ctx) => handleAddWalletCommand(ctx, 'bkash'));
  bot.command('add_nagad', requireMerchant, (ctx) => handleAddWalletCommand(ctx, 'nagad'));
  bot.command('wallet_limit', requireMerchant, handleWalletLimitCommand);
  bot.command('wallet_pause', requireMerchant, (ctx) => handleWalletToggleCommand(ctx, false));
  bot.command('wallet_resume', requireMerchant, (ctx) => handleWalletToggleCommand(ctx, true));
  bot.command('rotation', requireMerchant, handleRotationCommand);

  bot.command('store_name', requireMerchant, handleStoreNameCommand);
  bot.command('brand_color', requireMerchant, handleBrandColorCommand);
  bot.command('cod', requireMerchant, handleCodToggleCommand);
  bot.command('webhook', requireMerchant, handleWebhookCommand);

  bot.command('keys', requireMerchant, handleKeysCommand);
  bot.command('pause', requireMerchant, (ctx) => handleStorePauseCommand(ctx, true));
  bot.command('resume', requireMerchant, (ctx) => handleStorePauseCommand(ctx, false));

  bot.command('payments', requireMerchant, handlePaymentsListCommand);
  bot.command('reopen', requireMerchant, handleReopenCommand);

  // Inline callback query handlers
  bot.callbackQuery(/^v1:(approve|reject|confirm|cancel):([^:]+):.+$/, async (ctx) => {
    const match = ctx.match;
    const action = match[1] as 'approve' | 'reject' | 'confirm' | 'cancel';
    const paymentId = match[2];
    await handleDecisionCallback(ctx, action, paymentId);
  });

  bot.callbackQuery(/^v1:undo:([^:]+):.+$/, async (ctx) => {
    const paymentId = ctx.match[1];
    await handleUndoCallback(ctx, paymentId);
  });

  return bot;
}
