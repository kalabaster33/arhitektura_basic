/**
 * A first column grid for a building, proposed from the plan of one storey.
 *
 * The walls that carry the building are taken to be the ones that separate
 * things: the outside walls, the walls of the hall, stairs and elevator, and
 * every wall between two apartments or between an apartment and the hall or
 * corridor. Walls inside one apartment are left out; they can move from floor
 * to floor. A column goes where these walls meet (a corner, a T or a cross)
 * and, along a long straight wall, in between, so that no two neighbours on
 * one line are further apart than the largest span. Columns put in between
 * are shifted along their wall to stay clear of doors and windows.
 *
 * Only places inside the ground floor outline are kept, so every column
 * stands on the ground. The sizes and spans come from src/config/columns.json.
 * Pure functions, no UI imports.
 */
import {
  type Pt,
  NODE_TOL,
  dist,
  distToSegment,
  lerp,
  lineIntersectionParams,
  offsetRingLeft,
  pointInPolygon,
  pointInRing,
  projectParam,
} from "./geometry.ts";
import type { Building, Storey, Wall } from "./model.ts";
import { columnSpansOnWall } from "./openings.ts";
import { linkSpaces } from "./spaces.ts";

export interface ColumnConfig {
  width: number;
  depth: number;
  maxSpan: number;
  mergeDistance: number;
  doorClearance: number;
}

export function parseColumnConfig(raw: unknown): ColumnConfig {
  const c = raw as Partial<ColumnConfig> | null;
  const out = {} as ColumnConfig;
  for (const key of ["width", "depth", "maxSpan", "mergeDistance", "doorClearance"] as const) {
    const v = c?.[key];
    const ok = typeof v === "number" && Number.isFinite(v) && (key === "doorClearance" ? v >= 0 : v > 0);
    if (!ok) throw new Error(`Columns: invalid or missing "${key}".`);
    out[key] = v;
  }
  return out;
}

/** A proposed column: where its centre is and how big it is. */
export interface ProposedColumn {
  at: Pt;
  w: number;
  d: number;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
/** How far off a wall centreline its two sides are probed. */
const SIDE_PROBE = 0.01;

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

/** One stretch of a wall line that carries the building. */
interface Run {
  a: Pt;
  b: Pt;
  /** The real wall it lies on; null for the ground floor outline drawn on an upper storey. */
  wall: Wall | null;
}

/**
 * Proposes columns for the building from the walls of one storey. The result
 * is ordered: outline corners first, then wall junctions, then the columns in
 * between. Empty when the building has no outline.
 */
export function proposeColumns(building: Building, storey: Storey, config: ColumnConfig): ProposedColumn[] {
  const { structure } = building;
  const footprint = structure.footprint;
  if (footprint.length < 3) return [];
  const half = structure.wallThickness / 2;
  const groundCentre = offsetRingLeft(footprint, footprint.map(() => half));

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

  // The ground floor outline counts as a carrying line on every storey, so an
  // upper storey with an erker still gets the columns that stand below it.
  const pseudo: Wall[] = groundCentre.map((a, i) => ({
    id: `ground:${i}`,
    a,
    b: groundCentre[(i + 1) % groundCentre.length],
    thickness: structure.wallThickness,
    kind: "exterior",
    part: "shell",
  }));
  const lines = [...storey.walls, ...pseudo].filter((w) => dist(w.a, w.b) > NODE_TOL);
  const real = new Set(storey.walls.map((w) => w.id));

  const runs: Run[] = [];
  for (const wall of lines) {
    const ts = cutParams(wall, lines);
    const len = dist(wall.a, wall.b);
    const n = { x: -(wall.b.y - wall.a.y) / len, y: (wall.b.x - wall.a.x) / len };
    let open: { from: number; to: number } | null = null;
    const close = () => {
      if (open) runs.push({ a: lerp(wall.a, wall.b, open.from), b: lerp(wall.a, wall.b, open.to), wall: real.has(wall.id) ? wall : null });
      open = null;
    };
    for (let i = 0; i + 1 < ts.length; i++) {
      const m = lerp(wall.a, wall.b, (ts[i] + ts[i + 1]) / 2);
      const left = ownerAt({ x: m.x + n.x * SIDE_PROBE, y: m.y + n.y * SIDE_PROBE });
      const right = ownerAt({ x: m.x - n.x * SIDE_PROBE, y: m.y - n.y * SIDE_PROBE });
      const carries = wall.part !== undefined || left !== right;
      if (!carries) close();
      else if (open) open.to = ts[i + 1];
      else open = { from: ts[i], to: ts[i + 1] };
    }
    close();
  }

  // Junctions: where carrying lines meet other than straight on.
  const nodes = new Map<string, { p: Pt; dirs: Set<string> }>();
  const key = (p: Pt) => `${Math.round(p.x / 0.01)},${Math.round(p.y / 0.01)}`;
  const touch = (p: Pt, toward: Pt) => {
    const k = key(p);
    const node = nodes.get(k) ?? { p, dirs: new Set<string>() };
    const angle = Math.round((Math.atan2(toward.y - p.y, toward.x - p.x) * 180) / Math.PI) % 360;
    node.dirs.add(String((angle + 360) % 360));
    nodes.set(k, node);
  };
  for (const r of runs) {
    // Both ends of every run; a run that ends partway along another one makes a T there.
    touch(r.a, r.b);
    touch(r.b, r.a);
  }
  for (const r of runs) {
    for (const node of nodes.values()) {
      if (dist(node.p, r.a) <= NODE_TOL || dist(node.p, r.b) <= NODE_TOL) continue;
      if (distToSegment(node.p, r.a, r.b) <= NODE_TOL) {
        touch(node.p, r.a);
        touch(node.p, r.b);
      }
    }
  }
  const junctions: Pt[] = [];
  for (const { p, dirs } of nodes.values()) {
    const angles = [...dirs].map(Number);
    const straight = angles.length === 2 && Math.abs(Math.abs(angles[0] - angles[1]) - 180) <= 1;
    if (!straight) junctions.push(p);
  }

  const inside = (p: Pt) => pointInRing(p, footprint);
  const kept: Pt[] = [];
  const keep = (p: Pt) => {
    if (!inside(p) || kept.some((q) => dist(p, q) < config.mergeDistance)) return;
    kept.push({ x: round(p.x), y: round(p.y) });
  };
  groundCentre.forEach(keep);
  junctions.forEach(keep);

  // In between: no two neighbours on one carrying line further apart than the span.
  const extra: Pt[] = [];
  for (const r of runs) {
    const len = dist(r.a, r.b);
    if (len <= config.maxSpan) continue;
    const on = [...kept, ...extra]
      .filter((p) => distToSegment(p, r.a, r.b) <= Math.max(config.width, config.depth) / 2)
      .map((p) => projectParam(p, r.a, r.b) * len)
      .filter((s) => s >= -1e-6 && s <= len + 1e-6)
      .sort((p, q) => p - q);
    for (let i = 0; i + 1 < on.length; i++) {
      const gap = on[i + 1] - on[i];
      const parts = Math.ceil(gap / config.maxSpan - 1e-9);
      for (let k = 1; k < parts; k++) {
        const s = clearOfOpenings(storey, r, on[i] + (gap * k) / parts, on[i], on[i + 1], config);
        extra.push(lerp(r.a, r.b, s / len));
      }
    }
  }
  extra.forEach(keep);

  return kept.map((at) => ({ at: settleInside(at, config, footprint), w: config.width, d: config.depth }));
}

/**
 * A place near `s` (a distance along the run) where a column does not stand in
 * a door or window of the run's wall, staying between its two neighbours.
 */
function clearOfOpenings(storey: Storey, run: Run, s: number, lo: number, hi: number, config: ColumnConfig): number {
  const wall = run.wall;
  if (!wall) return s;
  const openings = storey.openings.filter((o) => o.wallId === wall.id);
  if (openings.length === 0) return s;
  const len = dist(run.a, run.b);
  const free = (t: number): boolean => {
    const at = lerp(run.a, run.b, t / len);
    const spans = columnSpansOnWall(wall, [{ id: "probe", at, w: config.width, d: config.depth }]);
    return !spans.some(([a, b]) => openings.some((o) => a < o.offset + o.width / 2 && b > o.offset - o.width / 2));
  };
  const margin = Math.min(config.mergeDistance, (hi - lo) / 4);
  for (let shift = 0; shift <= config.doorClearance + 1e-9; shift += 0.05) {
    for (const t of shift === 0 ? [s] : [s + shift, s - shift]) {
      if (t > lo + margin && t < hi - margin && free(t)) return t;
    }
  }
  return s;
}

/** Moves a column inward until it no longer sticks out of the outline. */
function settleInside(at: Pt, config: ColumnConfig, outline: Pt[]): Pt {
  let p = { ...at };
  // Corners probed a hair inside, so a column flush with the outside face counts as inside.
  const hw = config.width / 2 - 1e-4;
  const hd = config.depth / 2 - 1e-4;
  const step = 0.005;
  for (let i = 0; i < 200; i++) {
    let dx = 0;
    let dy = 0;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      if (!pointInRing({ x: p.x + sx * hw, y: p.y + sy * hd }, outline)) {
        dx -= sx;
        dy -= sy;
      }
    }
    if (dx === 0 && dy === 0) break;
    p = { x: p.x + Math.sign(dx) * step, y: p.y + Math.sign(dy) * step };
  }
  return { x: round(p.x), y: round(p.y) };
}
