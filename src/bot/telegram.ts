// Thin grammY layer: connects Telegram to BotService and implements AlertSender.
import { Bot, GrammyError, HttpError } from 'grammy';
import { PermanentSendError, RetryAfterError, type AlertSender } from '../monitor/dispatcher.js';
import { log } from '../lib/log.js';
import { BOT_COMMANDS, type BotService } from './BotService.js';

export function createTelegramBot(token: string, service: BotService): Bot {
  const bot = new Bot(token);

  bot.on('message:text', async (ctx) => {
    // Private chats only: in groups, other members would see wallet addresses and positions.
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Please talk to me in a private chat.');
      return;
    }
    const res = await service.handle(String(ctx.chat.id), ctx.message.text);
    if (res.deleteMessage) await ctx.deleteMessage().catch(() => log.warn('could not delete a message that looked like a secret'));
    for (const text of res.replies) await ctx.reply(text, { link_preview_options: { is_disabled: true } });
  });

  bot.catch((err) => {
    // Never log message contents (they can contain wallet addresses); just the error type.
    const e = err.error;
    log.error(`telegram handler error: ${e instanceof GrammyError ? `${e.error_code} ${e.description}` : e instanceof HttpError ? 'network error' : String(e).slice(0, 200)}`);
  });

  return bot;
}

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description.slice(0, 256) })));
}

export function telegramSender(bot: Bot): AlertSender {
  return {
    async send(chatId, text) {
      try {
        await bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 403) throw new PermanentSendError('user blocked the bot', true);
          if (err.error_code === 400) throw new PermanentSendError(`bad request: ${err.description}`);
          if (err.error_code === 429) throw new RetryAfterError('rate limited', (err.parameters.retry_after ?? 5) * 1000);
        }
        throw err instanceof Error ? new Error(err.message.slice(0, 200)) : new Error('send failed');
      }
    },
  };
}
