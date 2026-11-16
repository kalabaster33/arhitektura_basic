/**
 * Doors and windows. An opening lives on one wall and is placed by the distance
 * from the wall's `a` end to its centre.
 *
 * An opening has to fit in a free stretch of its wall: inside the wall's
 * length, clear of every wall that joins or crosses it, of the columns and of
 * the other openings. A load-bearing wall drawn by hand has no free stretch. Operations that would break that return the storey unchanged or
 * move the opening to the nearest place where it fits.
 */
import {
  type Pt,
  NODE_TOL,
  dist,
  distToSegment,
  lerp,
  lineIntersectionParams,
  pointInPolygon,
  projectParam,
} from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Column, Opening, OpeningKind, Storey, Wall } from "./model.ts";
import { type LinkedSpaces, linkSpaces } from "./spaces.ts";

const EPS = 1e-9;
const round = (v: number) => Math.round(v * 1e6) / 1e6;

export interface OpeningSize {
  width: number;
  height: number;
  sill: number;
}

/** Stretches of a wall, as distances from its `a` end, where an opening may sit. */
export function wallFreeSpans(storey: Storey, wall: Wall): [number, number][] {
  return freeSpans(storey.walls, storey.openings, wall, undefined, storey.columns);
}

/**
 * The stretches of a wall, as distances from its `a` end, that columns stand
 * in: where the wall's band (its centreline widened to its thickness) passes
 * through a column. Sorted, not merged.
 */
export function columnSpansOnWall(wall: Wall, columns: readonly Column[] | undefined): [number, number][] {
  const length = dist(wall.a, wall.b);
  if (!columns?.length || length < EPS) return [];
  const dir = { x: (wall.b.x - wall.a.x) / length, y: (wall.b.y - wall.a.y) / length };
  const half = wall.thickness / 2;
  const spans: [number, number][] = [];
  for (const c of columns) {
    // The column widened across the wall by half its thickness, so a column
    // touching only a wall face still counts.
    const gx = half * Math.abs(dir.y);
    const gy = half * Math.abs(dir.x);
    const min = { x: c.at.x - c.w / 2 - gx, y: c.at.y - c.d / 2 - gy };
    const max = { x: c.at.x + c.w / 2 + gx, y: c.at.y + c.d / 2 + gy };
    // Liang-Barsky: the part of the centreline inside the rectangle.
    let lo = 0;
    let hi = length;
    const clip = (p: number, q: number): boolean => {
      if (Math.abs(p) < EPS) return q >= -EPS;
      const r = q / p;
      if (p < 0) lo = Math.max(lo, r);
      else hi = Math.min(hi, r);
      return lo <= hi + EPS;
    };
    const ok =
      clip(-dir.x, wall.a.x - min.x) &&
      clip(dir.x, max.x - wall.a.x) &&
      clip(-dir.y, wall.a.y - min.y) &&
      clip(dir.y, max.y - wall.a.y);
    if (ok && hi - lo > EPS) spans.push([lo, hi]);
  }
  return spans.sort((p, q) => p[0] - q[0]);
}

function freeSpans(
  walls: Wall[],
  openings: Opening[],
  wall: Wall,
  ignoreOpeningId?: string,
  columns?: readonly Column[],
): [number, number][] {
  // A load-bearing wall takes no openings at all.
  if (wall.loadBearing && !wall.part) return [];
  const length = dist(wall.a, wall.b);
  const blocked: [number, number][] = columnSpansOnWall(wall, columns);
  for (const other of walls) {
    if (other.id === wall.id) continue;
    const half = other.thickness / 2;
    const hits: number[] = [];
    for (const p of [other.a, other.b]) {
      if (distToSegment(p, wall.a, wall.b) <= NODE_TOL) hits.push(projectParam(p, wall.a, wall.b));
    }
    if (distToSegment(wall.a, other.a, other.b) <= NODE_TOL) hits.push(0);
    if (distToSegment(wall.b, other.a, other.b) <= NODE_TOL) hits.push(1);
    const x = lineIntersectionParams(wall.a, wall.b, other.a, other.b);
    if (x && x.t > 0 && x.t < 1 && x.u > 0 && x.u < 1) hits.push(x.t);
    for (const t of hits) blocked.push([t * length - half, t * length + half]);
  }
  for (const o of openings) {
    if (o.wallId !== wall.id || o.id === ignoreOpeningId) continue;
    blocked.push([o.offset - o.width / 2, o.offset + o.width / 2]);
  }
  blocked.sort((p, q) => p[0] - q[0]);
  const free: [number, number][] = [];
  let from = 0;
  for (const [start, end] of blocked) {
    if (start > from + EPS) free.push([from, Math.min(start, length)]);
    from = Math.max(from, end);
    if (from >= length) break;
  }
  if (from < length - EPS) free.push([from, length]);
  return free;
}

function fit(
  walls: Wall[],
  openings: Opening[],
  wallId: string,
  offset: number,
  width: number,
  ignoreOpeningId?: string,
  columns?: readonly Column[],
): number | null {
  const wall = walls.find((w) => w.id === wallId);
  if (!wall || !(width > 0) || !Number.isFinite(offset)) return null;
  let best: number | null = null;
  for (const [start, end] of freeSpans(walls, openings, wall, ignoreOpeningId, columns)) {
    if (end - start < width - 1e-6) continue;
    const lo = start + width / 2;
    const hi = Math.max(lo, end - width / 2);
    const candidate = Math.max(lo, Math.min(hi, offset));
    if (best === null || Math.abs(candidate - offset) < Math.abs(best - offset)) best = candidate;
  }
  return best === null ? null : round(best);
}

/**
 * The offset closest to `offset` at which an opening of this width fits on the
 * wall, or null when no free stretch of the wall is wide enough.
 */
export function fitOffset(
  storey: Storey,
  wallId: string,
  offset: number,
  width: number,
  ignoreOpeningId?: string,
): number | null {
  return fit(storey.walls, storey.openings, wallId, offset, width, ignoreOpeningId, storey.columns);
}

/** Adds a door or window as near to `offset` as it fits; unchanged if it cannot fit. */
export function addOpening(
  storey: Storey,
  wallId: string,
  kind: OpeningKind,
  offset: number,
  size: OpeningSize,
  makeId: (prefix: string) => string = newId,
): Storey {
  if (!(size.height > 0) || !(size.sill >= 0)) return storey;
  const at = fitOffset(storey, wallId, offset, size.width);
  if (at === null) return storey;
  const opening: Opening = {
    id: makeId("opening"),
    wallId,
    kind,
    offset: at,
    width: size.width,
    height: size.height,
    sill: kind === "door" ? 0 : size.sill,
  };
  return { ...storey, openings: [...storey.openings, opening] };
}

/** Slides an opening along its wall, stopping at whatever is in the way. */
export function moveOpening(storey: Storey, id: string, offset: number): Storey {
  const opening = storey.openings.find((o) => o.id === id);
  if (!opening) return storey;
  const at = fitOffset(storey, opening.wallId, offset, opening.width, id);
  if (at === null || at === opening.offset) return storey;
  return {
    ...storey,
    openings: storey.openings.map((o) => (o.id === id ? { ...o, offset: at } : o)),
  };
}

/**
 * Changes an opening's kind or size. A wider opening may shift along the wall
 * to stay clear of its neighbours; if it fits nowhere the storey is unchanged.
 */
export function updateOpening(
  storey: Storey,
  id: string,
  patch: Partial<Pick<Opening, "kind" | "width" | "height" | "sill">>,
): Storey {
  const opening = storey.openings.find((o) => o.id === id);
  if (!opening) return storey;
  const next = { ...opening, ...patch };
  if (!(next.width > 0) || !(next.height > 0) || !(next.sill >= 0)) return storey;
  if (next.kind === "door") next.sill = 0;
  const at = fitOffset(storey, next.wallId, next.offset, next.width, id);
  if (at === null) return storey;
  next.offset = at;
  return { ...storey, openings: storey.openings.map((o) => (o.id === id ? next : o)) };
}

export function deleteOpening(storey: Storey, id: string): Storey {
  return { ...storey, openings: storey.openings.filter((o) => o.id !== id) };
}

/**
 * After the walls (or the columns) have changed: keeps every opening where it stood in the plan
 * (not at the same distance from the wall end), moves it aside if a wall now
 * joins there, and drops it when its wall is gone or has no room left for it.
 */
export function reconcileOpenings(before: Storey, after: Storey): Storey {
  const oldWalls = new Map(before.walls.map((w) => [w.id, w]));
  const newWalls = new Map(after.walls.map((w) => [w.id, w]));
  const placed: Opening[] = [];
  let changed = after.openings.length !== before.openings.length;
  for (const o of after.openings) {
    const wall = newWalls.get(o.wallId);
    if (!wall) {
      changed = true;
      continue;
    }
    let wanted = o.offset;
    const old = oldWalls.get(o.wallId);
    if (old) {
      const oldLength = dist(old.a, old.b);
      if (oldLength > NODE_TOL) {
        const world = lerp(old.a, old.b, o.offset / oldLength);
        wanted = projectParam(world, wall.a, wall.b) * dist(wall.a, wall.b);
      }
    }
    const at = fit(after.walls, placed, o.wallId, wanted, o.width, undefined, after.columns);
    if (at === null) {
      changed = true;
      continue;
    }
    if (at !== o.offset) changed = true;
    placed.push(at === o.offset ? o : { ...o, offset: at });
  }
  return changed ? { ...after, openings: placed } : after;
}

/** Where an opening is in the plan. */
export interface OpeningGeometry {
  /** Middle of the opening, on the wall centreline. */
  centre: Pt;
  /** The jamb nearer the wall's `a` end, on the centreline. */
  start: Pt;
  /** Unit vector along the wall, from `a` to `b`. */
  dir: Pt;
  /** Unit vector across the wall, to the left of `dir`. */
  normal: Pt;
  thickness: number;
}

export function openingGeometry(wall: Wall, opening: Opening): OpeningGeometry {
  const length = dist(wall.a, wall.b) || 1;
  const dir = { x: (wall.b.x - wall.a.x) / length, y: (wall.b.y - wall.a.y) / length };
  const along = (d: number): Pt => ({ x: wall.a.x + dir.x * d, y: wall.a.y + dir.y * d });
  return {
    centre: along(opening.offset),
    start: along(opening.offset - opening.width / 2),
    dir,
    normal: { x: -dir.y, y: dir.x },
    thickness: wall.thickness,
  };
}

/** The wall nearest to a point, and how far along it the point is. */
export function locateOnWall(
  storey: Storey,
  p: Pt,
  maxDistance: number,
): { wallId: string; offset: number } | null {
  let best: { wallId: string; offset: number } | null = null;
  let bestD = maxDistance;
  for (const w of storey.walls) {
    const d = distToSegment(p, w.a, w.b);
    if (d <= bestD) {
      bestD = d;
      const t = Math.max(0, Math.min(1, projectParam(p, w.a, w.b)));
      best = { wallId: w.id, offset: t * dist(w.a, w.b) };
    }
  }
  return best;
}

/** How far off the wall centreline the two sides of an opening are probed. */
const SIDE_PROBE = 0.01;

/**
 * The rooms on the two sides of an opening: first the side the wall's normal
 * points to, then the other. Null where that side is not a room (outdoors).
 */
export function openingSides(
  storey: Storey,
  opening: Opening,
  linked: LinkedSpaces = linkSpaces(storey),
): [string | null, string | null] {
  const wall = storey.walls.find((w) => w.id === opening.wallId);
  if (!wall) return [null, null];
  const g = openingGeometry(wall, opening);
  const roomAt = (sign: number): string | null => {
    const p = {
      x: g.centre.x + g.normal.x * SIDE_PROBE * sign,
      y: g.centre.y + g.normal.y * SIDE_PROBE * sign,
    };
    for (const space of storey.spaces) {
      const face = linked.faceBySpaceId.get(space.id);
      if (face && pointInPolygon(p, face.outer, face.holes)) return space.id;
    }
    return null;
  };
  return [roomAt(1), roomAt(-1)];
}
