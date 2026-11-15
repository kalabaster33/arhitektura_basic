/**
 * Storey generator: divides the floor that is left around the hall, stairs and
 * elevator into apartments of wanted sizes, with an entrance door from the
 * hall (or from a common corridor run out from it) into every apartment.
 *
 * Method: an anchored area partition (Hert & Lumelsky, "Polygon area
 * decomposition for multiple-robot workspace division", 1998): the floor is
 * cut recursively, each cut placed by a sweep so the pieces on either side
 * get exactly their share of the area, and every piece must keep its own
 * "anchor" — here a stretch of hall or corridor wall for its entrance door and
 * a stretch of facade for daylight. Cuts are kept parallel to the axes, so the
 * result is a slicing floor plan (a guillotine tree) with square walls. Which
 * apartments go to which side of each cut, and in which direction it runs, is
 * found by a pruned best-first search over the slicing trees; candidates are
 * ranked by a cost (area error, how rectangular and how deep each apartment
 * is, facade length) and checked strictly (one piece, wide enough everywhere,
 * a straight wall for the door) before they are drawn.
 *
 * When the hall alone cannot reach every apartment, a corridor is run from it
 * along the long axis of the building to the outside walls, as in a
 * double-loaded corridor block.
 *
 * Works on a grid aligned with the plan axes (the core is drawn square to
 * them). Areas are measured to wall centrelines. No UI imports.
 */
import { applyWalls, updateSpace } from "./edit.ts";
import { type Pt, dist, distToSegment, lineIntersectionParams, offsetRingLeft, pointInPolygon, pointInRing } from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Apartment, ApartmentProgram, Building, Storey, Wall } from "./model.ts";
import { type OpeningSize, addOpening, locateOnWall, openingSides } from "./openings.ts";
import { linkSpaces } from "./spaces.ts";
import { coreRect, storeyOutline } from "./structure.ts";

// ------------------------------------------------------------------ inputs

/** One kind of apartment in the wanted mix. */
export interface UnitType {
  name: string;
  /** Wanted area to wall centrelines. */
  area: number;
  count: number;
  program: ApartmentProgram;
  /** Put these at the corners of the plan, where two facades meet. */
  corner?: boolean;
}

/** Extra settings for one run of the storey generator. */
export interface SplitOptions {
  /**
   * Stretches of the outside wall that are not facade: a party wall against
   * a neighbouring building or lamella. Apartments get no daylight there and
   * a corner on them is no corner. Each is a segment along the wall.
   */
  blind?: [Pt, Pt][];
  /** Only these corridor layouts are tried (corridor access); all of them when left out. */
  corridorLayouts?: CorridorLayout[];
}

export interface SplitRules {
  cellSize: number;
  corridorWidth: number;
  partyWallThickness: number;
  minApartmentWidth: number;
  minApartmentFacade: number;
  entranceRun: number;
  entranceDoor: Pick<OpeningSize, "width" | "height">;
  unitTypes: UnitType[];
}

/** How the apartments are reached: from the hall alone, or along a corridor run out from it. */
export type Access = "hall" | "corridor";

function normalizeProgramLoose(raw: unknown): ApartmentProgram {
  const p = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
  return {
    bedrooms: n(p.bedrooms, 0, 5, 1),
    bathrooms: n(p.bathrooms, 1, 3, 1),
    wc: n(p.wc, 0, 2, 0),
    storage: n(p.storage, 0, 2, 0),
    kitchen: p.kitchen === "separate" || p.kitchen === "none" ? p.kitchen : "open",
  };
}

/** Checks rules loaded from JSON; throws with the offending key. */
export function parseSplitRules(raw: unknown): SplitRules {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== "object") throw new Error("Storey rules: not an object.");
  const num = (key: string): number => {
    const v = c[key];
    if (typeof v !== "number" || !(v > 0)) throw new Error(`Storey rules: invalid or missing "${key}".`);
    return v;
  };
  const door = c.entranceDoor as Record<string, unknown> | undefined;
  if (!door || !(typeof door.width === "number" && door.width > 0) || !(typeof door.height === "number" && door.height > 0)) {
    throw new Error('Storey rules: invalid or missing "entranceDoor".');
  }
  if (!Array.isArray(c.unitTypes)) throw new Error('Storey rules: invalid or missing "unitTypes".');
  const unitTypes = c.unitTypes.map((u: Record<string, unknown>) => {
    if (typeof u?.name !== "string" || typeof u.area !== "number" || !(u.area > 0)) {
      throw new Error('Storey rules: invalid entry in "unitTypes".');
    }
    return {
      name: u.name,
      area: u.area,
      count: typeof u.count === "number" && u.count >= 0 ? Math.round(u.count) : 0,
      program: normalizeProgramLoose(u.program),
      ...(u.corner === true ? { corner: true } : {}),
    };
  });
  return {
    cellSize: num("cellSize"),
    corridorWidth: num("corridorWidth"),
    partyWallThickness: num("partyWallThickness"),
    minApartmentWidth: num("minApartmentWidth"),
    minApartmentFacade: num("minApartmentFacade"),
    entranceRun: num("entranceRun"),
    entranceDoor: { width: door.width as number, height: door.height as number },
    unitTypes,
  };
}

// -------------------------------------------------------------------- plate

const OUTSIDE = 0;
const FREE = 1;
const HALL = 2;
const CORE = 3;
const CORR = 4;

/** The floor of the storey on a grid: what each cell is, with running sums for fast counting. */
interface Plate {
  nx: number;
  ny: number;
  cell: number;
  ox: number;
  oy: number;
  kind: Uint8Array;
  /** Per free cell: sides touching the hall or corridor / touching the outside. */
  acc: Uint8Array;
  fac: Uint8Array;
  satFree: Int32Array;
  satAcc: Int32Array;
  satFac: Int32Array;
  /** Facade sides facing along x (east / west) and along y (north / south). */
  satFacX: Int32Array;
  satFacY: Int32Array;
  /** Cells at an outside corner: facade on a side facing x and on one facing y. */
  satCorner: Int32Array;
  freeCells: number;
}

function buildSat(nx: number, ny: number, v: ArrayLike<number>): Int32Array {
  const W = nx + 1;
  const s = new Int32Array(W * (ny + 1));
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      s[(y + 1) * W + x + 1] = v[y * nx + x] + s[y * W + x + 1] + s[(y + 1) * W + x] - s[y * W + x];
    }
  }
  return s;
}

function rectSum(s: Int32Array, W: number, x0: number, y0: number, x1: number, y1: number): number {
  return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
}

/** 4-connected components of the cells where `inside(i)` holds. */
function components(nx: number, ny: number, inside: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(nx * ny);
  const out: number[][] = [];
  for (let s = 0; s < nx * ny; s++) {
    if (seen[s] || !inside(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % nx;
      for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, i - nx, i + nx]) {
        if (j < 0 || j >= nx * ny || seen[j] || !inside(j)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    out.push(comp);
  }
  return out;
}

/** Morphological opening by a k x k square of a mask on an nx x ny grid. */
function opening(nx: number, ny: number, mask: Uint8Array, k: number): Uint8Array {
  const W = nx + 1;
  const s = buildSat(nx, ny, mask);
  const d = new Int32Array(W * (ny + 1));
  for (let y = 0; y + k <= ny; y++) {
    for (let x = 0; x + k <= nx; x++) {
      if (rectSum(s, W, x, y, x + k, y + k) === k * k) {
        d[y * W + x]++;
        d[y * W + x + k]--;
        d[(y + k) * W + x]--;
        d[(y + k) * W + x + k]++;
      }
    }
  }
  const out = new Uint8Array(nx * ny);
  const col = new Int32Array(W);
  for (let y = 0; y < ny; y++) {
    let acc = 0;
    for (let x = 0; x < nx; x++) {
      col[x] += d[y * W + x];
      acc += col[x];
      if (acc > 0) out[y * nx + x] = 1;
    }
  }
  return out;
}

/** The storey's outside walls on their centrelines. */
function shellRing(building: Building, storeyId: string): Pt[] {
  const outline = storeyOutline(building, storeyId);
  if (outline.length < 3) return [];
  const t = building.structure.wallThickness;
  return offsetRingLeft(outline, outline.map(() => t / 2)).map((p) => ({
    x: Math.round(p.x * 1e6) / 1e6,
    y: Math.round(p.y * 1e6) / 1e6,
  }));
}

type PlateResult = { ok: true; plate: Plate } | { ok: false; reason: string };

/** Where a corridor runs: along which axes, and where across the hall it sits. */
export interface CorridorLayout {
  axes: ("long" | "short")[];
  /** Through the middle of the hall, flush with one of its sides inside it, or just outside it. */
  anchor: "centre" | "low" | "high" | "before" | "after";
}

const CORRIDOR_LAYOUTS: CorridorLayout[] = (["centre", "low", "high", "before", "after"] as const).flatMap((anchor) =>
  ([["long"], ["short"], ["long", "short"]] as ("long" | "short")[][]).map((axes) => ({ axes, anchor })),
);

function buildPlate(
  building: Building,
  storeyId: string,
  rules: SplitRules,
  access: Access,
  layout: CorridorLayout = { axes: ["long"], anchor: "centre" },
  blind: [Pt, Pt][] = [],
): PlateResult {
  const ring = shellRing(building, storeyId);
  if (ring.length < 3) return { ok: false, reason: "Draw the building outline first." };
  const { core } = building.structure;
  const halls = core.filter((c) => c.kind === "hall").map(coreRect);
  if (halls.length === 0) return { ok: false, reason: "Place the hall first: the apartments are entered from it." };
  const others = core.filter((c) => c.kind !== "hall").map(coreRect);

  const cell = rules.cellSize;
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const ox = Math.floor(Math.min(...xs) / cell) * cell - cell;
  const oy = Math.floor(Math.min(...ys) / cell) * cell - cell;
  const nx = Math.ceil((Math.max(...xs) - ox) / cell) + 1;
  const ny = Math.ceil((Math.max(...ys) - oy) / cell) + 1;
  const kind = new Uint8Array(nx * ny);
  const within = (p: Pt, r: { min: Pt; max: Pt }) => p.x > r.min.x && p.x < r.max.x && p.y > r.min.y && p.y < r.max.y;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = { x: ox + (x + 0.5) * cell, y: oy + (y + 0.5) * cell };
      if (!pointInRing(p, ring)) continue;
      kind[y * nx + x] = halls.some((r) => within(p, r)) ? HALL : others.some((r) => within(p, r)) ? CORE : FREE;
    }
  }

  const neighbours = (i: number) => {
    const x = i % nx;
    return [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, i - nx, i + nx].filter((j) => j >= 0 && j < nx * ny);
  };
  const touches = (comp: number[], k: number) => comp.some((i) => neighbours(i).some((j) => kind[j] === k));

  if (access === "corridor") {
    // Bands out from the hall to the outside walls: along the long axis of
    // the building, the short one, or both; through the middle of the hall
    // or flush with one of its sides.
    const longX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    const hall = halls.reduce((a, b) =>
      (a.max.x - a.min.x) * (a.max.y - a.min.y) >= (b.max.x - b.min.x) * (b.max.y - b.min.y) ? a : b,
    );
    const half = Math.max(1, Math.round((rules.corridorWidth + rules.partyWallThickness) / 2 / cell));
    for (const axis of layout.axes) {
      const alongX = axis === "long" ? longX : !longX;
      const lo = alongX ? hall.min.y : hall.min.x;
      const hi = alongX ? hall.max.y : hall.max.x;
      const width = 2 * half * cell;
      const centre =
        layout.anchor === "before"
          ? lo - width / 2
          : layout.anchor === "after"
            ? hi + width / 2
            : layout.anchor === "centre" || hi - lo <= width
              ? (lo + hi) / 2
              : layout.anchor === "low"
                ? lo + width / 2
                : hi - width / 2;
      const mid = Math.round((centre - (alongX ? oy : ox)) / cell);
      for (let i = 0; i < kind.length; i++) {
        if (kind[i] !== FREE) continue;
        const x = i % nx;
        const c = alongX ? (i - x) / nx : x;
        if (c >= mid - half && c < mid + half) kind[i] = CORR;
      }
    }
    // Only stretches of the band that reach the hall are corridor.
    let reaches = false;
    for (const comp of components(nx, ny, (i) => kind[i] === CORR)) {
      if (touches(comp, HALL)) reaches = true;
      else for (const i of comp) kind[i] = FREE;
    }
    if (!reaches) return { ok: false, reason: "A corridor along the building cannot reach the hall." };
  }

  // Leftovers too narrow to be part of an apartment go to the corridor or the
  // hall when they touch it; small islands nobody can reach are left out.
  const narrow = Math.max(2, Math.round(1.0 / cell));
  const freeMask = new Uint8Array(nx * ny);
  for (let i = 0; i < kind.length; i++) freeMask[i] = kind[i] === FREE ? 1 : 0;
  const wide = opening(nx, ny, freeMask, narrow);
  for (const comp of components(nx, ny, (i) => kind[i] === FREE && !wide[i])) {
    if (access === "corridor" && touches(comp, CORR)) for (const i of comp) kind[i] = CORR;
  }
  const minIsland = Math.ceil(3 / (cell * cell));
  for (const comp of components(nx, ny, (i) => kind[i] === FREE)) {
    if (comp.length < minIsland) for (const i of comp) kind[i] = CORE;
  }

  const acc = new Uint8Array(nx * ny);
  const fac = new Uint8Array(nx * ny);
  const facX = new Uint8Array(nx * ny);
  const facY = new Uint8Array(nx * ny);
  // A side on a party wall is no facade.
  const onBlind = (q: Pt) => blind.some(([a, b]) => distToSegment(q, a, b) <= 1.5 * cell);
  let freeCells = 0;
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] !== FREE) continue;
    freeCells++;
    const x = i % nx;
    const y = (i - x) / nx;
    const sides: [number, number, number][] = [
      [x > 0 ? i - 1 : -1, -0.5, 0],
      [x < nx - 1 ? i + 1 : -1, 0.5, 0],
      [i - nx, 0, -0.5],
      [i + nx, 0, 0.5],
    ];
    for (const [j, dx, dy] of sides) {
      const k = j < 0 || j >= kind.length ? OUTSIDE : kind[j];
      if (k === HALL || k === CORR) acc[i]++;
      if (k !== OUTSIDE) continue;
      if (blind.length > 0 && onBlind({ x: ox + (x + 0.5 + dx) * cell, y: oy + (y + 0.5 + dy) * cell })) continue;
      fac[i]++;
      if (dx !== 0) facX[i]++;
      else facY[i]++;
    }
  }
  const free = new Uint8Array(nx * ny);
  for (let i = 0; i < kind.length; i++) free[i] = kind[i] === FREE ? 1 : 0;
  return {
    ok: true,
    plate: {
      nx,
      ny,
      cell,
      ox,
      oy,
      kind,
      acc,
      fac,
      satFree: buildSat(nx, ny, free),
      satAcc: buildSat(nx, ny, acc),
      satFac: buildSat(nx, ny, fac),
      satFacX: buildSat(nx, ny, facX),
      satFacY: buildSat(nx, ny, facY),
      satCorner: buildSat(nx, ny, facX.map((v, i) => (v > 0 && facY[i] > 0 ? 1 : 0))),
      freeCells,
    },
  };
}

/** Floor area left for apartments around the hall, stairs and elevator, to wall centrelines. */
export function usableArea(building: Building, storeyId: string, rules: SplitRules): number | null {
  const built = buildPlate(building, storeyId, rules, "hall");
  return built.ok ? built.plate.freeCells * rules.cellSize ** 2 : null;
}

// ------------------------------------------------------------------- search

/** A node of the slicing tree: a box of grid lines [x0, x1) x [y0, y1). */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Leaf extends Box {
  /** Index into the unit types. */
  type: number;
}

interface Solution {
  cost: number;
  leaves: Leaf[];
}

interface SearchContext {
  plate: Plate;
  rules: SplitRules;
  /** Wanted cells per unit type, scaled so the whole floor is used. */
  target: number[];
  /** Per unit type: wants a corner. */
  corner: boolean[];
  memo: Map<string, Solution[]>;
  /** Strict checks of a box as one apartment, by box. */
  strict: Map<string, number>;
  budget: number;
}

const W_ = (p: Plate) => p.nx + 1;
const freeIn = (p: Plate, b: Box) => rectSum(p.satFree, W_(p), b.x0, b.y0, b.x1, b.y1);

/** The box shrunk to the free cells inside it. */
function tight(p: Plate, b: Box): Box | null {
  let { x0, y0, x1, y1 } = b;
  const W = W_(p);
  const f = (a: number, c: number, d: number, e: number) => rectSum(p.satFree, W, a, c, d, e);
  while (x0 < x1 && f(x0, y0, x0 + 1, y1) === 0) x0++;
  while (x0 < x1 && f(x1 - 1, y0, x1, y1) === 0) x1--;
  while (y0 < y1 && f(x0, y0, x1, y0 + 1) === 0) y0++;
  while (y0 < y1 && f(x0, y1 - 1, x1, y1) === 0) y1--;
  return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null;
}

/** Cost of a flat that wants a corner and does not get one. */
const CORNER_COST = 20;

/** Quick cost of one apartment in a box; Infinity when it plainly cannot work. */
function leafCost(ctx: SearchContext, b: Box, type: number): number {
  const { plate: p, rules } = ctx;
  const t = tight(p, b);
  if (!t) return Infinity;
  const W = W_(p);
  const cells = freeIn(p, t);
  const c = p.cell;
  const w = (t.x1 - t.x0) * c;
  const h = (t.y1 - t.y0) * c;
  const accLen = rectSum(p.satAcc, W, t.x0, t.y0, t.x1, t.y1) * c;
  const facLen = rectSum(p.satFac, W, t.x0, t.y0, t.x1, t.y1) * c;
  if (Math.min(w, h) < rules.minApartmentWidth - 1e-9) return Infinity;
  if (accLen < rules.entranceRun - 1e-9 || facLen < rules.minApartmentFacade - 1e-9) return Infinity;
  const area = cells * c * c;
  const target = ctx.target[type];
  const boxKey = `${b.x0},${b.y0},${b.x1},${b.y1}`;
  let strict = ctx.strict.get(boxKey);
  if (strict === undefined) {
    strict = strictLeaf(ctx, b);
    ctx.strict.set(boxKey, strict);
  }
  if (strict === Infinity) return Infinity;
  const fill = cells / ((t.x1 - t.x0) * (t.y1 - t.y0));
  const aspect = Math.max(w, h) / Math.min(w, h);
  // A corner: facade on a side facing x and on one facing y.
  const atCorner =
    rectSum(p.satFacX, W, t.x0, t.y0, t.x1, t.y1) * c >= 1 && rectSum(p.satFacY, W, t.x0, t.y0, t.x1, t.y1) * c >= 1;
  const cornerCost = ctx.corner[type] ? (atCorner ? 0 : CORNER_COST) : ctx.corner.some(Boolean) && atCorner ? 1.5 : 0;
  return (
    cornerCost +
    2.0 * (Math.abs(cells - target) / target) +
    3.0 * (1 - fill) + // close to a rectangle
    1.0 * Math.max(0, aspect - 2.2) + // not a deep, narrow tube
    1.0 * Math.max(0, 1 - facLen / Math.max(rules.minApartmentFacade * 1.5, 0.45 * Math.sqrt(area))) +
    strict
  );
}

/** Rough cost of a box that still holds several apartments; Infinity when it cannot hold them. */
function groupCost(ctx: SearchContext, b: Box, items: number[]): number {
  if (items.length === 1) return leafCost(ctx, b, items[0]);
  const { plate: p, rules } = ctx;
  const t = tight(p, b);
  if (!t) return Infinity;
  const W = W_(p);
  const c = p.cell;
  const k = items.length;
  const accLen = rectSum(p.satAcc, W, t.x0, t.y0, t.x1, t.y1) * c;
  const facLen = rectSum(p.satFac, W, t.x0, t.y0, t.x1, t.y1) * c;
  if (accLen < k * rules.entranceRun - 1e-9 || facLen < k * rules.minApartmentFacade - 1e-9) return Infinity;
  const cells = freeIn(p, t);
  const fill = cells / ((t.x1 - t.x0) * (t.y1 - t.y0));
  const want = items.reduce((s, i) => s + ctx.target[i], 0);
  // Flats that want a corner need as many corners in the box.
  const corners = items.filter((i) => ctx.corner[i]).length;
  const missing = corners > 0 ? Math.max(0, corners - rectSum(p.satCorner, W, t.x0, t.y0, t.x1, t.y1)) : 0;
  return 1.5 * (1 - fill) + 2.0 * (Math.abs(cells - want) / want) + CORNER_COST * missing;
}

/** Distinct sub-multisets of a sorted list, as sorted lists, without the empty and the full one. */
function subMultisets(items: number[]): number[][] {
  const counts = new Map<number, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  const keys = [...counts.keys()];
  const out: number[][] = [];
  const walk = (k: number, acc: number[]) => {
    if (k === keys.length) {
      if (acc.length > 0 && acc.length < items.length) out.push(acc.slice());
      return;
    }
    for (let n = 0; n <= counts.get(keys[k])!; n++) {
      walk(k + 1, [...acc, ...Array(n).fill(keys[k])]);
    }
  };
  walk(0, []);
  return out;
}

const KEEP = 4;

/** Best few ways to divide the box among the apartments, cheapest first. */
function solve(ctx: SearchContext, b: Box, items: number[], depth: number): Solution[] {
  const key = `${b.x0},${b.y0},${b.x1},${b.y1}|${items.join(",")}`;
  const known = ctx.memo.get(key);
  if (known) return known;
  let result: Solution[] = [];
  if (items.length === 1) {
    const cost = leafCost(ctx, b, items[0]);
    if (cost < Infinity) result = [{ cost, leaves: [{ ...b, type: items[0] }] }];
    ctx.memo.set(key, result);
    return result;
  }
  if (ctx.budget-- <= 0) {
    ctx.memo.set(key, result);
    return result;
  }

  const { plate: p } = ctx;
  const W = W_(p);
  const total = freeIn(p, b);
  const want = (list: number[]) => list.reduce((s, i) => s + ctx.target[i], 0);
  const all = want(items);
  interface Cut {
    quick: number;
    low: Box;
    high: Box;
    a: number[];
    rest: number[];
  }
  const cuts: Cut[] = [];
  for (const a of subMultisets(items)) {
    const rest = items.slice();
    for (const i of a) rest.splice(rest.indexOf(i), 1);
    const share = (want(a) / all) * total;
    for (const vertical of [true, false]) {
      // Sweep the cut across the box: the line where the low side holds
      // exactly its share, and any "natural" line near it — the edge of the
      // corridor, the hall or the stairs — that costs little area.
      const lo = vertical ? b.x0 : b.y0;
      const hi = vertical ? b.x1 : b.y1;
      const slab = (c: number) =>
        vertical ? rectSum(p.satFree, W, c, b.y0, c + 1, b.y1) : rectSum(p.satFree, W, b.x0, c, b.x1, c + 1);
      const slack = 0.25 * Math.min(want(a), want(rest)) * (total / all);
      const positions = new Set<number>();
      let cum = 0;
      let best = -1;
      let bestMiss = Infinity;
      for (let c = lo + 1; c < hi; c++) {
        const before = slab(c - 1);
        cum += before;
        const miss = Math.abs(cum - share);
        if (miss < bestMiss) {
          bestMiss = miss;
          best = c;
        }
        const after = slab(c);
        const step = Math.abs(after - before) > 0.25 * Math.max(after, before) && Math.max(after, before) > 0;
        if (step && miss <= slack && cum > 0 && cum < total) positions.add(c);
        if (cum > share + slack) break;
      }
      if (best >= 0) positions.add(best);
      for (const at of positions) {
        const low = vertical ? { ...b, x1: at } : { ...b, y1: at };
        const high = vertical ? { ...b, x0: at } : { ...b, y0: at };
        const quick = groupCost(ctx, low, a) + groupCost(ctx, high, rest);
        if (quick < Infinity) cuts.push({ quick, low, high, a, rest });
      }
    }
  }
  cuts.sort((u, v) => u.quick - v.quick);

  const tries = depth === 0 ? 8 : depth === 1 ? 5 : 3;
  const found: Solution[] = [];
  for (const cut of cuts.slice(0, tries)) {
    const left = solve(ctx, cut.low, cut.a, depth + 1);
    if (left.length === 0) continue;
    const right = solve(ctx, cut.high, cut.rest, depth + 1);
    for (const l of left) {
      for (const r of right) found.push({ cost: l.cost + r.cost, leaves: [...l.leaves, ...r.leaves] });
    }
  }
  found.sort((u, v) => u.cost - v.cost);
  result = found.slice(0, depth === 0 ? 24 : KEEP);
  ctx.memo.set(key, result);
  return result;
}

// ----------------------------------------------------------- strict checks

/** Free cells of a leaf, by index. */
function leafCells(p: Plate, b: Box): number[] {
  const out: number[] = [];
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const i = y * p.nx + x;
      if (p.kind[i] === FREE) out.push(i);
    }
  }
  return out;
}

/** A straight stretch of cell sides between the leaf and the hall or corridor. */
interface AccessRun {
  /** Middle of the stretch, on the grid line between the two cells. */
  mid: Pt;
  len: number;
  /** HALL or CORR. */
  to: number;
}

function longestAccessRun(p: Plate, inLeaf: (i: number) => boolean, b: Box, useSums = true): AccessRun | null {
  let best: AccessRun | null = null;
  const { nx, cell, ox, oy } = p;
  const consider = (len: number, mid: Pt, to: number) => {
    if (!best || len > best.len) best = { len, mid, to };
  };
  // Rows and columns without any access are skipped.
  const W = nx + 1;
  // Horizontal lines: the leaf below or above the access.
  for (let y = b.y0; y < b.y1; y++) {
    if (useSums && rectSum(p.satAcc, W, b.x0, y, b.x1, y + 1) === 0) continue;
    for (const dy of [-1, 1]) {
      let start = -1;
      let to = 0;
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * nx + x;
        const j = i + dy * nx;
        const k = x < b.x1 && inLeaf(i) && j >= 0 && j < p.kind.length ? p.kind[j] : 0;
        const ok = (k === HALL || k === CORR) && (start < 0 || k === to);
        if (ok && start < 0) {
          start = x;
          to = k;
        } else if (!ok && start >= 0) {
          consider((x - start) * cell, { x: ox + ((start + x) / 2) * cell, y: oy + (dy > 0 ? y + 1 : y) * cell }, to);
          start = -1;
          if (k === HALL || k === CORR) {
            start = x;
            to = k;
          }
        }
      }
    }
  }
  for (let x = b.x0; x < b.x1; x++) {
    if (useSums && rectSum(p.satAcc, W, x, b.y0, x + 1, b.y1) === 0) continue;
    for (const dx of [-1, 1]) {
      let start = -1;
      let to = 0;
      for (let y = b.y0; y <= b.y1; y++) {
        const i = y * nx + x;
        const nxIdx = x + dx;
        const k = y < b.y1 && inLeaf(i) && nxIdx >= 0 && nxIdx < nx ? p.kind[i + dx] : 0;
        const ok = (k === HALL || k === CORR) && (start < 0 || k === to);
        if (ok && start < 0) {
          start = y;
          to = k;
        } else if (!ok && start >= 0) {
          consider((y - start) * cell, { x: ox + (dx > 0 ? x + 1 : x) * cell, y: oy + ((start + y) / 2) * cell }, to);
          start = -1;
          if (k === HALL || k === CORR) {
            start = y;
            to = k;
          }
        }
      }
    }
  }
  return best;
}

/** Extra cost from the strict checks of one leaf, or Infinity when it fails one. */
function strictLeaf(ctx: SearchContext, leaf: Box): number {
  const { plate: p, rules } = ctx;
  const bw = leaf.x1 - leaf.x0;
  const bh = leaf.y1 - leaf.y0;
  const mask = new Uint8Array(bw * bh);
  let n = 0;
  let first = -1;
  for (let y = leaf.y0; y < leaf.y1; y++) {
    for (let x = leaf.x0; x < leaf.x1; x++) {
      if (p.kind[y * p.nx + x] !== FREE) continue;
      const j = (y - leaf.y0) * bw + (x - leaf.x0);
      mask[j] = 1;
      if (first < 0) first = j;
      n++;
    }
  }
  if (n === 0) return Infinity;
  // One piece: a flood fill from the first cell reaches them all.
  const seen = new Uint8Array(bw * bh);
  const stack = [first];
  seen[first] = 1;
  let reached = 0;
  while (stack.length) {
    const i = stack.pop()!;
    reached++;
    const x = i % bw;
    if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1);
    if (x < bw - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1);
    if (i >= bw && mask[i - bw] && !seen[i - bw]) (seen[i - bw] = 1), stack.push(i - bw);
    if (i + bw < mask.length && mask[i + bw] && !seen[i + bw]) (seen[i + bw] = 1), stack.push(i + bw);
  }
  if (reached !== n) return Infinity;
  const run = longestAccessRun(p, (i) => p.kind[i] === FREE, leaf);
  if (!run || run.len < rules.entranceRun - 1e-9) return Infinity;
  // Wide enough everywhere: what a square of the minimum width cannot reach is wasted.
  const k = Math.max(1, Math.round(rules.minApartmentWidth / p.cell));
  const open = opening(bw, bh, mask, k);
  let covered = 0;
  for (let i = 0; i < open.length; i++) covered += open[i];
  const share = covered / n;
  if (share < 0.85) return Infinity;
  return 4.0 * (1 - share);
}

// ------------------------------------------------------------------ drawing

export interface SplitApartment {
  apartmentId: string;
  name: string;
  unitType: string;
  /** Wanted area, and what it got, to wall centrelines. */
  wanted: number;
  area: number;
}

export interface SplitProposal {
  storey: Storey;
  access: Access;
  apartments: SplitApartment[];
  cost: number;
}

/** Point in the middle of a solid square of free cells of the given label, or null. */
function anchorIn(p: Plate, lab: Int32Array, label: number, b: Box, size: number): Pt | null {
  const { nx, cell, ox, oy } = p;
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const m = new Uint8Array(bw * bh);
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      if (lab[y * nx + x] === label) {
        m[(y - b.y0) * bw + (x - b.x0)] = 1;
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  if (n === 0) return null;
  const s = buildSat(bw, bh, m);
  const cx = sx / n - b.x0;
  const cy = sy / n - b.y0;
  for (let k = size; k >= 2; k = Math.floor(k / 2)) {
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let y = 0; y + k <= bh; y++) {
      for (let x = 0; x + k <= bw; x++) {
        if (rectSum(s, bw + 1, x, y, x + k, y + k) !== k * k) continue;
        const d = Math.hypot(x + k / 2 - cx, y + k / 2 - cy);
        if (d < bestD) {
          bestD = d;
          best = { x: ox + (b.x0 + x + k / 2) * cell, y: oy + (b.y0 + y + k / 2) * cell };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

const micro = (v: number) => Math.round(v * 1e6) / 1e6;

/** The walls a labelling calls for: every grid line where two different zones meet. */
function zoneWalls(p: Plate, lab: Int32Array, boundary: Wall[]): [Pt, Pt][] {
  const { nx, ny, cell, ox, oy } = p;
  const lines: [Pt, Pt][] = [];
  const real = (i: number) => i >= 0 && i < lab.length && lab[i] >= 0;
  /** Moves a run end onto the boundary wall it stops at, when it stops at one. */
  const snapEnd = (fixed: Pt, end: Pt): Pt => {
    const len = dist(fixed, end);
    if (len < 1e-9) return end;
    const d = { x: (end.x - fixed.x) / len, y: (end.y - fixed.y) / len };
    let best: number | null = null;
    for (const w of boundary) {
      const hit = lineIntersectionParams(fixed, end, w.a, w.b);
      if (!hit) continue;
      const slack = 1e-6 / dist(w.a, w.b);
      if (hit.u < -slack || hit.u > 1 + slack) continue;
      const along = hit.t * len;
      if (Math.abs(along - len) > 1.6 * cell) continue;
      if (best === null || Math.abs(along - len) < Math.abs(best - len)) best = along;
    }
    return best === null ? end : { x: micro(fixed.x + d.x * best), y: micro(fixed.y + d.y * best) };
  };
  const emit = (a: Pt, b: Pt, aOpen: boolean, bOpen: boolean) => {
    // A run end that is not met by another zone wall stops at a boundary wall.
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const A = aOpen ? snapEnd(mid, a) : a;
    const B = bOpen ? snapEnd(mid, b) : b;
    if (dist(A, B) > 1e-6) lines.push([A, B]);
  };
  // Vertical grid lines.
  for (let x = 1; x < nx; x++) {
    let start = -1;
    let pair = "";
    for (let y = 0; y <= ny; y++) {
      const i = y * nx + x - 1;
      const j = y * nx + x;
      const here = y < ny && real(i) && real(j) && lab[i] !== lab[j] ? `${lab[i]}|${lab[j]}` : "";
      if (here !== pair) {
        if (pair) {
          const openA = !(real((start - 1) * nx + x - 1) && real((start - 1) * nx + x)) || start === 0;
          const openB = !(y < ny && real(i) && real(j));
          emit({ x: micro(ox + x * cell), y: micro(oy + start * cell) }, { x: micro(ox + x * cell), y: micro(oy + y * cell) }, openA, openB);
        }
        pair = here;
        start = y;
      }
    }
  }
  // Horizontal grid lines.
  for (let y = 1; y < ny; y++) {
    let start = -1;
    let pair = "";
    for (let x = 0; x <= nx; x++) {
      const i = (y - 1) * nx + x;
      const j = y * nx + x;
      const here = x < nx && real(i) && real(j) && lab[i] !== lab[j] ? `${lab[i]}|${lab[j]}` : "";
      if (here !== pair) {
        if (pair) {
          const openA = start === 0 || !(real((y - 1) * nx + start - 1) && real(y * nx + start - 1));
          const openB = !(x < nx && real(i) && real(j));
          emit({ x: micro(ox + start * cell), y: micro(oy + y * cell) }, { x: micro(ox + x * cell), y: micro(oy + y * cell) }, openA, openB);
        }
        pair = here;
        start = x;
      }
    }
  }
  return lines;
}

/** Spaces of the structure: the hall, stairs, elevator and shafts. */
const CORE_TYPES = new Set(["stair", "elevator", "shaft"]);

/**
 * The storey with its own walls and apartments taken away: only the structure
 * is left. Doors in the hall walls that led into the old apartments go too;
 * doors between the hall and the stairs or elevator, and building entrances,
 * stay.
 */
export function emptiedStorey(storey: Storey, building?: Building): Storey {
  const kept = storey.walls.filter((w) => w.part);
  let base = kept.length === storey.walls.length ? storey : applyWalls(storey, kept);
  const linked = linkSpaces(base);
  const hallIds = new Set<string>();
  if (building) {
    for (const c of building.structure.core) {
      if (c.kind !== "hall") continue;
      const { min, max } = coreRect(c);
      const mid = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 };
      for (const sp of base.spaces) {
        const face = linked.faceBySpaceId.get(sp.id);
        if (face && pointInPolygon(mid, face.outer, face.holes)) hallIds.add(sp.id);
      }
    }
  }
  const structural = (id: string | null) => {
    if (id === null) return true;
    const sp = base.spaces.find((x) => x.id === id);
    return sp !== undefined && (CORE_TYPES.has(sp.type) || hallIds.has(sp.id));
  };
  const coreWalls = new Set(base.walls.filter((w) => w.part === "core").map((w) => w.id));
  const openings = base.openings.filter((o) => {
    if (o.entrance || o.kind !== "door" || !coreWalls.has(o.wallId)) return true;
    const [a, b] = openingSides(base, o, linked);
    return structural(a) && structural(b);
  });
  if (openings.length !== base.openings.length) base = { ...base, openings };
  return { ...base, apartments: [] };
}

/** Corridor kept past the last entrance door, beyond the door's own stretch of wall. */
const CORRIDOR_END_MARGIN = 1.0;

/**
 * Cuts the dead ends off the corridor: the band is run out to the outside
 * walls, so past the last entrance door it often leads nowhere. Those cells go
 * to the apartment whose box holds them. Peeling only ever takes a cell that
 * lies farthest from the hall among its corridor neighbours, so the rest of
 * the corridor stays connected; cells near an entrance stretch are kept.
 * Updates `lab` in place and returns the plate with the trimmed cells freed.
 */
function trimCorridor(p: Plate, lab: Int32Array, leaves: Box[], CORRIDOR_LABEL: number): Plate {
  const { nx, ny, cell } = p;
  const n = nx * ny;
  const isCorr = (i: number) => lab[i] === CORRIDOR_LABEL;
  const neighbours = (i: number): number[] => {
    const x = i % nx;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < nx - 1) out.push(i + 1);
    if (i >= nx) out.push(i - nx);
    if (i + nx < n) out.push(i + nx);
    return out;
  };
  const bfs = (seeds: number[], limit = Infinity): Float64Array => {
    const d = new Float64Array(n).fill(Infinity);
    const queue: number[] = [];
    for (const s of seeds) if (d[s] === Infinity) (d[s] = 0), queue.push(s);
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      if (d[i] >= limit) continue;
      for (const j of neighbours(i)) {
        if (isCorr(j) && d[j] === Infinity) (d[j] = d[i] + 1), queue.push(j);
      }
    }
    return d;
  };

  // Distance from the hall along the corridor.
  const hallSeeds: number[] = [];
  for (let i = 0; i < n; i++) if (isCorr(i) && neighbours(i).some((j) => p.kind[j] === HALL)) hallSeeds.push(i);
  if (hallSeeds.length === 0) return p;
  const fromHall = bfs(hallSeeds);

  // Corridor cells within reach of an entrance stretch are kept.
  const keep = new Uint8Array(n);
  for (const leaf of leaves) {
    const set = new Set(leafCells(p, leaf));
    const run = longestAccessRun(p, (i) => set.has(i), leaf);
    if (!run || run.to !== CORR) continue;
    const at = nudgeTowards(p, run.mid, CORR);
    // nudgeTowards steps four half-cells in; one half-cell lands in the first corridor cell.
    const back = { x: run.mid.x + (at.x - run.mid.x) / 4, y: run.mid.y + (at.y - run.mid.y) / 4 };
    const cx = Math.floor((back.x - p.ox) / cell);
    const cy = Math.floor((back.y - p.oy) / cell);
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny || !isCorr(cy * nx + cx)) return p;
    const reach = Math.ceil((run.len / 2 + CORRIDOR_END_MARGIN) / cell);
    const d = bfs([cy * nx + cx], reach);
    for (let i = 0; i < n; i++) if (d[i] <= reach) keep[i] = 1;
  }
  for (const s of hallSeeds) keep[s] = 1;

  const owner = (i: number): number => {
    const x = i % nx;
    const y = Math.floor(i / nx);
    return leaves.findIndex((l) => x >= l.x0 && x < l.x1 && y >= l.y0 && y < l.y1);
  };
  const kind = p.kind.slice();
  let changed = false;
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < n; i++) {
      if (!isCorr(i) || keep[i]) continue;
      if (neighbours(i).some((j) => isCorr(j) && fromHall[j] > fromHall[i])) continue;
      const k = owner(i);
      if (k < 0 || !neighbours(i).some((j) => lab[j] === k)) continue;
      lab[i] = k;
      kind[i] = FREE;
      changed = true;
      again = true;
    }
  }
  return changed ? { ...p, kind } : p;
}

/** Draws one solution on the emptied storey; null when it does not come out clean. */
function draw(
  ctx: SearchContext,
  base: Storey,
  units: UnitType[],
  sol: Solution,
  access: Access,
): SplitProposal | null {
  const { rules } = ctx;
  let p = ctx.plate;
  const CORRIDOR_LABEL = 1_000_000;
  const lab = new Int32Array(p.kind.length).fill(-1);
  // Apartments are numbered around the plan.
  const centre = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const mid = { x: p.nx / 2, y: p.ny / 2 };
  const turn = (l: Box) => (Math.atan2(centre(l).y - mid.y, centre(l).x - mid.x) + 2 * Math.PI) % (2 * Math.PI);
  const leaves = sol.leaves.slice().sort((u, v) => turn(u) - turn(v));
  leaves.forEach((l, k) => {
    for (const i of leafCells(p, l)) lab[i] = k;
  });
  for (let i = 0; i < lab.length; i++) if (p.kind[i] === CORR) lab[i] = CORRIDOR_LABEL;
  if (access === "corridor") p = trimCorridor(p, lab, leaves, CORRIDOR_LABEL);

  const boundary = base.walls.filter((w) => w.part);
  const lines = zoneWalls(p, lab, boundary);
  const added: Wall[] = lines.map(([a, b]) => ({
    id: newId("wall"),
    a,
    b,
    thickness: rules.partyWallThickness,
    kind: "interior",
  }));
  let storey = applyWalls(base, [...base.walls, ...added]);
  const addedIds = new Set(added.map((w) => w.id));

  // Each apartment must now be a room of its own.
  const linked = linkSpaces(storey);
  const spaceAt = (pt: Pt) => {
    for (const s of storey.spaces) {
      const f = linked.faceBySpaceId.get(s.id);
      if (f && pointInPolygon(pt, f.outer, f.holes)) return s;
    }
    return null;
  };
  const apartments: Apartment[] = [];
  const summary: SplitApartment[] = [];
  const used = new Set<string>();
  for (let k = 0; k < leaves.length; k++) {
    const at = anchorIn(p, lab, k, leaves[k], Math.round(1 / p.cell));
    const space = at && spaceAt(at);
    if (!space || used.has(space.id)) return null;
    used.add(space.id);
    const unit = units[leaves[k].type];
    const name = `A${k + 1}`;
    const face = linked.faceBySpaceId.get(space.id)!;
    storey = updateSpace(storey, space.id, { name, type: "room" });
    const apartment: Apartment = {
      id: newId("apartment"),
      name,
      spaceIds: [space.id],
      program: { ...unit.program },
      unitType: unit.name,
      targetArea: Math.round(unit.area * 100) / 100,
    };
    apartments.push(apartment);
    summary.push({
      apartmentId: apartment.id,
      name,
      unitType: unit.name,
      wanted: unit.area,
      area: face.centrelineArea,
    });
  }
  let corridors = 0;
  for (const comp of components(p.nx, p.ny, (i) => lab[i] === CORRIDOR_LABEL)) {
    const xs = comp.map((i) => i % p.nx);
    const ys = comp.map((i) => Math.floor(i / p.nx));
    const box: Box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };
    const at = anchorIn(p, lab, CORRIDOR_LABEL, box, Math.round(0.6 / p.cell));
    const space = at && spaceAt(at);
    if (!space || used.has(space.id)) return null;
    used.add(space.id);
    corridors++;
    storey = updateSpace(storey, space.id, { name: corridors > 1 ? `Corridor ${corridors}` : "Corridor", type: "corridor" });
  }
  storey = { ...storey, apartments };

  // Doors: from the hall into each corridor, and from the hall or corridor into each apartment.
  const door = (point: Pt, wallFilter: (w: Wall) => boolean, width: number, sides: [string, string]): boolean => {
    const hit = locateOnWall({ ...storey, walls: storey.walls.filter(wallFilter) }, point, 0.35);
    if (!hit) return false;
    const next = addOpening(storey, hit.wallId, "door", hit.offset, { width, height: rules.entranceDoor.height, sill: 0 });
    if (next === storey) return false;
    const between = openingSides(next, next.openings[next.openings.length - 1]);
    if (!sides.every((s) => between.includes(s))) return false;
    storey = next;
    return true;
  };
  const hallSpaceOf = (pt: Pt) => spaceAt(pt)?.id ?? "";
  for (const comp of components(p.nx, p.ny, (i) => lab[i] === CORRIDOR_LABEL)) {
    const set = new Set(comp);
    const xs = comp.map((i) => i % p.nx);
    const ys = comp.map((i) => Math.floor(i / p.nx));
    const box: Box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 };
    // The corridor's stretch of hall wall.
    const fake: Plate = { ...p, kind: p.kind.map((k) => (k === CORR ? FREE : k)) as Uint8Array };
    const run = longestAccessRun(fake, (i) => set.has(i), box, false);
    if (!run || run.to !== HALL) return null;
    const corridorSpace = spaceAt(anchorIn(p, lab, CORRIDOR_LABEL, box, Math.round(0.6 / p.cell))!)!.id;
    const width = Math.min(1.2, run.len - 0.2, rules.corridorWidth - 0.1);
    if (!door(run.mid, (w) => w.part === "core", width, [corridorSpace, hallSpaceOf(nudgeTowards(p, run.mid, HALL))])) {
      return null;
    }
  }
  for (let k = 0; k < leaves.length; k++) {
    const set = new Set(leafCells(p, leaves[k]));
    const run = longestAccessRun(p, (i) => set.has(i), leaves[k]);
    if (!run) return null;
    const spaceId = apartments[k].spaceIds[0];
    const other = hallSpaceOf(nudgeTowards(p, run.mid, run.to));
    const filter = run.to === HALL ? (w: Wall) => w.part === "core" : (w: Wall) => addedIds.has(w.id);
    if (!door(run.mid, filter, rules.entranceDoor.width, [spaceId, other])) return null;
  }

  return { storey, access, apartments: summary, cost: sol.cost };
}

/** A point just across a grid line from `at`, into the neighbouring cell of the given kind. */
function nudgeTowards(p: Plate, at: Pt, kind: number): Pt {
  const step = p.cell / 2;
  for (const [dx, dy] of [
    [step, 0],
    [-step, 0],
    [0, step],
    [0, -step],
  ]) {
    const q = { x: at.x + dx, y: at.y + dy };
    const cx = Math.floor((q.x - p.ox) / p.cell);
    const cy = Math.floor((q.y - p.oy) / p.cell);
    if (cx >= 0 && cy >= 0 && cx < p.nx && cy < p.ny && p.kind[cy * p.nx + cx] === kind) {
      // Further in, past the wall it is drawn on.
      return { x: at.x + dx * 4, y: at.y + dy * 4 };
    }
  }
  return at;
}

// --------------------------------------------------------------------- main

export type SplitResult =
  | { ok: true; proposals: SplitProposal[]; usable: number | null; wanted: number }
  | { ok: false; reason: string; usable: number | null; wanted: number };

/**
 * Up to `count` ways to divide the storey into the wanted apartments, best
 * first, each ready to apply. The storey's own walls and apartments are
 * replaced; the outside walls, hall, stairs and elevator stay. Wanted areas
 * are scaled together so the whole floor is used.
 */
export function proposeSplits(
  building: Building,
  storey: Storey,
  units: UnitType[],
  access: Access | "auto",
  rules: SplitRules,
  count = 3,
  options: SplitOptions = {},
): SplitResult {
  const items: number[] = [];
  units.forEach((u, i) => {
    for (let n = 0; n < Math.max(0, Math.round(u.count)); n++) items.push(i);
  });
  const wanted = items.reduce((s, i) => s + units[i].area, 0);
  const usable = usableArea(building, storey.id, rules);
  if (items.length === 0) return { ok: false, reason: "Add at least one apartment to the mix.", usable, wanted };
  if (items.length > 16) return { ok: false, reason: "At most 16 apartments per storey.", usable, wanted };
  if (units.some((u) => !(u.area > 0))) return { ok: false, reason: "Every apartment type needs an area.", usable, wanted };

  const base = emptiedStorey(storey, building);
  const modes: Access[] = access === "auto" ? ["hall", "corridor"] : [access];
  const proposals: SplitProposal[] = [];
  let reason = "";
  const attempts: { mode: Access; layout?: CorridorLayout }[] = [];
  for (const mode of modes) {
    if (mode === "hall") attempts.push({ mode });
    else for (const layout of options.corridorLayouts ?? CORRIDOR_LAYOUTS) attempts.push({ mode, layout });
  }
  const seenPlates = new Set<string>();
  const seenPlans = new Set<string>();
  let hallFailed = false;
  for (const { mode, layout } of attempts) {
    // A plan reached from the hall alone needs no corridor.
    if (mode === "corridor" && access === "auto" && proposals.some((q) => q.access === "hall")) break;
    const built = buildPlate(building, storey.id, rules, mode, layout, options.blind ?? []);
    if (!built.ok) {
      reason ||= built.reason;
      continue;
    }
    const plate = built.plate;
    let corridorCells = 0;
    let plateKey = "";
    for (let i = 0; i < plate.kind.length; i++) {
      if (plate.kind[i] === CORR) {
        corridorCells++;
        plateKey += i + ",";
      }
    }
    if (seenPlates.has(plateKey)) continue;
    seenPlates.add(plateKey);
    // Corridor is floor no apartment gets.
    const corridorCost = 6.0 * (corridorCells / (corridorCells + plate.freeCells));
    const scale = plate.freeCells / items.reduce((s, i) => s + units[i].area / rules.cellSize ** 2, 0);
    const ctx: SearchContext = {
      plate,
      rules,
      target: units.map((u) => (u.area / rules.cellSize ** 2) * scale),
      corner: units.map((u) => u.corner === true),
      memo: new Map(),
      strict: new Map(),
      budget: 6000,
    };
    const root = tight(plate, { x0: 0, y0: 0, x1: plate.nx, y1: plate.ny });
    if (!root) continue;
    const sorted = items.slice().sort((a, b) => a - b);
    const solutions = solve(ctx, root, sorted, 0);
    let drawn = 0;
    for (const s of solutions) {
      if (drawn >= count) break;
      const proposal = draw(ctx, base, units, { ...s, cost: s.cost + corridorCost }, mode);
      if (!proposal) continue;
      const plan = proposal.storey.walls
        .filter((w) => !w.part)
        .map((w) => [w.a.x, w.a.y, w.b.x, w.b.y].map((v) => v.toFixed(2)).join(" "))
        .sort()
        .join("|");
      if (seenPlans.has(plan)) continue;
      seenPlans.add(plan);
      proposals.push(proposal);
      drawn++;
    }
    if (drawn === 0 && mode === "hall") hallFailed = true;
  }
  if (proposals.length === 0 && !reason) {
    reason =
      access === "hall" || (access === "auto" && hallFailed && modes.length === 1)
        ? "The hall cannot reach every apartment with a straight stretch of wall for its door."
        : access === "corridor"
          ? "Even with a corridor, the floor cannot be divided into these apartments."
          : "Neither the hall alone nor a corridor from it can reach every apartment with daylight.";
  }
  proposals.sort((a, b) => a.cost - b.cost);
  if (proposals.length === 0) {
    return {
      ok: false,
      reason:
        `${reason} Try fewer apartments, other sizes${access === "hall" ? ", or a corridor" : ", or a larger hall"}.`,
      usable,
      wanted,
    };
  }
  return { ok: true, proposals: proposals.slice(0, count), usable, wanted };
}
