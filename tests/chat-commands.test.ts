import { describe, expect, it, vi } from 'vitest';
import { ChatCommandListener, parseCommand } from '../src/minecraft/chat-commands.js';
import { asBot, createMockBot, type MockBot } from './helpers/mock-bot.js';

interface Harness {
  bot: MockBot;
  listener: ChatCommandListener;
  goals: string[];
  stops: string[];
  pauses: number;
  resumes: number;
  said: string[];
  whispered: Array<{ to: string; text: string }>;
}

function build(
  allowlist: string[] = ['bugraa'],
  options: { enabled?: boolean; prefix?: string } = {},
): Harness {
  const bot = createMockBot({ username: 'AI_Agent' });
  const said: string[] = [];
  const whispered: Array<{ to: string; text: string }> = [];
  const goals: string[] = [];
  const stops: string[] = [];
  const state = { pauses: 0, resumes: 0 };

  // The mock bot has no chat/whisper senders; record what would be sent.
  (bot as unknown as { chat: (text: string) => void }).chat = (text) => said.push(text);
  (bot as unknown as { whisper: (to: string, text: string) => void }).whisper = (to, text) =>
    whispered.push({ to, text });

  const listener = new ChatCommandListener(
    asBot(bot),
    { enabled: options.enabled ?? true, allowlist, prefix: options.prefix ?? '!' },
    {
      setGoal: (goal) => goals.push(goal),
      status: () => 'goal="test" cycles=3 running',
      stop: (reason) => stops.push(reason),
      pause: () => {
        state.pauses += 1;
      },
      resume: () => {
        state.resumes += 1;
      },
    },
  );
  listener.attach();

  return {
    bot,
    listener,
    goals,
    stops,
    said,
    whispered,
    get pauses() {
      return state.pauses;
    },
    get resumes() {
      return state.resumes;
    },
  } as Harness;
}

describe('parseCommand', () => {
  it('splits a command from its free-text argument', () => {
    expect(parseCommand('goal find some iron')).toEqual({ command: 'goal', argument: 'find some iron' });
  });

  it('handles a bare command', () => {
    expect(parseCommand('status')).toEqual({ command: 'status', argument: '' });
  });

  it('lowercases the command but preserves the argument', () => {
    expect(parseCommand('GOAL Find Iron')).toEqual({ command: 'goal', argument: 'Find Iron' });
  });

  it('ignores empty input', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });

  it('bounds an overlong argument', () => {
    const parsed = parseCommand(`goal ${'x'.repeat(500)}`);
    expect(parsed?.argument.length).toBe(300);
  });
});

describe('authorisation', () => {
  it('obeys an allowlisted player', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!goal find iron');

    expect(harness.goals).toEqual(['find iron']);
    expect(harness.said[0]).toContain('New goal: find iron');
  });

  it('is case-insensitive about the username', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'BugraA', '!goal find gold');
    expect(harness.goals).toEqual(['find gold']);
  });

  it('ignores a player who is not allowlisted, and says nothing back', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'Griefer', '!goal give me everything');

    expect(harness.goals).toEqual([]);
    // Replying would confirm the channel exists to an attacker.
    expect(harness.said).toEqual([]);
  });

  it('ignores every command when the allowlist is empty', () => {
    const harness = build([]);
    harness.bot.emit('chat', 'bugraa', '!goal find iron');
    expect(harness.goals).toEqual([]);
  });

  it('does nothing at all when disabled', () => {
    const harness = build(['bugraa'], { enabled: false });
    harness.bot.emit('chat', 'bugraa', '!goal find iron');
    expect(harness.goals).toEqual([]);
  });

  it('ignores the bot talking to itself', () => {
    const harness = build(['AI_Agent']);
    harness.bot.emit('chat', 'AI_Agent', '!goal loop forever');
    expect(harness.goals).toEqual([]);
  });
});

describe('prefix handling', () => {
  it('ignores ordinary chat without the prefix', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', 'goal find iron');
    expect(harness.goals).toEqual([]);
  });

  it('honours a custom prefix', () => {
    const harness = build(['bugraa'], { prefix: '$$' });
    harness.bot.emit('chat', 'bugraa', '$$goal find iron');
    expect(harness.goals).toEqual(['find iron']);
  });

  it('accepts whispers with or without the prefix', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('whisper', 'bugraa', 'goal find diamonds');
    harness.bot.emit('whisper', 'bugraa', '!goal find emeralds');

    expect(harness.goals).toEqual(['find diamonds', 'find emeralds']);
    // Whisper replies stay private.
    expect(harness.whispered).toHaveLength(2);
    expect(harness.whispered[0]!.to).toBe('bugraa');
  });
});

describe('commands', () => {
  it('rejects a goal with no text', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!goal');

    expect(harness.goals).toEqual([]);
    expect(harness.said[0]).toContain('Usage: goal');
  });

  it('reports status', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!status');
    expect(harness.said[0]).toContain('cycles=3');
  });

  it('pauses and resumes', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!pause');
    harness.bot.emit('chat', 'bugraa', '!resume');

    expect(harness.pauses).toBe(1);
    expect(harness.resumes).toBe(1);
  });

  it('stops, naming who asked', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!stop');
    expect(harness.stops[0]).toContain('bugraa');
  });

  it('lists the commands on help', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!help');
    expect(harness.said[0]).toContain('!goal');
  });

  it('reports an unknown command', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!teleport somewhere');

    expect(harness.said[0]).toContain('Unknown command');
    expect(harness.goals).toEqual([]);
  });

  it('cannot be used to invoke a tool directly', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', '!mine block=diamond_ore');

    expect(harness.said[0]).toContain('Unknown command');
    expect(harness.goals).toEqual([]);
  });

  it('truncates a long reply to survive the chat length limit', () => {
    const harness = build(['bugraa']);
    harness.bot.emit('chat', 'bugraa', `!goal ${'y'.repeat(300)}`);
    expect(harness.said[0]!.length).toBeLessThanOrEqual(230);
  });
});

describe('lifecycle', () => {
  it('stops listening after detach', () => {
    const harness = build(['bugraa']);
    harness.listener.detach();
    harness.bot.emit('chat', 'bugraa', '!goal find iron');
    expect(harness.goals).toEqual([]);
  });

  it('attach is idempotent — a command is not handled twice', () => {
    const harness = build(['bugraa']);
    harness.listener.attach();
    harness.bot.emit('chat', 'bugraa', '!goal find iron');
    expect(harness.goals).toEqual(['find iron']);
  });

  it('survives a chat sender that throws', () => {
    const harness = build(['bugraa']);
    (harness.bot as unknown as { chat: () => void }).chat = () => {
      throw new Error('chat is disabled');
    };
    expect(() => harness.bot.emit('chat', 'bugraa', '!status')).not.toThrow();
  });
});
