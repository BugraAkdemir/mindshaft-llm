import { fail, ok } from '../types.js';
import { SayArgs } from './schemas.js';
import { defineTool, type Tool } from './registry.js';

/**
 * Speaking.
 *
 * The agent perceives the world as JSON, but the people on the server perceive
 * it as a chat box. Without this tool the bot is mute: a player can ask it
 * something and it has no way to answer, which is why an ordinary question had
 * to be phrased as a goal change before this existed.
 */
const say = defineTool({
  name: 'say',
  description: SayArgs.description ?? 'Send a chat message.',
  schema: SayArgs,
  timeoutMs: 5_000,
  execute: async (args, ctx) => {
    // Newlines would be split into separate chat lines by the server, which is
    // how one "message" becomes several and how a crafted string could fake a
    // second speaker.
    const text = args.message.replace(/\s+/g, ' ').trim();
    if (text === '') return fail('INVALID_ARGUMENTS', 'The message is empty after trimming whitespace.');

    try {
      if (args.to) ctx.bot.whisper(args.to, text);
      else ctx.bot.chat(text);
    } catch (err) {
      return fail(
        'MINEFLAYER_ERROR',
        `Could not send the message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return ok({ said: text, ...(args.to ? { to: args.to, channel: 'whisper' } : { channel: 'public' }) });
  },
});

export const chatTools: Tool[] = [say];
