import { Bot } from 'grammy';
import type { Database } from '../db';
import type { Env } from '../types';
import type { BotContext } from './context';
import { authMiddleware, requireOwner } from './middleware/auth';
import { handleBotError } from './middleware/error';
import { handleStartCommand } from './commands/start';
import { handleHelpCommand, handleStoresCommand } from './commands/stores';
import { handleAddWalletCommand, handleWalletsCommand } from './commands/wallets';
import { handlePaymentsListCommand, handleReopenCommand } from './commands/payments';
import { handleTestCommand } from './commands/test';
import { handleDecisionCallback } from './callbacks/decision';
import { handleUndoCallback } from './callbacks/undo';
import { handleMenuCallback } from './callbacks/menu';
import { handleTextReply } from './handlers/text';

/**
 * Creates and configures the single-owner grammY bot instance.
 */
export function createBot(env: Env, db: Database, coreUrl?: string): Bot<BotContext> {
  const botOptions: any = {};

  if (env.BOT_INFO) {
    try {
      botOptions.botInfo = JSON.parse(env.BOT_INFO);
    } catch {
      // Ignore if malformed, grammY will lazily fetch
    }
  }

  const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN.trim(), botOptions);

  // Inbound error boundary
  bot.catch(handleBotError);

  // Context injection middleware
  bot.use(async (ctx, next) => {
    ctx.env = env;
    ctx.db = db;
    ctx.coreUrl = coreUrl;
    await next();
  });

  // Strict single-owner authentication middleware
  bot.use(authMiddleware);

  // Entry & claim command (handles owner lock and SETUP_TOKEN claim internally)
  bot.command('start', handleStartCommand);

  // Owner-only dashboards and commands
  bot.command('help', requireOwner, handleHelpCommand);
  bot.command('stores', requireOwner, handleStoresCommand);
  bot.command('wallets', requireOwner, handleWalletsCommand);
  bot.command('payments', requireOwner, handlePaymentsListCommand);
  bot.command('reopen', requireOwner, handleReopenCommand);
  bot.command('test', requireOwner, handleTestCommand);
  bot.command('add_bkash', requireOwner, (ctx) => handleAddWalletCommand(ctx, 'bkash'));
  bot.command('add_nagad', requireOwner, (ctx) => handleAddWalletCommand(ctx, 'nagad'));

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
  bot.callbackQuery(/^(menu|store|wallet|keys|pay):.+$/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    await handleMenuCallback(ctx, data);
  });

  // Handle incoming text messages (ForceReply prompts & quick payment decisions)
  bot.on('message:text', requireOwner, async (ctx, next) => {
    await handleTextReply(ctx);
    await next();
  });

  return bot;
}
