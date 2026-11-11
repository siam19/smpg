import { BotError } from 'grammy';
import type { BotContext } from '../context';

export function handleBotError(err: BotError<BotContext>) {
  const ctx = err.ctx;
  console.error(`[SMPG Bot Error] Error while handling update ${ctx.update.update_id}:`, err.error);

  // Attempt to notify user if possible
  ctx
    .reply('⚠️ An unexpected error occurred while processing your request. Please try again later.')
    .catch((replyErr) => {
      console.error('[SMPG Bot Error] Failed to send error notification to user:', replyErr);
    });
}
