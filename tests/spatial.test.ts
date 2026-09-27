import { describe, expect, it } from 'vitest';
import {
  clamp,
  describeRelative,
  directionTo,
  distance,
  floorPoint,
  formatPoint,
  horizontalDistance,
  isSaneCoordinate,
  manhattan,
  round,
  roundPoint,
  yawToDirection,
} from '../src/utils/spatial.js';

describe('distance calculation', () => {
  it('computes 3D euclidean distance', () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(0);
    expect(round(distance({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 3 }), 3)).toBe(5);
  });

  it('ignores the vertical axis for horizontal distance', () => {
    expect(horizontalDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 100, z: 4 })).toBe(5);
  });

  it('computes manhattan distance', () => {
    expect(manhattan({ x: 0, y: 0, z: 0 }, { x: -2, y: 3, z: 4 })).toBe(9);
  });
});

describe('direction calculation', () => {
  // Minecraft convention: -Z is north, +X is east.
  it('maps the four cardinal directions', () => {
    const origin = { x: 0, y: 64, z: 0 };
    expect(directionTo(origin, { x: 0, y: 64, z: -10 })).toBe('north');
    expect(directionTo(origin, { x: 10, y: 64, z: 0 })).toBe('east');
    expect(directionTo(origin, { x: 0, y: 64, z: 10 })).toBe('south');
    expect(directionTo(origin, { x: -10, y: 64, z: 0 })).toBe('west');
  });

  it('maps the four diagonals', () => {
    const origin = { x: 0, y: 64, z: 0 };
    expect(directionTo(origin, { x: 10, y: 64, z: -10 })).toBe('north-east');
    expect(directionTo(origin, { x: 10, y: 64, z: 10 })).toBe('south-east');
    expect(directionTo(origin, { x: -10, y: 64, z: 10 })).toBe('south-west');
    expect(directionTo(origin, { x: -10, y: 64, z: -10 })).toBe('north-west');
  });

  it('reports "here" when the target shares the same column', () => {
    expect(directionTo({ x: 0, y: 64, z: 0 }, { x: 0.2, y: 80, z: -0.3 })).toBe('here');
  });

  it('is unaffected by vertical offset', () => {
    expect(directionTo({ x: 0, y: 64, z: 0 }, { x: 0, y: 5, z: -10 })).toBe('north');
  });

  it('converts yaw to a compass heading', () => {
    // Mineflayer yaw 0 faces +Z (south); pi faces north.
    expect(yawToDirection(0)).toBe('south');
    expect(yawToDirection(Math.PI)).toBe('north');
    expect(yawToDirection(-Math.PI / 2)).toBe('west');
    expect(yawToDirection(Math.PI / 2)).toBe('east');
  });
});

describe('relative spatial description', () => {
  it('reports distance, direction, delta and a vertical hint', () => {
    const described = describeRelative({ x: 127, y: 64, z: -24 }, { x: 132, y: 64, z: -29 });
    expect(described.distance).toBeCloseTo(7.1, 1);
    expect(described.direction).toBe('north-east');
    expect(described.relative).toEqual({ x: 5, y: 0, z: -5 });
    expect(described.verticalHint).toBe('level');
  });

  it('flags targets above and below', () => {
    expect(describeRelative({ x: 0, y: 64, z: 0 }, { x: 5, y: 70, z: 0 }).verticalHint).toBe('above');
    expect(describeRelative({ x: 0, y: 64, z: 0 }, { x: 5, y: 40, z: 0 }).verticalHint).toBe('below');
  });
});

describe('numeric helpers', () => {
  it('rounds without producing negative zero', () => {
    expect(round(-0.004, 2)).toBe(0);
    expect(round(1.2345, 2)).toBe(1.23);
    expect(roundPoint({ x: 1.26, y: -0.02, z: 3.94 }, 1)).toEqual({ x: 1.3, y: 0, z: 3.9 });
  });

  it('floors toward negative infinity, as block coordinates require', () => {
    expect(floorPoint({ x: -0.5, y: 64.9, z: -12.1 })).toEqual({ x: -1, y: 64, z: -13 });
  });

  it('clamps and treats NaN as the minimum', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(Number.NaN, 3, 10)).toBe(3);
  });

  it('formats points compactly', () => {
    expect(formatPoint({ x: 126.4, y: 64.9, z: -30.2 })).toBe('126,65,-30');
  });
});

describe('coordinate sanity checks', () => {
  it('accepts coordinates inside the world border', () => {
    expect(isSaneCoordinate({ x: 0, y: 64, z: 0 })).toBe(true);
    expect(isSaneCoordinate({ x: -29_999_999, y: -60, z: 29_999_999 })).toBe(true);
  });

  it('rejects non-finite and out-of-bounds coordinates', () => {
    expect(isSaneCoordinate({ x: Number.NaN, y: 64, z: 0 })).toBe(false);
    expect(isSaneCoordinate({ x: Number.POSITIVE_INFINITY, y: 64, z: 0 })).toBe(false);
    expect(isSaneCoordinate({ x: 0, y: 99_999, z: 0 })).toBe(false);
    expect(isSaneCoordinate({ x: 1e12, y: 64, z: 0 })).toBe(false);
  });
});
