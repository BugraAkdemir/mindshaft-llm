import type { Bot } from 'mineflayer';
import { loadConfig, type Config, type MinecraftConfig } from '../../src/config/config.js';
import { BotSession, type SessionEnd } from '../../src/minecraft/bot.js';
import { asBot, type MockBot } from './mock-bot.js';
import type { WorldState } from '../../src/types.js';
import type { LLMProvider, LlmRequest, LlmResponse } from '../../src/llm/provider.js';

/** A fully-populated config with no dependency on the ambient environment. */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig(
    {
      OPENROUTER_API_KEY: 'sk-or-v1-test-key-not-real',
      OPENROUTER_MODEL: 'respan/span-01-lite:free',
      MC_HOST: 'localhost',
      MC_PORT: '25565',
      MC_USERNAME: 'TestAgent',
      AGENT_GOAL: 'Get enough iron to craft an iron pickaxe',
      THINK_INTERVAL_MS: '0',
      CHAT_COMMANDS: 'false',
      CHAT_COMMAND_USERS: '',
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
      ...overrides,
    },
    {},
    true,
  );
}

export function emptyWorldState(overrides: Partial<WorldState> = {}): WorldState {
  const base: WorldState = {
    tick: 1,
    player: {
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      oxygen: 20,
      gamemode: 'survival',
      dimension: 'overworld',
      yaw: 0,
      pitch: 0,
      facing: 'south',
      onGround: true,
      isInWater: false,
      heldItem: null,
      equipment: {},
    },
    environment: {
      time: 6_000,
      timeOfDay: 'noon',
      isDay: true,
      weather: 'clear',
      lightLevel: 15,
      biome: 'plains',
      standingOn: 'grass_block',
    },
    nearbyBlocks: [],
    entities: [],
    inventory: [],
    inventoryCounts: {},
    nearbyPlayers: [],
    threats: [],
  };
  return { ...base, ...overrides };
}

export interface ScriptedTurn {
  /** Response as a native tool call. */
  toolCall?: { name: string; arguments: Record<string, unknown> | string };
  /** Response as raw assistant text (JSON mode, or a malformed reply). */
  content?: string;
  /** Throw instead of answering, to exercise the error paths. */
  throws?: Error;
}

/**
 * Deterministic LLM stand-in. Turns are consumed in order; once the script runs
 * out the last turn repeats, which keeps loop tests from hanging on an
 * unexpected extra cycle.
 */
export class ScriptedProvider implements LLMProvider {
  public readonly name = 'scripted';
  public readonly model = 'scripted/test';
  public readonly requests: LlmRequest[] = [];

  private index = 0;
  private toolsSupported: boolean;

  public constructor(
    private readonly turns: ScriptedTurn[],
    options: { toolsSupported?: boolean } = {},
  ) {
    this.toolsSupported = options.toolsSupported ?? false;
  }

  public supportsToolCalling(): boolean {
    return this.toolsSupported;
  }

  public get callCount(): number {
    return this.requests.length;
  }

  public async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;

    if (!turn) throw new Error('ScriptedProvider has no turns configured');
    if (turn.throws) throw turn.throws;

    if (turn.toolCall) {
      return {
        content: turn.content ?? null,
        toolCalls: [
          {
            id: `call_${this.index}`,
            name: turn.toolCall.name,
            arguments:
              typeof turn.toolCall.arguments === 'string'
                ? turn.toolCall.arguments
                : JSON.stringify(turn.toolCall.arguments),
          },
        ],
        model: this.model,
        finishReason: 'tool_calls',
        latencyMs: 1,
      };
    }

    return {
      content: turn.content ?? null,
      toolCalls: [],
      model: this.model,
      finishReason: 'stop',
      latencyMs: 1,
    };
  }
}

/** Builds a JSON-mode decision string the way a well-behaved model would. */
export function decisionJson(
  tool: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ reason: `testing ${tool}`, tool, arguments: args, ...extra });
}

/**
 * A `BotSession` that hands back a mock bot instead of dialling a server, so the
 * full agent pipeline can be exercised offline.
 */
export class FakeBotSession extends BotSession {
  private ended: SessionEnd | null = null;
  private waiters: Array<(end: SessionEnd) => void> = [];

  public constructor(
    private readonly mock: MockBot,
    cfg: MinecraftConfig,
  ) {
    super(cfg);
  }

  public override async connect(): Promise<Bot> {
    return asBot(this.mock);
  }

  public override get bot(): Bot {
    return asBot(this.mock);
  }

  public override get isConnected(): boolean {
    return this.ended === null;
  }

  public override get endState(): SessionEnd | null {
    return this.ended;
  }

  public override waitForEnd(): Promise<SessionEnd> {
    if (this.ended) return Promise.resolve(this.ended);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  public override quit(reason = 'test shutdown'): void {
    this.finishSession({ reason: 'quit', details: reason });
    // Mirror the real session, which forwards the disconnect to the bot.
    this.mock.quit(reason);
  }

  /** Simulates the server dropping the connection. */
  public simulateDisconnect(details = 'server closed the connection'): void {
    this.finishSession({ reason: 'end', details });
  }

  private finishSession(end: SessionEnd): void {
    if (this.ended) return;
    this.ended = end;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(end);
  }
}
