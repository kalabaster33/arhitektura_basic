/**
 * A column grid for a building, proposed from the plan of one storey.
 *
 * Columns stand on a regular grid of axes: lines along y (the x axes) and
 * lines along x (the y axes), with a column at every crossing that lies in the
 * building. So from every column there is another one along x and along y,
 * one span away, and no span is longer than the largest span.
 *
 * Where the axes go is read from the walls that carry the building: the
 * outline of the ground floor first (the outer axes, with the columns flush
 * with the outside face), then the walls of the hall, stairs and elevator,
 * then the walls between two apartments or between an apartment and the hall
 * or corridor, the longest first. Walls inside one apartment are left out;
 * they can move from floor to floor. An axis closer to one already taken than
 * the shortest span is dropped, and a span longer than the largest span is
 * divided evenly by axes in between.
 *
 * Crossings inside the stairs or the elevator get no column; every other
 * crossing inside the ground floor outline does, so every column stands on
 * the ground. Sizes and spans come from src/config/columns.json.
 * Pure functions, no UI imports.
 */
import {
  type Pt,
  NODE_TOL,
  dist,
  distToSegment,
  lerp,
  lineIntersectionParams,
  pointInPolygon,
  pointInRing,
  projectParam,
} from "./geometry.ts";
import type { Building, ColumnGrid, Storey, Wall } from "./model.ts";
import { linkSpaces } from "./spaces.ts";
import { coreRect } from "./structure.ts";

export interface ColumnConfig {
  width: number;
  depth: number;
  /** Largest distance between two neighbouring axes. */
  maxSpan: number;
  /** Smallest distance between two neighbouring axes. */
  minSpan: number;
}

export function parseColumnConfig(raw: unknown): ColumnConfig {
  const c = raw as Partial<ColumnConfig> | null;
  const out = {} as ColumnConfig;
  for (const key of ["width", "depth", "maxSpan", "minSpan"] as const) {
    const v = c?.[key];
    if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0)) throw new Error(`Columns: invalid or missing "${key}".`);
    out[key] = v;
  }
  if (out.minSpan > out.maxSpan) throw new Error('Columns: "minSpan" is larger than "maxSpan".');
  return out;
}

/** Name of an axis along x: "A".."Z", then "AA", "AB".. Axes along y are numbered 1, 2, 3.. */
export function axisLetter(i: number): string {
  let out = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** A proposed column: where its centre is and how big it is. */
export interface ProposedColumn {
  at: Pt;
  w: number;
  d: number;
}

export interface ColumnProposal {
  grid: ColumnGrid;
  columns: ProposedColumn[];
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
/** How far off a wall centreline its two sides are probed. */
const SIDE_PROBE = 0.01;
/** A wall at most this far off square counts as running along x or along y. */
const SQUARE = 1e-6;

/** Every distance along a wall (0 to 1) where another wall ends on it or crosses it. */
function cutParams(wall: Wall, walls: Wall[]): number[] {
  const len = dist(wall.a, wall.b);
  const cuts = [0, 1];
  for (const other of walls) {
    if (other === wall) continue;
    for (const p of [other.a, other.b]) {
      if (distToSegment(p, wall.a, wall.b) <= NODE_TOL) cuts.push(projectParam(p, wall.a, wall.b));
    }
    const x = lineIntersectionParams(wall.a, wall.b, other.a, other.b);
    const eo = NODE_TOL / Math.max(dist(other.a, other.b), NODE_TOL);
    if (x && x.t > 0 && x.t < 1 && x.u >= -eo && x.u <= 1 + eo) cuts.push(x.t);
  }
  const sorted = cuts.map((t) => Math.max(0, Math.min(1, t))).sort((p, q) => p - q);
  return sorted.filter((t, i) => i === 0 || (t - sorted[i - 1]) * len > NODE_TOL);
}

/** Where an axis might go: its coordinate, how strongly it is wanted, and how long a wall asks for it. */
interface Candidate {
  at: number;
  /** 3 the outline, 2 the core, 1 a wall between apartments. */
  rank: number;
  length: number;
}

/**
 * The axes along one direction: the outline axes always, then the others
 * strongest first where they keep the shortest span, then axes in between
 * where a span is longer than the largest.
 */
function chooseAxes(candidates: Candidate[], config: ColumnConfig): number[] {
  // Walls on one line add up: the line is wanted as strongly as its strongest wall, as long as all of them.
  const lines = new Map<number, Candidate>();
  for (const c of candidates) {
    const key = Math.round(c.at / 1e-3);
    const seen = lines.get(key);
    lines.set(key, seen ? { at: seen.at, rank: Math.max(seen.rank, c.rank), length: seen.length + c.length } : { ...c });
  }
  const sorted = [...lines.values()].sort((p, q) => q.rank - p.rank || q.length - p.length);
  const taken: number[] = [];
  for (const c of sorted) {
    const near = taken.some((t) => Math.abs(t - c.at) < (c.rank === 3 ? 1e-6 : config.minSpan - 1e-6));
    if (!near) taken.push(round(c.at));
  }
  taken.sort((p, q) => p - q);
  const axes: number[] = [];
  taken.forEach((t, i) => {
    if (i > 0) {
      const gap = t - taken[i - 1];
      const parts = Math.ceil(gap / config.maxSpan - 1e-9);
      for (let k = 1; k < parts; k++) axes.push(round(taken[i - 1] + (gap * k) / parts));
    }
    axes.push(t);
  });
  return axes;
}

/**
 * Proposes the column grid for the building from the walls of one storey.
 * Empty when the building has no outline.
 */
export function proposeColumns(building: Building, storey: Storey, config: ColumnConfig): ColumnProposal {
  const { structure } = building;
  const footprint = structure.footprint;
  if (footprint.length < 3) return { grid: { xs: [], ys: [] }, columns: [] };

  const xs: Candidate[] = [];
  const ys: Candidate[] = [];

  // The outline: an axis half a column in from every side running along x or
  // y, so the columns there are flush with the outside face.
  footprint.forEach((a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    const len = dist(a, b);
    if (len < NODE_TOL) return;
    // The footprint has its interior on the left.
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    if (Math.abs(b.x - a.x) <= SQUARE * len) xs.push({ at: a.x + n.x * (config.width / 2), rank: 3, length: len });
    else if (Math.abs(b.y - a.y) <= SQUARE * len) ys.push({ at: a.y + n.y * (config.depth / 2), rank: 3, length: len });
  });

  // Who is on each side of a wall: an apartment, a shared room, or outdoors.
  const linked = linkSpaces(storey);
  const apartmentOf = new Map<string, string>();
  for (const a of storey.apartments) for (const id of a.spaceIds) apartmentOf.set(id, a.id);
  const rooms = storey.spaces
    .map((s) => ({ face: linked.faceBySpaceId.get(s.id), owner: apartmentOf.get(s.id) ?? `room:${s.id}` }))
    .filter((r) => r.face !== undefined);
  const ownerAt = (p: Pt): string => {
    for (const r of rooms) if (pointInPolygon(p, r.face!.outer, r.face!.holes)) return r.owner;
    return "outdoors";
  };

  // The core and the walls between apartments. Railings carry nothing, and the
  // outside walls of the storey are stood in for by the ground floor outline.
  const walls = storey.walls.filter((w) => w.part !== "balcony" && dist(w.a, w.b) > NODE_TOL);
  for (const wall of walls) {
    if (wall.part === "shell") continue;
    const len = dist(wall.a, wall.b);
    const alongY = Math.abs(wall.b.x - wall.a.x) <= SQUARE * len;
    const alongX = Math.abs(wall.b.y - wall.a.y) <= SQUARE * len;
    if (!alongX && !alongY) continue;
    let carried = 0;
    if (wall.part === "core") carried = len;
    else {
      const ts = cutParams(wall, walls);
      const n = { x: -(wall.b.y - wall.a.y) / len, y: (wall.b.x - wall.a.x) / len };
      for (let i = 0; i + 1 < ts.length; i++) {
        const m = lerp(wall.a, wall.b, (ts[i] + ts[i + 1]) / 2);
        const left = ownerAt({ x: m.x + n.x * SIDE_PROBE, y: m.y + n.y * SIDE_PROBE });
        const right = ownerAt({ x: m.x - n.x * SIDE_PROBE, y: m.y - n.y * SIDE_PROBE });
        if (left !== right) carried += (ts[i + 1] - ts[i]) * len;
      }
    }
    if (carried <= NODE_TOL) continue;
    const c = { rank: wall.part === "core" ? 2 : 1, length: carried };
    if (alongY) xs.push({ ...c, at: wall.a.x });
    else ys.push({ ...c, at: wall.a.y });
  }

  const grid = { xs: chooseAxes(xs, config), ys: chooseAxes(ys, config) };

  // A column at every crossing in the building, except in the stairs and the elevator.
  const shafts = structure.core
    .filter((c) => c.kind !== "hall")
    .map((c) => {
      const { min, max } = coreRect(c);
      const inset = structure.coreWallThickness / 2 + 1e-6;
      return { min: { x: min.x + inset, y: min.y + inset }, max: { x: max.x - inset, y: max.y - inset } };
    });
  const columns: ProposedColumn[] = [];
  for (const x of grid.xs) {
    for (const y of grid.ys) {
      const at = { x, y };
      if (!fitsInside(at, config, footprint)) continue;
      if (shafts.some((s) => x > s.min.x && x < s.max.x && y > s.min.y && y < s.max.y)) continue;
      columns.push({ at, w: config.width, d: config.depth });
    }
  }
  return { grid, columns };
}

/** True when the whole column lies inside the outline (flush with its face counts). */
function fitsInside(at: Pt, config: ColumnConfig, outline: Pt[]): boolean {
  const hw = config.width / 2 - 1e-4;
  const hd = config.depth / 2 - 1e-4;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) =>
    pointInRing({ x: at.x + sx * hw, y: at.y + sy * hd }, outline),
  );
}
