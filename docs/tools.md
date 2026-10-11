# Tool reference

The model cannot execute code. It can only choose one of these 18 tools, and every argument is
validated against a Zod schema before anything touches Mineflayer.

| Tool          | Arguments                                        | Does |
| ------------- | ------------------------------------------------ | ---- |
| `observe`     | `focus?`                                         | Re-read the world without acting. |
| `move_to`     | `x`, `y`, `z`, `range?`                          | Pathfind to a position (handles jumping, doors, digging, parkour). |
| `look_at`     | `x`/`y`/`z`, or `entity_id`, or `yaw`/`pitch`    | Turn to face something. |
| `mine`        | `block?`, `x?`/`y?`/`z?`, `count?`, `collect?`   | Break a block, equipping the best tool and collecting drops. |
| `place_block` | `item`, `x`, `y`, `z`                            | Place a block from the inventory. |
| `attack`      | `entity?`, `entity_id?`, `max_swings?`           | Melee a mob, closing distance and equipping the best weapon. |
| `equip`       | `item`, `destination?`                           | Equip to hand, armour slot, or off-hand. |
| `eat`         | `item?`                                          | Eat, choosing sensibly when no item is named. |
| `craft`       | `item`, `count?`                                 | Craft, using a nearby crafting table when the recipe needs one. |
| `smelt`       | `item`, `count?`, `fuel?`                        | Smelt in a nearby furnace, picking fuel automatically. |
| `collect`     | `item?`, `radius?`, `max_items?`                 | Walk to dropped stacks and pick them up. |
| `interact`    | `block?`, `x?`/`y?`/`z?`                         | Right-click a block: doors, levers, buttons, beds. |
| `jump`        | `count?`                                         | Jump in place. |
| `pillar_up`   | `height?`, `item?`                               | Place a block under your own feet, one per jump, to climb out of a hole. |
| `sneak`       | `enabled`                                        | Toggle sneaking. |
| `sprint`      | `enabled`                                        | Toggle sprinting. |
| `wait`        | `seconds`, `reason?`                             | Do nothing for a while. |
| `say`         | `message`, `to?`                                 | Speak in public chat, or whisper one player. |

Every tool returns a structured result. Failures carry a machine-readable code and a detail
string written for the model to act on:

```json
{
  "success": false,
  "error": "PATH_NOT_FOUND",
  "details": "No reachable path to (126, 64, -30) from (100.2, 64.0, -12.4). The target may be enclosed, across a gap, or too high — pick an intermediate waypoint."
}
```

Error codes include `PATH_NOT_FOUND`, `PATH_TIMEOUT`, `PATH_INTERRUPTED`, `TARGET_TOO_FAR`,
`BLOCK_NOT_FOUND`, `UNKNOWN_ITEM`, `UNKNOWN_BLOCK`, `MISSING_INGREDIENTS`,
`CRAFTING_TABLE_REQUIRED`, `FURNACE_REQUIRED`, `NO_FUEL`, `NOT_EDIBLE`, `TIMEOUT`, `ABORTED`,
`UNSAFE`, and `INVALID_ARGUMENTS`.
