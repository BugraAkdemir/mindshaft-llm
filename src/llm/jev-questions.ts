import type { LlmRequest, LlmToolSpec } from './provider.js';
import type { WorldState } from '../types.js';

/* ────────────────────────────── wire shapes ─────────────────────────────── */

export interface JevQuestion {
  /** `noul` is a yes/no probability, `choice` picks a criterion, `score` rates a rubric. */
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  /** For `choice`: label → meaning. For `score`: the rubric, ordered. */
  criteria?: Record<string, string> | string[];
}

export interface JevPayload {
  model: string;
  state: string;
  questions: Record<string, JevQuestion>;
}

/** Enough candidates to be useful, few enough that each stays meaningful. */
const MAX_TARGETS = 8;

/* ─────────────────────────────── state string ───────────────────────────── */

/**
 * Jev has no conversation memory, so the whole context is one string: the
 * standing rules, then the current situation. Only the latest user message is
 * used — earlier turns describe a world that has since moved on.
 */
export function buildState(request: LlmRequest): string {
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const latest = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return ['== Standing instructions ==', system.trim(), '== Current situation ==', latest.trim()].join(
    '\n\n',
  );
}

/* ──────────────────────────────── candidates ────────────────────────────── */

/** Nearby block types, nearest first. */
export function candidateTargets(observation: WorldState | undefined): string[] {
  return [...(observation?.nearbyBlocks ?? [])]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_TARGETS)
    .map((group) => group.type);
}

/** Tool name → description. The catalogue, as choice criteria. */
function toolCriteria(tools: readonly LlmToolSpec[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const tool of tools) criteria[tool.name] = tool.description;
  return criteria;
}

/* ──────────────────────────────── payload ───────────────────────────────── */

/**
 * Every question is evaluated in parallel against the same state, so the whole
 * turn costs one HTTP request.
 */
export function buildPayload(request: LlmRequest, model = 'jev-1.13-free'): JevPayload {
  const targets = candidateTargets(request.observation);

  const questions: Record<string, JevQuestion> = {
    tool: {
      type: 'choice',
      instructions:
        'Which single action should the bot take right now, given its goal and situation? ' +
        'Answer with exactly one of the listed actions.',
      criteria: toolCriteria(request.tools ?? []),
    },
    urgency: {
      type: 'score',
      instructions: 'How much does the bot need to act urgently right now?',
      criteria: ['calm', 'tense', 'critical'],
    },
    goal_complete: {
      type: 'noul',
      instructions: 'Has the bot fully achieved its goal and can it stop now?',
    },
    remember_worth: {
      type: 'noul',
      instructions:
        'Is this step important enough to be remembered for future cycles, rather than forgotten immediately?',
    },
  };

  // Only ask about a target when there is one to ask about; an empty choice
  // question would push the model toward a meaningless answer.
  if (targets.length > 0) {
    const counts = new Map(
      (request.observation?.nearbyBlocks ?? []).map((group) => [group.type, group.count]),
    );
    questions['target'] = {
      type: 'choice',
      instructions:
        'Which of these blocks or items should the action apply to? Choose the one that best ' +
        'advances the goal. The number is how many are in reach.',
      criteria: Object.fromEntries(targets.map((type) => [type, String(counts.get(type) ?? 1)])),
    };
  }

  return { model, state: buildState(request), questions };
}