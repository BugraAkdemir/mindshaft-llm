import { Vec3 } from 'vec3';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** The eight compass headings plus the degenerate "here" case. */
export type Direction =
  | 'north'
  | 'north-east'
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west'
  | 'north-west'
  | 'here';

export interface RelativeSpatial {
  distance: number;
  direction: Direction;
  relative: Point3;
  verticalHint: 'above' | 'below' | 'level';
}

export function toPoint(v: Point3): Point3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function toVec3(p: Point3): Vec3 {
  return new Vec3(p.x, p.y, p.z);
}

/** Rounds to `digits` decimals and normalises `-0` to `0`. */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  const result = Math.round(value * factor) / factor;
  return result === 0 ? 0 : result;
}

export function roundPoint(p: Point3, digits = 1): Point3 {
  return { x: round(p.x, digits), y: round(p.y, digits), z: round(p.z, digits) };
}

export function floorPoint(p: Point3): Point3 {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

export function distance(a: Point3, b: Point3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal (XZ-plane) distance — the one that matters for pathfinding cost. */
export function horizontalDistance(a: Point3, b: Point3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function manhattan(a: Point3, b: Point3): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

export function subtract(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function add(a: Point3, b: Point3): Point3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Compass direction from `from` to `to` using Minecraft's axis convention:
 * -Z is north, +X is east. Returns `'here'` when the two points share a column.
 */
export function directionTo(from: Point3, to: Point3): Direction {
  const dx = to.x - from.x;
  const dz = to.z - from.z;

  // Anything under half a block horizontally is "the same place".
  if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return 'here';

  // atan2(east, north) — north is -Z, so the north component is -dz.
  const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const normalized = (degrees + 360) % 360;

  const sectors: Direction[] = [
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
  ];
  // 45-degree sectors centred on each heading.
  const index = Math.round(normalized / 45) % 8;
  return sectors[index] as Direction;
}

/**
 * Full relative description of `target` as seen from `origin`. This is the
 * representation the LLM actually reasons over — absolute coordinates alone are
 * hard for a text model to turn into movement decisions.
 */
export function describeRelative(origin: Point3, target: Point3): RelativeSpatial {
  const rel = subtract(target, origin);
  const dy = rel.y;
  return {
    distance: round(distance(origin, target), 1),
    direction: directionTo(origin, target),
    relative: { x: round(rel.x, 0), y: round(rel.y, 0), z: round(rel.z, 0) },
    verticalHint: dy > 1 ? 'above' : dy < -1 ? 'below' : 'level',
  };
}

/** Converts a yaw (radians, Minecraft convention) to a compass heading. */
export function yawToDirection(yaw: number): Direction {
  // Minecraft yaw 0 faces +Z (south) and increases counter-clockwise.
  const degrees = ((-yaw * 180) / Math.PI + 180 + 360) % 360;
  const sectors: Direction[] = [
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
  ];
  return sectors[Math.round(degrees / 45) % 8] as Direction;
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** True when every component is finite and inside Minecraft's world bounds. */
export function isSaneCoordinate(p: Point3): boolean {
  const horizontalLimit = 30_000_000;
  const verticalLimit = 1024;
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z) &&
    Math.abs(p.x) <= horizontalLimit &&
    Math.abs(p.z) <= horizontalLimit &&
    Math.abs(p.y) <= verticalLimit
  );
}

/** Formats a point compactly for prompts and log lines. */
export function formatPoint(p: Point3, digits = 0): string {
  const r = roundPoint(p, digits);
  return `${r.x},${r.y},${r.z}`;
}
