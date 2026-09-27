import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseArgs } from '../src/config/config.js';

const MINIMAL_ENV = { OPENROUTER_API_KEY: 'sk-or-v1-test' };

describe('CLI parsing', () => {
  it('parses every supported flag in "--flag value" form', () => {
    const { overrides, errors } = parseArgs([
      '--goal', 'Find iron',
      '--model', 'anthropic/claude-sonnet-4',
      '--host', 'mc.example.com',
      '--port', '25577',
      '--username', 'Bob',
      '--mode', 'json',
      '--debug',
    ]);

    expect(errors).toEqual([]);
    expect(overrides).toEqual({
      goal: 'Find iron',
      model: 'anthropic/claude-sonnet-4',
      host: 'mc.example.com',
      port: 25_577,
      username: 'Bob',
      mode: 'json',
      debug: true,
    });
  });

  it('parses "--flag=value" form', () => {
    const { overrides, errors } = parseArgs(['--goal=Get diamonds', '--port=25566']);
    expect(errors).toEqual([]);
    expect(overrides.goal).toBe('Get diamonds');
    expect(overrides.port).toBe(25_566);
  });

  it('preserves spaces and quotes inside a goal', () => {
    const { overrides } = parseArgs(['--goal', 'Get enough iron to craft an iron pickaxe']);
    expect(overrides.goal).toBe('Get enough iron to craft an iron pickaxe');
  });

  it('detects --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('reports unknown flags rather than ignoring them', () => {
    const { errors } = parseArgs(['--goal', 'x', '--turbo']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--turbo');
  });

  it('reports a flag that is missing its value', () => {
    expect(parseArgs(['--goal']).errors[0]).toContain('requires a value');
    expect(parseArgs(['--goal', '--debug']).errors[0]).toContain('requires a value');
  });

  it('validates the port range', () => {
    expect(parseArgs(['--port', '0']).errors[0]).toContain('Invalid --port');
    expect(parseArgs(['--port', '70000']).errors[0]).toContain('Invalid --port');
    expect(parseArgs(['--port', 'abc']).errors[0]).toContain('Invalid --port');
  });

  it('validates the LLM mode', () => {
    expect(parseArgs(['--mode', 'JSON']).overrides.mode).toBe('json');
    expect(parseArgs(['--mode', 'telepathy']).errors[0]).toContain('Invalid --mode');
  });

  it('rejects stray positional arguments', () => {
    expect(parseArgs(['find', 'iron']).errors).toHaveLength(2);
  });

  it('returns nothing for an empty argv', () => {
    expect(parseArgs([])).toEqual({ overrides: {}, help: false, errors: [] });
  });
});

describe('config loading', () => {
  it('applies documented defaults', () => {
    const cfg = loadConfig(MINIMAL_ENV, {}, true);

    expect(cfg.llm.model).toBe('respan/span-01-lite:free');
    expect(cfg.llm.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.llm.mode).toBe('auto');
    expect(cfg.minecraft.host).toBe('localhost');
    expect(cfg.minecraft.port).toBe(25_565);
    expect(cfg.minecraft.username).toBe('AI_Agent');
    expect(cfg.minecraft.auth).toBe('offline');
    expect(cfg.agent.thinkIntervalMs).toBe(3_000);
    expect(cfg.agent.observationRadius).toBe(12);
    expect(cfg.agent.maxMoveDistance).toBe(64);
    expect(cfg.agent.maxActionTimeoutMs).toBe(30_000);
    expect(cfg.agent.maxConsecutiveFailures).toBe(5);
    expect(cfg.agent.reactiveSafety).toBe(true);
  });

  it('requires an API key by default and can be told not to', () => {
    expect(() => loadConfig({}, {}, true)).toThrow(ConfigError);
    expect(() => loadConfig({}, {}, true)).toThrow(/OPENROUTER_API_KEY/);
    expect(loadConfig({}, {}, false).llm.apiKey).toBe('');
  });

  it('treats a whitespace-only API key as missing', () => {
    expect(() => loadConfig({ OPENROUTER_API_KEY: '   ' }, {}, true)).toThrow(ConfigError);
  });

  it('lets CLI overrides win over the environment', () => {
    const cfg = loadConfig(
      { ...MINIMAL_ENV, MC_HOST: 'from-env', AGENT_GOAL: 'env goal' },
      { host: 'from-cli', goal: 'cli goal', port: 12_345, mode: 'tools' },
      true,
    );

    expect(cfg.minecraft.host).toBe('from-cli');
    expect(cfg.minecraft.port).toBe(12_345);
    expect(cfg.agent.goal).toBe('cli goal');
    expect(cfg.llm.mode).toBe('tools');
  });

  it('maps --debug onto the log level', () => {
    expect(loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'warn' }, { debug: true }, true).log.level).toBe('debug');
    expect(loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'warn' }, {}, true).log.level).toBe('warn');
  });

  it('parses boolean env vars in every common spelling', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(loadConfig({ ...MINIMAL_ENV, REACTIVE_SAFETY: value }, {}, true).agent.reactiveSafety).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'off']) {
      expect(loadConfig({ ...MINIMAL_ENV, REACTIVE_SAFETY: value }, {}, true).agent.reactiveSafety).toBe(false);
    }
  });

  it('treats blank values as unset rather than as errors', () => {
    const cfg = loadConfig({ ...MINIMAL_ENV, MC_PORT: '', OBSERVATION_RADIUS: '  ' }, {}, true);
    expect(cfg.minecraft.port).toBe(25_565);
    expect(cfg.agent.observationRadius).toBe(12);
  });

  it('rejects out-of-range numeric settings with a readable message', () => {
    expect(() => loadConfig({ ...MINIMAL_ENV, MC_PORT: '99999' }, {}, true)).toThrow(/MC_PORT/);
    expect(() => loadConfig({ ...MINIMAL_ENV, OBSERVATION_RADIUS: '1000' }, {}, true)).toThrow(
      /OBSERVATION_RADIUS/,
    );
    expect(() => loadConfig({ ...MINIMAL_ENV, LLM_TEMPERATURE: '9' }, {}, true)).toThrow(/LLM_TEMPERATURE/);
  });

  it('rejects non-numeric values for numeric settings', () => {
    expect(() => loadConfig({ ...MINIMAL_ENV, THINK_INTERVAL_MS: 'soon' }, {}, true)).toThrow(
      /THINK_INTERVAL_MS/,
    );
  });

  it('rejects an invalid enum value', () => {
    expect(() => loadConfig({ ...MINIMAL_ENV, MC_AUTH: 'cracked' }, {}, true)).toThrow(/MC_AUTH/);
    expect(() => loadConfig({ ...MINIMAL_ENV, LLM_MODE: 'vibes' }, {}, true)).toThrow(/LLM_MODE/);
    expect(() => loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'loud' }, {}, true)).toThrow(/LOG_LEVEL/);
  });

  it('normalises the base URL by stripping trailing slashes', () => {
    const cfg = loadConfig({ ...MINIMAL_ENV, OPENROUTER_BASE_URL: 'https://example.com/v1///' }, {}, true);
    expect(cfg.llm.baseUrl).toBe('https://example.com/v1');
  });

  it('keeps the critical-health threshold at or below the panic threshold', () => {
    const cfg = loadConfig({ ...MINIMAL_ENV, PANIC_HEALTH: '5', CRITICAL_HEALTH: '12' }, {}, true);
    expect(cfg.agent.criticalHealth).toBe(5);
  });

  it('leaves an unset Minecraft version undefined so it is auto-detected', () => {
    expect(loadConfig(MINIMAL_ENV, {}, true).minecraft.version).toBeUndefined();
    expect(loadConfig({ ...MINIMAL_ENV, MC_VERSION: '1.20.4' }, {}, true).minecraft.version).toBe('1.20.4');
  });
});
