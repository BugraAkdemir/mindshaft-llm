import type { BlockGroup, EntityInfo } from '../types.js';

/**
 * Everything the System One endpoint answered, normalised.
 *
 * Named `JevAnswers` rather than `AgentEvent` because that name is taken in
 * `src/types.ts` by world-memory events.
 */
export interface JevAnswers {
  /** Winning tool name. Always one of the criteria the request offered. */
  tool: string;
  toolProbabilities: Record<string, number>;
  toolConfidence: number;
  /** Winning block type, or undefined when no candidates were offered. */
  target?: string;
  urgency: 'calm' | 'tense' | 'critical';
  goalComplete: boolean;
  rememberWorth: boolean;
}

/** Matches `DecisionSchema` in `src/llm/parser.ts`, which trims these. */
const REASON_LIMIT = 600;
const REMEMBER_LIMIT = 240;

/** `0.42` not `0.42000000000000004`, and not a bare `0`. */
function percent(value: number): string {
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Top alternatives, so a single winner never reads as certainty. */
function runnerUp(probabilities: Record<string, number>, winner: string): string {
  return Object.entries(probabilities)
    .filter(([name]) => name !== winner)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, p]) => `${name} ${percent(p)}`)
    .join(', ');
}

/**
 * A decision model cannot generate prose, so the reason is rendered from the
 * returned probabilities. It is the audit trail: which action, how sure, and
 * what it was choosing between.
 */
export function formatReason(answers: JevAnswers): string {
  const parts = [`jev: ${answers.tool}`];
  if (answers.target) parts.push(answers.target);
  parts.push(`(p=${percent(answers.toolProbabilities[answers.tool] ?? 0)})`);

  const alternatives = runnerUp(answers.toolProbabilities, answers.tool);
  if (alternatives) parts.push(`| top: ${alternatives}`);
  parts.push(`| urgency=${answers.urgency}`);
  parts.push(`| conf=${percent(answers.toolConfidence)}`);

  return parts.join(' ').slice(0, REASON_LIMIT);
}

/** A state record rather than a model-authored note: goal plus current action. */
export function formatRemember(goal: string, answers: JevAnswers): string {
  const subject = answers.target ? `${answers.tool} ${answers.target}` : answers.tool;
  return `Plan: ${goal} → currently ${subject}`.slice(0, REMEMBER_LIMIT);
}

/** Nearest group of a given block type. */
export function nearestGroup(
  groups: readonly BlockGroup[],
  type: string,
): BlockGroup | undefined {
  return groups.filter((g) => g.type === type).sort((a, b) => a.distance - b.distance)[0];
}

/** Nearest entity of a category. */
export function nearestOf(
  entities: readonly EntityInfo[],
  category: EntityInfo['category'],
): EntityInfo | undefined {
  return entities.filter((e) => e.category === category).sort((a, b) => a.distance - b.distance)[0];
}