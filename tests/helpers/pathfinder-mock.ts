/**
 * Stand-in for `mineflayer-pathfinder`.
 *
 * The real `Movements` constructor reads deeply from a live registry and the
 * goal classes pull in the A* implementation; neither is needed to test how the
 * agent *drives* the pathfinder. Only the shapes the code touches are provided.
 *
 * `default` matters: `movement.ts` reaches the `goals` namespace through the
 * CommonJS default binding, because Node's ESM lexer cannot see it by name.
 */
export class Movements {
  public canDig = true;
  public allowParkour = true;
  public allowSprinting = true;
  public allow1by1towers = true;
  public canOpenDoors = true;
  public dontCreateFlow = true;
  public dontMineUnderFallingBlock = true;
  public maxDropDown = 3;
}

export class GoalNear {
  public constructor(
    public x: number,
    public y: number,
    public z: number,
    public range: number,
  ) {}
}

export class GoalGetToBlock {
  public constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}

export const goals = { GoalNear, GoalGetToBlock };

export function pathfinder(): void {
  /* the plugin is never actually injected in tests */
}

/** The module shape a `vi.mock('mineflayer-pathfinder', ...)` factory returns. */
export function pathfinderMockModule(): Record<string, unknown> {
  const moduleExports = { pathfinder, Movements, goals };
  return { ...moduleExports, default: moduleExports };
}
