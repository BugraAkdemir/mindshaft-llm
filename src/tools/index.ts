import { ToolRegistry } from './registry.js';
import { chatTools } from './chat-tools.js';
import { combatTools } from './combat-tools.js';
import { inventoryTools } from './inventory-tools.js';
import { movementTools } from './movement-tools.js';
import { worldTools } from './world-tools.js';
import type { Logger } from '../utils/logger.js';

export { ToolRegistry, defineTool } from './registry.js';
export type { Tool, ToolContext, ToolDefinition } from './registry.js';

/** Builds the full registry the agent runs with. */
export function createToolRegistry(logger?: Logger): ToolRegistry {
  const registry = new ToolRegistry(logger);
  registry.registerAll([
    ...worldTools,
    ...movementTools,
    ...combatTools,
    ...inventoryTools,
    ...chatTools,
  ]);
  return registry;
}
