/**
 * Apartment subdivision: a living room plus a chosen programme of private
 * rooms — any number of bedrooms, bathrooms, separate WCs and storerooms, and
 * a separate kitchen or an open-plan kitchen zone inside the living room —
 * with a corridor where needed.
 *
 * Method: rasterise the apartment onto a facade-aligned grid, enumerate
 * rectangle candidates for every private room with summed-area tables,
 * combine them by beam search (all combinations when there are only two),
 * derive the living room and corridor from what is left by morphological
 * opening, reject layouts that break a rule and score the rest. The winner is
 * then re-evaluated on a fine grid and its walls nudged one at a time (hill
 * climbing), and finally vectorised: polygons are clipped to the true outline
 * and pulled apart by the partition thickness.
 *
 * Units are metres. Edge i of the polygon runs polygon[i] -> polygon[i + 1].
 * The outline is taken as the inner face of the apartment's perimeter walls.
 */
import { difference, intersection, union } from "polyclip-ts";

// ---------------------------------------------------------------- public API

export interface Pt {
  x: number;
  y: number;
}

export type RoomType = "living" | "bedroom" | "bathroom" | "wc" | "kitchen" | "storage" | "corridor";

/** The rooms an apartment gets besides its living room. */
export interface RoomProgram {
  bedrooms: number;
  bathrooms: number;
  /** Separate toilets. */
  wc: number;
  storage: number;
  /**
   * "open": a kitchen zone inside the living room; "separate": a kitchen of
   * its own with a window; "none": no kitchen is planned.
   */
  kitchen: "open" | "separate" | "none";
}

export const DEFAULT_PROGRAM: RoomProgram = { bedrooms: 1, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" };

/** Largest counts the search is asked to place. */
export const PROGRAM_LIMITS = { bedrooms: 5, bathrooms: 3, wc: 2, storage: 2 } as const;

/** The programme with every count made a whole number within the limits. */
export function normalizeProgram(p: Partial<RoomProgram> | undefined): RoomProgram {
  const count = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;
  const d = DEFAULT_PROGRAM;
  return {
    bedrooms: count(p?.bedrooms, 0, PROGRAM_LIMITS.bedrooms, d.bedrooms),
    bathrooms: count(p?.bathrooms, 1, PROGRAM_LIMITS.bathrooms, d.bathrooms),
    wc: count(p?.wc, 0, PROGRAM_LIMITS.wc, d.wc),
    storage: count(p?.storage, 0, PROGRAM_LIMITS.storage, d.storage),
    kitchen: p?.kitchen === "separate" || p?.kitchen === "none" || p?.kitchen === "open" ? p.kitchen : d.kitchen,
  };
}

/** Room kinds the size rules are given for; the first bedroom is the main one. */
export type SizedRoom = "living" | "mainBedroom" | "bedroom" | "kitchen" | "bathroom" | "wc" | "storage" | "corridor";
export const SIZED_ROOMS: SizedRoom[] = ["living", "mainBedroom", "bedroom", "kitchen", "bathroom", "wc", "storage", "corridor"];

export interface RoomSize {
  /** Least net floor area, m2. */
  minArea: number;
  /** Least clear width, m. */
  minWidth: number;
}

/** What a rule names: a kind of room, or the apartment's entrance door. */
export type RuleRoom = "living" | "bedroom" | "kitchen" | "bathroom" | "wc" | "storage" | "corridor" | "entrance";
export const RULE_ROOMS: RuleRoom[] = ["living", "bedroom", "kitchen", "bathroom", "wc", "storage", "corridor", "entrance"];

/**
 * opensTo: every room of kind `a` has its door into a room of kind `b`.
 * notOpensTo: no room of kind `a` has its door into one of kind `b`.
 * near: each room of kind `a` is close to one of kind `b` (shares a wall or
 * lies within nearDistance; to the entrance: that far to walk).
 * adjacent: each room of kind `a` shares a wall with one of kind `b`.
 * apart: no room of kind `a` shares a wall with one of kind `b`.
 */
export type AdjacencyKind = "opensTo" | "notOpensTo" | "near" | "adjacent" | "apart";
export const ADJACENCY_KINDS: AdjacencyKind[] = ["opensTo", "notOpensTo", "near", "adjacent", "apart"];

export interface AdjacencyRule {
  a: RuleRoom;
  b: RuleRoom;
  rule: AdjacencyKind;
  /** Cost of breaking it, against the other soft criteria (about 0.5 to 3). */
  weight: number;
  /** A layout that breaks it is not offered at all. */
  hard?: boolean;
  /** The rule in words, as the report shows it. */
  text: string;
}

export interface CirculationRules {
  /** Cost of the average walk from the entrance to the room doors, per apartment diagonal. */
  walkWeight: number;
  /** Longest acceptable walk from the entrance door to a room's door, m. */
  maxWalk: number;
  /** Cost of bedrooms that lie close to the entrance instead of deeper in the plan. */
  nightZone: number;
  /** Largest share of the apartment that corridors should take. */
  maxCorridorShare: number;
  /** Rooms whose centres are this close count as near each other, m. */
  nearDistance: number;
}

/** One line of a layout's rule report. */
export interface RuleCheck {
  group: "size" | "adjacency" | "circulation";
  text: string;
  ok: boolean;
  /** What breaks it, or the measured value. */
  detail?: string;
}

export interface ApartmentInput {
  /** Closed outline, without a repeated last vertex. Either winding. */
  polygon: Pt[];
  /** Indices of the edges that are exterior facade (natural light). */
  facadeEdges: number[];
  /** Entrance door position, on or near the outline. */
  entrance: Pt;
  /** Optional plumbing stack / shaft the bathroom should sit next to. */
  plumbingStack?: Pt;
}

export interface SubdivisionOptions {
  /** Grid module of the search. */
  cellSize: number;
  /**
   * Module the winning layout is refined to; walls end up on multiples of
   * this. Must divide cellSize. 0 keeps the search grid.
   */
  refineCellSize: number;
  /** Thickness of the partitions between rooms. 0 gives touching polygons. */
  wallThickness: number;
  /** Longest/shortest side limit for the bedroom. */
  maxBedroomAspect: number;
  /** Longest/shortest side limit for the bathroom. */
  maxBathroomAspect: number;
  /** Leftovers smaller than this never become a corridor of their own. */
  minCorridorArea: number;
  /** Shared wall length two rooms need before a door fits between them. */
  doorWidth: number;
  /** Radius around the entrance that must stay circulation space. */
  entranceClearance: number;
  /** Facade length the living room / bedroom must own (hard minimum). */
  minLivingFacade: number;
  minBedroomFacade: number;
  /** Target areas as a share of the apartment, clamped to [min, max] m2. */
  bedroomShare: number;
  bedroomAreaRange: [number, number];
  bathroomShare: number;
  bathroomAreaRange: [number, number];
  /** Rooms to place besides the living room. */
  program: RoomProgram;
  /** Target areas of the rooms after the first bedroom and the first bathroom, and of the others. */
  secondBedroomArea: number;
  secondBathroomArea: number;
  wcArea: number;
  kitchenArea: number;
  storageArea: number;
  /** Window length a separate kitchen must have. */
  minKitchenFacade: number;
  /** Search width: how many candidates of each kind are combined. */
  bedroomCandidates: number;
  bathroomCandidates: number;
  /** Mark an open-plan kitchen zone inside the living room. */
  kitchen: boolean;
  /** Counter depth plus the working aisle in front of it. */
  kitchenDepth: number;
  kitchenCounterDepth: number;
  /** Shortest / longest counter run. */
  kitchenLength: [number, number];
  /** Least area and width per kind of room. */
  roomSizes: Record<SizedRoom, RoomSize>;
  /** Which rooms open into, lie near or keep away from which. */
  adjacency: AdjacencyRule[];
  /** How easy the apartment is to walk through. */
  circulation: CirculationRules;
}

export const DEFAULT_OPTIONS: SubdivisionOptions = {
  cellSize: 0.25,
  refineCellSize: 0.05,
  wallThickness: 0.1,
  maxBedroomAspect: 1.6,
  maxBathroomAspect: 2.0,
  minCorridorArea: 1.2,
  doorWidth: 0.9,
  entranceClearance: 1.1,
  minLivingFacade: 2.0,
  minBedroomFacade: 1.5,
  bedroomShare: 0.27,
  bedroomAreaRange: [9, 16],
  bathroomShare: 0.08,
  bathroomAreaRange: [3.5, 6],
  program: DEFAULT_PROGRAM,
  secondBedroomArea: 10,
  secondBathroomArea: 3.8,
  wcArea: 1.6,
  kitchenArea: 7,
  storageArea: 2,
  minKitchenFacade: 1.2,
  bedroomCandidates: 80,
  bathroomCandidates: 40,
  kitchen: true,
  kitchenDepth: 1.8,
  kitchenCounterDepth: 0.6,
  kitchenLength: [2.4, 3.6],
  roomSizes: {
    living: { minArea: 14, minWidth: 3.0 },
    mainBedroom: { minArea: 12, minWidth: 2.8 },
    bedroom: { minArea: 8, minWidth: 2.4 },
    kitchen: { minArea: 6, minWidth: 1.8 },
    bathroom: { minArea: 3.5, minWidth: 1.6 },
    wc: { minArea: 1.2, minWidth: 0.9 },
    storage: { minArea: 1.0, minWidth: 0.9 },
    corridor: { minArea: 0, minWidth: 1.0 },
  },
  adjacency: [
    { a: "kitchen", b: "living", rule: "opensTo", weight: 1.0, text: "The kitchen opens into the living room" },
    { a: "bathroom", b: "living", rule: "notOpensTo", weight: 1.5, text: "Bathrooms open off the hall, not the living room" },
    { a: "wc", b: "living", rule: "notOpensTo", weight: 1.0, text: "The WC opens off the hall, not the living room" },
    { a: "bedroom", b: "living", rule: "notOpensTo", weight: 0.8, text: "Bedrooms open off the hall, not the living room" },
    { a: "bathroom", b: "bedroom", rule: "near", weight: 1.0, text: "A bathroom near the bedrooms" },
    { a: "wc", b: "entrance", rule: "near", weight: 1.0, text: "The WC near the entrance" },
    { a: "storage", b: "entrance", rule: "near", weight: 0.5, text: "Storage near the entrance" },
    { a: "bathroom", b: "wc", rule: "near", weight: 1.0, text: "Wet rooms together, on one riser" },
    { a: "bathroom", b: "bathroom", rule: "near", weight: 1.0, text: "Bathrooms together, on one riser" },
    { a: "bedroom", b: "kitchen", rule: "apart", weight: 0.5, text: "No bedroom shares a wall with the kitchen" },
  ],
  circulation: { walkWeight: 1.0, maxWalk: 12, nightZone: 0.75, maxCorridorShare: 0.15, nearDistance: 4.5 },
};

export interface Room {
  id: string;
  type: RoomType;
  /** Net outline (inside face of the partitions), no repeated last vertex. */
  polygon: Pt[];
  holes: Pt[][];
  /** Net floor area. */
  area: number;
  /** Length of exterior facade this room owns (grid-measured). */
  facadeLength: number;
}

export interface Door {
  /** "opening" is a doorless gap between the living room and a corridor. */
  kind: "entrance" | "door" | "opening";
  /** Room ids on either side; the entrance has only one. */
  rooms: [string] | [string, string];
  position: Pt;
  width: number;
}

export interface Zone {
  type: "kitchen";
  /** Part of the room it belongs to; not separated by walls. */
  room: string;
  polygon: Pt[];
  /** Footprint of the counter run along the backing wall. */
  counter: Pt[];
  area: number;
}

export interface WallPolygon {
  polygon: Pt[];
  holes: Pt[][];
}

export interface Layout {
  rooms: Room[];
  doors: Door[];
  zones: Zone[];
  /** Partition footprints with the door gaps cut out. Empty if wallThickness is 0. */
  walls: WallPolygon[];
  /** Lower is better. Only comparable between layouts of one apartment. */
  cost: number;
  /** 1 = all default minimums held; lower = minimums were scaled by this. */
  relaxation: number;
  /** How the layout fares against each size, adjacency and circulation rule. */
  checks: RuleCheck[];
}

/** Best layout, or an error when the outline cannot hold the programme. */
export function subdivideApartment(
  input: ApartmentInput,
  options: Partial<SubdivisionOptions> = {},
): Layout {
  const layouts = generateLayouts(input, options, 1);
  if (layouts.length === 0) {
    throw new Error(
      "No valid layout: the outline cannot fit the programme with daylight in the living room and bedrooms.",
    );
  }
  return layouts[0];
}

/** Up to `count` distinct layouts, best first. */
export function generateLayouts(
  input: ApartmentInput,
  options: Partial<SubdivisionOptions> = {},
  count = 3,
): Layout[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.program = normalizeProgram(opts.program);
  if (input.polygon.length < 3) throw new Error("Polygon needs at least 3 vertices.");
  if (input.facadeEdges.length === 0) throw new Error("At least one facade edge is required.");

  const grid = buildGrid(input, opts);
  const ratio = opts.refineCellSize > 0 ? Math.round(opts.cellSize / opts.refineCellSize) : 1;
  let fine: { grid: Grid; opts: SubdivisionOptions } | null = null;

  // Width / facade minimums are relaxed step by step for tight outlines.
  for (const relax of [1, 0.85, 0.7]) {
    const params = deriveParams(grid, opts, relax);
    const found = search(grid, params, count);
    if (found.length === 0) continue;
    const layouts = found.map((ev) => {
      if (ratio > 1) {
        if (!fine) {
          const fineOpts = { ...opts, cellSize: opts.cellSize / ratio };
          fine = { grid: buildGrid(input, fineOpts), opts: fineOpts };
        }
        const fineParams = deriveParams(fine.grid, fine.opts, relax);
        const refined = refine(fine.grid, fineParams, ev, ratio);
        if (refined) return toLayout(fine.grid, fineParams, refined, input, relax);
      }
      return toLayout(grid, params, ev, input, relax);
    });
    return layouts.sort((a, b) => a.cost - b.cost);
  }
  return [];
}

// ------------------------------------------------------------------ geometry

type Ring = [number, number][];
type Poly = Ring[];
type MultiPoly = Poly[];

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return s / 2;
}

function polyArea(poly: Poly): number {
  let a = Math.abs(ringArea(poly[0]));
  for (const hole of poly.slice(1)) a -= Math.abs(ringArea(hole));
  return a;
}

/** Drops the closing vertex, duplicates and collinear points. */
function cleanRing(ring: Ring): Ring {
  const pts = ring.slice();
  if (pts.length > 1) {
    const f = pts[0];
    const l = pts[pts.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) pts.pop();
  }
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-7) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** Snaps to a micron lattice so edges meant to coincide are bit-identical for the clipper. */
const snap = (v: number) => Math.round(v * 1e6) / 1e6;

function rectPoly(x0: number, y0: number, x1: number, y1: number): Poly {
  x0 = snap(x0);
  y0 = snap(y0);
  x1 = snap(x1);
  y1 = snap(y1);
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}

function unionAll(polys: Poly[]): MultiPoly {
  return polys.length === 1 ? [polys[0]] : (union(polys[0], ...polys.slice(1)) as MultiPoly);
}

function largest(mp: MultiPoly): Poly | null {
  let best: Poly | null = null;
  let bestArea = 0;
  for (const poly of mp) {
    const a = Math.abs(ringArea(poly[0]));
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  return best;
}

// ---------------------------------------------------------------------- grid

const OUT = -1;
const FREE = 0;
const LIVING = 1;
/** Private rooms take the labels from here on, then the corridors (Params.corridor0). */
const PRIVATE0 = 2;
/** Two labels packed into one key; labels stay well below this. */
const KEY = 1024;
const PAD = 2; // empty margin, needed when rooms are grown out to the true outline

interface Grid {
  nx: number;
  ny: number;
  cell: number;
  ox: number;
  oy: number;
  cos: number;
  sin: number;
  /** OUT or FREE per cell. */
  base: Int16Array;
  /** Per cell: how many of its 4 sides lie on the facade / on any outer wall. */
  facEdges: Uint8Array;
  wallEdges: Uint8Array;
  clear: Uint8Array;
  satIn: Int32Array;
  satFac: Int32Array;
  satWall: Int32Array;
  satClear: Int32Array;
  insideCells: number;
  diag: number;
  localPoly: Pt[];
  entrance: Pt;
  entranceIdx: number;
  stack?: Pt;
}

function buildGrid(input: ApartmentInput, opts: SubdivisionOptions): Grid {
  const poly = input.polygon;
  const n = poly.length;
  const facade = new Set(input.facadeEdges.map((i) => ((i % n) + n) % n));

  // Align the grid with the longest facade edge so walls run parallel to it.
  let theta = 0;
  let longest = -1;
  for (const i of facade) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const len = dist(a, b);
    if (len > longest) {
      longest = len;
      theta = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const toLocal = (p: Pt): Pt => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos });

  const localPoly = poly.map(toLocal);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of localPoly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const cell = opts.cellSize;
  const nx = Math.ceil((maxX - minX) / cell - 1e-9) + 2 * PAD;
  const ny = Math.ceil((maxY - minY) / cell - 1e-9) + 2 * PAD;
  const ox = minX - PAD * cell;
  const oy = minY - PAD * cell;

  const base = new Int16Array(nx * ny).fill(OUT);
  let insideCells = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (pointInPolygon({ x: ox + (x + 0.5) * cell, y: oy + (y + 0.5) * cell }, localPoly)) {
        base[y * nx + x] = FREE;
        insideCells++;
      }
    }
  }

  // Classify every exposed cell side by the outline edge nearest to it.
  const facEdges = new Uint8Array(nx * ny);
  const wallEdges = new Uint8Array(nx * ny);
  const sides: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (base[i] === OUT) continue;
      for (const [dx, dy] of sides) {
        const qx = x + dx;
        const qy = y + dy;
        if (qx >= 0 && qy >= 0 && qx < nx && qy < ny && base[qy * nx + qx] !== OUT) continue;
        const mid = { x: ox + (x + 0.5 + dx / 2) * cell, y: oy + (y + 0.5 + dy / 2) * cell };
        let bestEdge = 0;
        let bestDist = Infinity;
        for (let e = 0; e < n; e++) {
          const d = distToSegment(mid, localPoly[e], localPoly[(e + 1) % n]);
          if (d < bestDist) {
            bestDist = d;
            bestEdge = e;
          }
        }
        wallEdges[i]++;
        if (facade.has(bestEdge)) facEdges[i]++;
      }
    }
  }

  // Entrance cell and the clearance zone that must stay circulation.
  const entrance = toLocal(input.entrance);
  const clear = new Uint8Array(nx * ny);
  let entranceIdx = -1;
  let bestD = Infinity;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (base[i] === OUT) continue;
      const d = Math.hypot(ox + (x + 0.5) * cell - entrance.x, oy + (y + 0.5) * cell - entrance.y);
      if (d < bestD) {
        bestD = d;
        entranceIdx = i;
      }
      if (d <= opts.entranceClearance) clear[i] = 1;
    }
  }
  clear[entranceIdx] = 1;

  const inside = new Uint8Array(nx * ny);
  for (let i = 0; i < inside.length; i++) inside[i] = base[i] === OUT ? 0 : 1;

  return {
    nx,
    ny,
    cell,
    ox,
    oy,
    cos,
    sin,
    base,
    facEdges,
    wallEdges,
    clear,
    satIn: buildSat(nx, ny, inside),
    satFac: buildSat(nx, ny, facEdges),
    satWall: buildSat(nx, ny, wallEdges),
    satClear: buildSat(nx, ny, clear),
    insideCells,
    diag: Math.hypot(maxX - minX, maxY - minY),
    localPoly,
    entrance,
    entranceIdx,
    stack: input.plumbingStack ? toLocal(input.plumbingStack) : undefined,
  };
}

/** Summed-area table: any rectangle sum in O(1). */
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

/** Morphological opening by a k x k square: keeps only cells some full square covers. */
function opening(g: Grid, mask: Uint8Array, k: number): Uint8Array {
  const { nx, ny } = g;
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

/** 4-connected components of the cells where mask is set. */
function components(g: Grid, mask: Uint8Array): number[][] {
  const { nx, ny } = g;
  const seen = new Uint8Array(nx * ny);
  const result: number[][] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const comp: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % nx;
      const y = (i - x) / nx;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1);
      if (x < nx - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1);
      if (y > 0 && mask[i - nx] && !seen[i - nx]) (seen[i - nx] = 1), stack.push(i - nx);
      if (y < ny - 1 && mask[i + nx] && !seen[i + nx]) (seen[i + nx] = 1), stack.push(i + nx);
    }
    result.push(comp);
  }
  return result;
}

/**
 * Corners of a labelled region that a partition takes part in: a neighbouring
 * room must touch the corner. Corners formed by the outline alone are given
 * (and on a slanted wall are only the grid staircase), so they are not counted.
 */
function cornerCount(g: Grid, lab: Int16Array, label: number): number {
  const { nx, ny } = g;
  let corners = 0;
  for (let y = 1; y < ny; y++) {
    for (let x = 1; x < nx; x++) {
      const i = y * nx + x;
      const va = lab[i - nx - 1];
      const vb = lab[i - nx];
      const vc = lab[i - 1];
      const vd = lab[i];
      if (va === vb && vb === vc && vc === vd) continue;
      if (
        !(va > 0 && va !== label) &&
        !(vb > 0 && vb !== label) &&
        !(vc > 0 && vc !== label) &&
        !(vd > 0 && vd !== label)
      ) {
        continue;
      }
      const a = va === label ? 1 : 0;
      const b = vb === label ? 1 : 0;
      const c = vc === label ? 1 : 0;
      const d = vd === label ? 1 : 0;
      const sum = a + b + c + d;
      if (sum === 1 || sum === 3) corners++;
      else if (sum === 2 && a === d) corners += 2;
    }
  }
  return corners;
}

function maskOf(lab: Int16Array, value: number): Uint8Array {
  const m = new Uint8Array(lab.length);
  for (let i = 0; i < lab.length; i++) if (lab[i] === value) m[i] = 1;
  return m;
}

// ---------------------------------------------------------------- candidates

type PrivateKind = "bedroom" | "bathroom" | "wc" | "kitchen" | "storage";

/** One private room of the programme: everything but the living room and corridors. */
interface Private {
  kind: PrivateKind;
  /** Its label on the grid. */
  label: number;
  /** Id of the room in the layout. */
  id: string;
  target: number;
  spec: RoomSpec;
  /** Rooms with the same group share one candidate list. */
  group: number;
  /** Which size rule applies. */
  size: SizedRoom;
}

interface Params {
  kLiving: number;
  kCorridor: number;
  doorCells: number;
  minCorridorCells: number;
  minLivingFacade: number;
  minLivingArea: number;
  privates: Private[];
  /** First corridor label. */
  corridor0: number;
  opts: SubdivisionOptions;
}

const cellsFor = (g: Grid, m: number) => Math.max(1, Math.ceil(m / g.cell - 1e-9));

const isWet = (k: PrivateKind) => k === "bathroom" || k === "wc";

/** Lowest scale applied to the facade minimums when a tight apartment relaxes its rules. */
const FACADE_RELAX_FLOOR = 0.85;

function deriveParams(g: Grid, opts: SubdivisionOptions, relax: number): Params {
  const area = g.insideCells * g.cell * g.cell;
  const clamp = (v: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, v));
  const prog = opts.program;
  const shrink = relax < 1 ? relax : 1;
  // Daylight is not traded away like sizes: facade minimums scale down at most
  // to FACADE_RELAX_FLOOR, so a tight, deep plan does not get slit windows.
  const facadeRelax = Math.max(relax, FACADE_RELAX_FLOOR);

  const sizeOf = (kind: PrivateKind, first: boolean): SizedRoom =>
    kind === "bedroom" ? (first ? "mainBedroom" : "bedroom") : kind;
  // The size rules are minimums: a room is never planned smaller or narrower,
  // except that a tight apartment scales them like the other minimums.
  const specFor = (kind: PrivateKind, target: number, first: boolean): RoomSpec => {
    const rule = opts.roomSizes[sizeOf(kind, first)];
    const base = ((): RoomSpec => {
      switch (kind) {
        case "bedroom":
          return {
            minSide: 0, // from the size rules
            maxSide: 5.5,
            minArea: 0.8 * target,
            maxArea: 1.25 * target,
            maxAspect: opts.maxBedroomAspect,
            minFacade: opts.minBedroomFacade * facadeRelax,
          };
        case "bathroom":
          return {
            minSide: first ? 1.5 : 1.4,
            maxSide: 3.0,
            minArea: Math.max(first ? 3 : 2.6, 0.8 * target),
            maxArea: 1.4 * target,
            maxAspect: opts.maxBathroomAspect,
            minFacade: 0,
          };
        case "wc":
          return { minSide: 1.0, maxSide: 2.2, minArea: 0.75 * target, maxArea: 1.5 * target, maxAspect: 2.5, minFacade: 0 };
        case "kitchen":
          return {
            minSide: 2.0 * relax,
            maxSide: 4.5,
            minArea: 0.8 * target,
            maxArea: 1.4 * target,
            maxAspect: 2.2,
            minFacade: opts.minKitchenFacade * facadeRelax,
          };
        case "storage":
          return { minSide: 1.0, maxSide: 2.5, minArea: 0.6 * target, maxArea: 1.5 * target, maxAspect: 2.5, minFacade: 0 };
      }
    })();
    const minSide = rule.minWidth * relax;
    const minArea = Math.max(base.minArea, rule.minArea * relax);
    return {
      ...base,
      minSide,
      maxSide: Math.max(base.maxSide, minSide),
      minArea,
      maxArea: Math.max(base.maxArea, 1.3 * minArea),
    };
  };

  const privates: Private[] = [];
  let group = 0;
  const add = (kind: PrivateKind, count: number, targetOf: (i: number) => number) => {
    let lastTarget = NaN;
    for (let i = 0; i < count; i++) {
      const target = Math.max(targetOf(i), opts.roomSizes[sizeOf(kind, i === 0)].minArea * relax);
      if (target !== lastTarget) group++;
      lastTarget = target;
      privates.push({
        kind,
        label: PRIVATE0 + privates.length,
        id: count > 1 ? `${kind}-${i + 1}` : kind,
        target,
        spec: specFor(kind, target, i === 0),
        group,
        size: sizeOf(kind, i === 0),
      });
    }
  };
  // The hardest rooms first: they narrow the search most.
  add("bedroom", prog.bedrooms, (i) =>
    (i === 0 ? clamp(opts.bedroomShare * area, opts.bedroomAreaRange) : opts.secondBedroomArea) * shrink,
  );
  add("kitchen", prog.kitchen === "separate" ? 1 : 0, () => opts.kitchenArea);
  add("bathroom", prog.bathrooms, (i) =>
    i === 0 ? clamp(opts.bathroomShare * area, opts.bathroomAreaRange) : opts.secondBathroomArea,
  );
  add("wc", prog.wc, () => opts.wcArea);
  add("storage", prog.storage, () => opts.storageArea);

  // The living room is what the private rooms leave: at least 30 % of the
  // apartment, unless the programme cannot leave that much.
  const claimed = privates.reduce((s, p) => s + p.target, 0);
  const minLivingArea = Math.max(
    Math.min(0.3 * area, Math.max(12, area - 1.15 * claimed - 0.06 * area)),
    opts.roomSizes.living.minArea,
  ) * relax;

  return {
    kLiving: cellsFor(g, opts.roomSizes.living.minWidth * relax),
    // Corridors narrower than this are merged into a neighbouring room.
    kCorridor: cellsFor(g, opts.roomSizes.corridor.minWidth),
    doorCells: cellsFor(g, opts.doorWidth),
    minCorridorCells: Math.ceil(opts.minCorridorArea / (g.cell * g.cell)),
    minLivingFacade: opts.minLivingFacade * facadeRelax,
    minLivingArea,
    privates,
    corridor0: PRIVATE0 + privates.length,
    opts,
  };
}

/**
 * A room candidate: the cells of a bounding box that lie inside the apartment.
 * On a rectangular outline that is a plain rectangle; against a slanted wall
 * or around a notch it is the rectangle cut by the outline, so the room takes
 * the outline's shape instead of leaving a gap.
 */
interface Rect {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Inside cells within the box. */
  cells: number;
  /** Cell sides on the facade / on any outer wall. */
  fac: number;
  wall: number;
  cost: number;
}

interface RoomSpec {
  minSide: number;
  maxSide: number;
  minArea: number;
  maxArea: number;
  maxAspect: number;
  minFacade: number;
}

/** Box clamped to the grid and shrunk until every side touches an inside cell. */
function fitRect(g: Grid, x0: number, y0: number, x1: number, y1: number): Rect | null {
  const W = g.nx + 1;
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(g.nx, x1);
  y1 = Math.min(g.ny, y1);
  const inside = (a: number, b: number, c: number, d: number) => rectSum(g.satIn, W, a, b, c, d);
  while (x0 < x1 && y0 < y1 && inside(x0, y0, x0 + 1, y1) === 0) x0++;
  while (x0 < x1 && y0 < y1 && inside(x1 - 1, y0, x1, y1) === 0) x1--;
  while (x0 < x1 && y0 < y1 && inside(x0, y0, x1, y0 + 1) === 0) y0++;
  while (x0 < x1 && y0 < y1 && inside(x0, y1 - 1, x1, y1) === 0) y1--;
  if (x0 >= x1 || y0 >= y1) return null;
  return {
    x0,
    y0,
    w: x1 - x0,
    h: y1 - y0,
    cells: inside(x0, y0, x1, y1),
    fac: rectSum(g.satFac, W, x0, y0, x1, y1),
    wall: rectSum(g.satWall, W, x0, y0, x1, y1),
    cost: 0,
  };
}

/** Size, proportion, facade and clearance rules for one candidate. */
function rectValid(g: Grid, s: RoomSpec, r: Rect): boolean {
  const c = g.cell;
  const lo = Math.min(r.w, r.h);
  const hi = Math.max(r.w, r.h);
  if (lo * c < s.minSide - 1e-9 || hi * c > s.maxSide + 1e-9) return false;
  if (hi / lo > s.maxAspect + 1e-9) return false;
  if (r.cells < 0.7 * r.w * r.h) return false;
  const a = r.cells * c * c;
  if (a < s.minArea - 1e-9 || a > s.maxArea + 1e-9) return false;
  if (r.fac * c < s.minFacade - 1e-9) return false;
  return rectSum(g.satClear, g.nx + 1, r.x0, r.y0, r.x0 + r.w, r.y0 + r.h) === 0;
}

/** For boxes cut by the outline: the piece must be one room, not a tapering leftover. */
function shapeOk(g: Grid, s: RoomSpec, r: Rect): boolean {
  if (r.cells === r.w * r.h) return true;
  const mask = new Uint8Array(g.nx * g.ny);
  for (let y = r.y0; y < r.y0 + r.h; y++) {
    for (let x = r.x0; x < r.x0 + r.w; x++) {
      if (g.base[y * g.nx + x] !== OUT) mask[y * g.nx + x] = 1;
    }
  }
  if (components(g, mask).length !== 1) return false;
  const usable = opening(g, mask, cellsFor(g, s.minSide));
  let covered = 0;
  for (let i = 0; i < usable.length; i++) covered += usable[i];
  return covered >= 0.85 * r.cells;
}

function enumerateRects(g: Grid, s: RoomSpec, cost: (r: Rect) => number): Rect[] {
  const { nx, ny, cell } = g;
  const W = nx + 1;
  const lo = cellsFor(g, s.minSide);
  const hi = Math.floor(s.maxSide / cell + 1e-9);
  const inside = (a: number, b: number, c: number, d: number) => rectSum(g.satIn, W, a, b, c, d);
  const out: Rect[] = [];
  for (let w = lo; w <= hi; w++) {
    for (let h = lo; h <= hi; h++) {
      if (w * h * cell * cell < s.minArea - 1e-9) continue;
      if (Math.max(w, h) / Math.min(w, h) > s.maxAspect + 1e-9) continue;
      for (let y0 = 0; y0 + h <= ny; y0++) {
        for (let x0 = 0; x0 + w <= nx; x0++) {
          const x1 = x0 + w;
          const y1 = y0 + h;
          const cells = inside(x0, y0, x1, y1);
          if (cells < 0.7 * w * h) continue;
          if (
            cells < w * h &&
            (inside(x0, y0, x0 + 1, y1) === 0 ||
              inside(x1 - 1, y0, x1, y1) === 0 ||
              inside(x0, y0, x1, y0 + 1) === 0 ||
              inside(x0, y1 - 1, x1, y1) === 0)
          ) {
            continue; // not a tight box: the same room is listed under a smaller one
          }
          const r: Rect = {
            x0,
            y0,
            w,
            h,
            cells,
            fac: rectSum(g.satFac, W, x0, y0, x1, y1),
            wall: rectSum(g.satWall, W, x0, y0, x1, y1),
            cost: 0,
          };
          if (!rectValid(g, s, r)) continue;
          r.cost = cost(r);
          out.push(r);
        }
      }
    }
  }
  return out.sort((a, b) => a.cost - b.cost);
}

function rectIoU(a: Rect, b: Rect): number {
  const ix = Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0);
  const iy = Math.min(a.y0 + a.h, b.y0 + b.h) - Math.max(a.y0, b.y0);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Best-first pick that skips near-duplicates, so the shortlist covers different places. */
function diverseTop(sorted: Rect[], k: number, maxIoU: number, ok: (r: Rect) => boolean): Rect[] {
  const picked: Rect[] = [];
  for (const r of sorted) {
    if (picked.every((q) => rectIoU(q, r) <= maxIoU) && ok(r)) {
      picked.push(r);
      if (picked.length >= k) break;
    }
  }
  return picked;
}

function rectCentre(g: Grid, r: Rect): Pt {
  return { x: g.ox + (r.x0 + r.w / 2) * g.cell, y: g.oy + (r.y0 + r.h / 2) * g.cell };
}

/** Shortlist of places for one private room, best first. */
function privateCandidates(g: Grid, p: Params, pr: Private): Rect[] {
  const t = pr.target;
  const spec = pr.spec;
  const cost = (r: Rect): number => {
    const perim = 2 * (r.w + r.h);
    const a = r.cells * g.cell * g.cell;
    const c = rectCentre(g, r);
    const aspect = Math.max(r.w, r.h) / Math.min(r.w, r.h) - 1;
    switch (pr.kind) {
      case "bathroom":
      case "wc":
        return (
          2 * (Math.abs(a - t) / t) +
          3 * (r.fac / perim) - // do not spend facade on a wet room
          1.5 * (r.wall / perim) + // tuck it against existing walls
          1.5 * (dist(c, g.entrance) / g.diag) +
          (g.stack ? 3 * (dist(c, g.stack) / g.diag) : 0)
        );
      case "storage":
        return 2 * (Math.abs(a - t) / t) + 3 * (r.fac / perim) - 1.5 * (r.wall / perim);
      case "bedroom":
        return 2 * (Math.abs(a - t) / t) - 1.5 * (r.wall / perim) + 0.3 * aspect;
      case "kitchen":
        return 2 * (Math.abs(a - t) / t) - 1.0 * (r.wall / perim) + 0.3 * aspect + 1.0 * (dist(c, g.entrance) / g.diag);
    }
  };
  const all = enumerateRects(g, spec, cost);
  const wide = pr.kind === "bedroom" || pr.kind === "kitchen";
  return diverseTop(
    all,
    wide ? p.opts.bedroomCandidates : p.opts.bathroomCandidates,
    wide ? 0.7 : 0.6,
    (r) => shapeOk(g, spec, r),
  );
}

// ---------------------------------------------------------------- evaluation

/** Longest straight stretch of wall shared by two rooms. */
interface Run {
  a: number;
  b: number;
  len: number;
  vertical: boolean;
  /** Grid line the wall sits on, and the cell span along it [s, e). */
  line: number;
  s: number;
  e: number;
}

interface DoorLink {
  kind: "door" | "opening";
  run: Run;
}

interface Evaluated {
  cost: number;
  /** Only when asked for. */
  checks?: RuleCheck[];
  lab: Int16Array;
  labelCount: number;
  links: DoorLink[];
  /** One per private room, in the order of Params.privates. */
  rects: Rect[];
}

function sharedRuns(g: Grid, lab: Int16Array): Map<number, Run> {
  const { nx, ny } = g;
  const best = new Map<number, Run>();
  const keyOf = (i: number, j: number) => {
    const a = lab[i];
    const b = lab[j];
    if (a <= 0 || b <= 0 || a === b) return -1;
    return a < b ? a * KEY + b : b * KEY + a;
  };
  const record = (key: number, vertical: boolean, line: number, s: number, e: number) => {
    const prev = best.get(key);
    if (!prev || e - s > prev.len) {
      best.set(key, { a: Math.floor(key / KEY), b: key % KEY, len: e - s, vertical, line, s, e });
    }
  };
  for (let x = 1; x < nx; x++) {
    let cur = -1;
    let start = 0;
    for (let y = 0; y <= ny; y++) {
      const key = y < ny ? keyOf(y * nx + x - 1, y * nx + x) : -1;
      if (key !== cur) {
        if (cur >= 0) record(cur, true, x, start, y);
        cur = key;
        start = y;
      }
    }
  }
  for (let y = 1; y < ny; y++) {
    let cur = -1;
    let start = 0;
    for (let x = 0; x <= nx; x++) {
      const key = x < nx ? keyOf((y - 1) * nx + x, y * nx + x) : -1;
      if (key !== cur) {
        if (cur >= 0) record(cur, false, y, start, x);
        cur = key;
        start = x;
      }
    }
  }
  return best;
}

/** Weight of a room's area error in the cost. */
const AREA_WEIGHT: Record<PrivateKind, number> = { bedroom: 2.0, bathroom: 1.0, wc: 1.0, kitchen: 1.5, storage: 0.5 };

/**
 * Completes a layout from one candidate per private room, checks every hard
 * rule and returns its cost, or null when a rule is broken.
 */
function evaluate(g: Grid, p: Params, rects: Rect[], withReport = false): Evaluated | null {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (rectIoU(rects[i], rects[j]) > 0) return null;
  }
  const { nx, cell } = g;
  const lab = g.base.slice();
  rects.forEach((r, k) => {
    const v = p.privates[k].label;
    for (let y = r.y0; y < r.y0 + r.h; y++) {
      for (let x = r.x0; x < r.x0 + r.w; x++) {
        if (lab[y * nx + x] === FREE) lab[y * nx + x] = v;
      }
    }
  });

  // Living room: the part of the remainder that is at least the living room's minimum width wide everywhere.
  let living: number[] | null = null;
  for (const comp of components(g, opening(g, maskOf(lab, FREE), p.kLiving))) {
    let fac = 0;
    for (const i of comp) fac += g.facEdges[i];
    if (fac * cell < p.minLivingFacade - 1e-9) continue;
    if (!living || comp.length > living.length) living = comp;
  }
  if (!living) return null;
  for (const i of living) lab[i] = LIVING;

  // Corridors: what is left but still wide enough to walk through.
  let next = p.corridor0;
  let corridorCells = 0;
  for (const comp of components(g, opening(g, maskOf(lab, FREE), p.kCorridor))) {
    if (comp.length < p.minCorridorCells) continue;
    for (const i of comp) lab[i] = next;
    corridorCells += comp.length;
    next++;
  }
  if (next >= KEY) return null;

  // Slivers: too narrow for anything, merged into the room they touch most.
  let sliverCells = 0;
  for (const comp of components(g, maskOf(lab, FREE))) {
    const touch = new Map<number, number>();
    for (const i of comp) {
      const x = i % nx;
      for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, i - nx, i + nx]) {
        if (j < 0 || j >= lab.length) continue;
        const v = lab[j];
        if (v > 0) touch.set(v, (touch.get(v) ?? 0) + 1);
      }
    }
    let target = 0;
    let bestW = 0;
    for (const [v, c] of touch) {
      const w = c * (v === LIVING ? 1.5 : 1);
      if (w > bestW) {
        bestW = w;
        target = v;
      }
    }
    if (target === 0) return null;
    for (const i of comp) lab[i] = target;
    sliverCells += comp.length;
  }

  // A corridor earns its place only if it holds the entrance or is the sole way
  // into a private room. Anything else is just an alcove of the living room.
  let runs = sharedRuns(g, lab);
  const runBetween = (a: number, b: number) => runs.get(a < b ? a * KEY + b : b * KEY + a);
  const fits = (a: number, b: number) => (runBetween(a, b)?.len ?? 0) >= p.doorCells;
  const start = lab[g.entranceIdx];
  const dropped = new Set<number>();
  for (let v = p.corridor0; v < next; v++) {
    const needed = v === start || p.privates.some((pr) => fits(pr.label, v) && !fits(pr.label, LIVING));
    if (!needed && fits(v, LIVING)) dropped.add(v);
  }
  let alcoveCells = 0;
  if (dropped.size > 0) {
    for (let i = 0; i < lab.length; i++) {
      if (dropped.has(lab[i])) {
        lab[i] = LIVING;
        alcoveCells++;
      }
    }
    corridorCells -= alcoveCells;
    runs = sharedRuns(g, lab);
  }

  // Per-room statistics.
  const count = new Int32Array(next);
  const fac = new Int32Array(next);
  const sx = new Float64Array(next);
  const sy = new Float64Array(next);
  let lx0 = Infinity;
  let ly0 = Infinity;
  let lx1 = -Infinity;
  let ly1 = -Infinity;
  for (let i = 0; i < lab.length; i++) {
    const v = lab[i];
    if (v <= 0) continue;
    const x = i % nx;
    const y = (i - x) / nx;
    count[v]++;
    fac[v] += g.facEdges[i];
    sx[v] += x + 0.5;
    sy[v] += y + 0.5;
    if (v === LIVING) {
      lx0 = Math.min(lx0, x);
      ly0 = Math.min(ly0, y);
      lx1 = Math.max(lx1, x + 1);
      ly1 = Math.max(ly1, y + 1);
    }
  }
  const c2 = cell * cell;
  const total = g.insideCells * c2;
  const livA = count[LIVING] * c2;
  if (livA < p.minLivingArea) return null;
  for (const pr of p.privates) {
    if (pr.spec.minFacade > 0 && fac[pr.label] * cell < pr.spec.minFacade - 1e-9) return null;
  }

  // Connectivity. Circulation runs through "public" rooms only (living, corridors);
  // every private room must open onto a public room reachable from the
  // entrance, so nobody crosses a private room to get anywhere.
  const isPublic = (v: number) => v === LIVING || v >= p.corridor0;
  if (!isPublic(start)) return null;
  const reached = new Set<number>([start]);
  const links: DoorLink[] = [];
  const queue = [start];
  while (queue.length) {
    const a = queue.shift()!;
    for (let b = LIVING; b < next; b++) {
      if (!isPublic(b) || reached.has(b) || dropped.has(b)) continue;
      const run = runBetween(a, b);
      if (!run || run.len < p.doorCells) continue;
      reached.add(b);
      links.push({ kind: "opening", run });
      queue.push(b);
    }
  }
  if (!reached.has(LIVING)) return null;
  let corridorFacade = 0;
  for (let v = p.corridor0; v < next; v++) {
    if (dropped.has(v)) continue;
    if (!reached.has(v)) return null;
    corridorFacade += fac[v] * cell;
  }
  // Doors of the private rooms, each onto a public room, chosen by the door
  // rules (opensTo / notOpensTo); among equals the longest shared wall wins.
  const openKitchen = p.opts.program.kitchen !== "separate";
  const rules = p.opts.adjacency.filter((r) => !(openKitchen && (r.a === "kitchen" || r.b === "kitchen")));
  const kindOf = (v: number): RuleRoom =>
    v === LIVING ? "living" : v >= p.corridor0 ? "corridor" : p.privates[v - PRIVATE0].kind;
  const matches = (ref: RuleRoom, v: number) => (ref === "entrance" ? v === start : kindOf(v) === ref);
  const doorInto: number[] = [];
  const doorRuns: Run[] = [];
  const doorBroken: AdjacencyRule[][] = [];
  let doorPenalty = 0;
  for (const pr of p.privates) {
    const own = rules.filter((r) => r.a === pr.kind && (r.rule === "opensTo" || r.rule === "notOpensTo"));
    let best: Run | undefined;
    let bestPen = Infinity;
    let bestPub = 0;
    let bestBroken: AdjacencyRule[] = [];
    for (const pub of reached) {
      const run = runBetween(pr.label, pub);
      if (!run || run.len < p.doorCells) continue;
      let pen = 0;
      let banned = false;
      const broken: AdjacencyRule[] = [];
      for (const r of own) {
        const m = matches(r.b, pub);
        if (r.rule === "opensTo" ? m : !m) continue;
        broken.push(r);
        pen += r.weight;
        if (r.hard) banned = true;
      }
      if (banned) continue;
      if (pen < bestPen - 1e-9 || (pen < bestPen + 1e-9 && run.len > (best?.len ?? 0))) {
        best = run;
        bestPen = pen;
        bestPub = pub;
        bestBroken = broken;
      }
    }
    if (!best) return null;
    doorPenalty += bestPen;
    doorInto.push(bestPub);
    doorRuns.push(best);
    doorBroken.push(bestBroken);
    links.push({ kind: "door", run: best });
  }

  // Walking: from the entrance door through the living room and corridors.
  const walk = walkDistances(g, lab, isPublic, g.entranceIdx);
  const walkToDoor = (k: number): number => {
    const run = doorRuns[k];
    const pub = doorInto[k];
    const mid = Math.min(run.e - 1, Math.floor((run.s + run.e) / 2));
    const cells = run.vertical
      ? [mid * nx + run.line - 1, mid * nx + run.line]
      : [(run.line - 1) * nx + mid, run.line * nx + mid];
    const i = cells.find((c) => lab[c] === pub) ?? cells[0];
    return walk[i] * cell;
  };
  const walks = p.privates.map((_, k) => walkToDoor(k));
  let livingWalk = Infinity;
  for (let i = 0; i < lab.length; i++) if (lab[i] === LIVING) livingWalk = Math.min(livingWalk, walk[i] * cell);
  const circ = p.opts.circulation;

  // Soft criteria.
  const centre = (v: number): Pt => ({
    x: g.ox + (sx[v] / count[v]) * cell,
    y: g.oy + (sy[v] / count[v]) * cell,
  });
  const livBox = (lx1 - lx0) * (ly1 - ly0);
  const livAspect = Math.max(lx1 - lx0, ly1 - ly0) / Math.min(lx1 - lx0, ly1 - ly0);
  const walkSum = walks.reduce((sum, w) => sum + w, 0);
  const overWalk = walks.reduce((sum, w) => sum + Math.max(0, w - circ.maxWalk), 0);
  let cost =
    8.0 * ((corridorCells * c2) / total) + // circulation is wasted area
    0.4 * corridorFacade + // daylight belongs to rooms, not to circulation
    6.0 * ((sliverCells * c2) / total) + // slivers mean awkward room shapes
    3.0 * ((alcoveCells * c2) / total) + // alcoves narrower than the living room proper
    3.0 * (1 - count[LIVING] / livBox) + // living room close to a rectangle
    1.0 * Math.max(0, livAspect - 1.8) +
    0.1 * Math.max(0, cornerCount(g, lab, LIVING) - 2) + // every extra corner is a jog in a wall
    1.5 * Math.max(0, 1 - (fac[LIVING] * cell) / 3.5) +
    doorPenalty + // the door rules
    (walks.length > 0 ? circ.walkWeight * (walkSum / walks.length / g.diag) : 0) + // short walks
    2.0 * (overWalk / circ.maxWalk);
  const bedrooms = p.privates.filter((pr) => pr.kind === "bedroom");
  p.privates.forEach((pr, k) => {
    const v = pr.label;
    const r = rects[k];
    const perim = 2 * (r.w + r.h);
    const a = count[v] * c2;
    cost += AREA_WEIGHT[pr.kind] * (Math.abs(a - pr.target) / pr.target);
    switch (pr.kind) {
      case "bedroom":
        cost +=
          0.15 * Math.max(0, cornerCount(g, lab, v) - 3) +
          4.0 * (Math.max(0, 1.3 * a - livA) / total) + // living is the largest room
          1.0 * Math.max(0, 1 - (fac[v] * cell) / 2.5) +
          (-circ.nightZone * (dist(centre(v), g.entrance) / g.diag)) / bedrooms.length + // night zone away from the door
          -0.5 * (r.wall / perim);
        break;
      case "bathroom":
      case "wc": {
        const c = centre(v);
        cost +=
          3.0 * (fac[v] / perim) + // wet rooms stay off the facade
          1.5 * (dist(c, g.entrance) / g.diag) + // ... and near the entrance
          (g.stack ? 3.0 * (dist(c, g.stack) / g.diag) : 0) +
          -1.0 * (r.wall / perim);
        break;
      }
      case "kitchen":
        cost += 0.15 * Math.max(0, cornerCount(g, lab, v) - 3) + 1.0 * Math.max(0, 1 - (fac[v] * cell) / 1.8);
        break;
      case "storage":
        cost += 2.0 * (fac[v] / perim);
        break;
    }
  });

  // Rules on where rooms lie: near, adjacent, apart.
  const corridors: number[] = [];
  for (let v = p.corridor0; v < next; v++) if (!dropped.has(v) && count[v] > 0) corridors.push(v);
  const labelsOf = (ref: RuleRoom): number[] =>
    ref === "living"
      ? [LIVING]
      : ref === "corridor"
        ? corridors
        : ref === "entrance"
          ? []
          : p.privates.filter((pr) => pr.kind === ref).map((pr) => pr.label);
  const shares = (x: number, y: number) => (runBetween(x, y)?.len ?? 0) > 0;
  const walkTo = (v: number): number => {
    if (v === LIVING) return livingWalk;
    if (v >= p.corridor0) {
      let m = Infinity;
      for (let i = 0; i < lab.length; i++) if (lab[i] === v) m = Math.min(m, walk[i] * cell);
      return m;
    }
    return walks[v - PRIVATE0];
  };
  const placed: { rule: AdjacencyRule; broken: number[] }[] = [];
  for (const rule of rules) {
    if (rule.rule === "opensTo" || rule.rule === "notOpensTo") continue;
    const as = labelsOf(rule.a);
    if (as.length === 0) continue;
    const broken: number[] = [];
    if (rule.b === "entrance") {
      for (const la of as) {
        const d = walkTo(la);
        const far = d > circ.nearDistance;
        if (rule.rule === "apart" ? !far : far) broken.push(la);
        cost += rule.weight * (rule.rule === "apart" ? Math.max(0, 1 - d / g.diag) : d / g.diag);
      }
    } else {
      const bs = labelsOf(rule.b);
      let applies = false;
      for (const la of as) {
        const others = bs.filter((lb) => lb !== la);
        if (others.length === 0) continue;
        applies = true;
        if (rule.rule === "near") {
          let d = Infinity;
          for (const lb of others) d = Math.min(d, shares(la, lb) ? 0 : dist(centre(la), centre(lb)));
          cost += rule.weight * (d / g.diag);
          if (d > circ.nearDistance) broken.push(la);
        } else if (rule.rule === "adjacent") {
          if (!others.some((lb) => shares(la, lb))) {
            broken.push(la);
            cost += rule.weight;
          }
        } else if (others.some((lb) => shares(la, lb))) {
          broken.push(la);
          cost += rule.weight;
        }
      }
      if (!applies) continue;
    }
    if (rule.hard && broken.length > 0) return null;
    placed.push({ rule, broken });
  }

  const ev: Evaluated = { cost, lab, labelCount: next, links, rects };
  if (!withReport) return ev;

  // The report: one line per rule.
  const f = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
  const nameOf = (v: number): string => {
    if (v === LIVING) return "Living room";
    if (v >= p.corridor0) return "Corridor";
    const pr = p.privates[v - PRIVATE0];
    const same = p.privates.filter((q) => q.kind === pr.kind);
    const base = KIND_NAME[pr.kind];
    return same.length > 1 ? `${base} ${same.indexOf(pr) + 1}` : base;
  };
  const checks: RuleCheck[] = [];
  const sizes = p.opts.roomSizes;
  {
    const min = sizes.living;
    const width = p.kLiving * cell;
    checks.push({
      group: "size",
      text: `Living room at least ${f(min.minArea)} m², ${f(min.minWidth)} m wide`,
      ok: livA >= min.minArea - 1e-6 && width >= min.minWidth - 1e-6,
      detail: `${f(livA)} m²${width < min.minWidth - 1e-6 ? `, narrowest part ${f(width)} m` : ""}`,
    });
  }
  p.privates.forEach((pr, k) => {
    const min = sizes[pr.size];
    const a = count[pr.label] * c2;
    const width = Math.min(rects[k].w, rects[k].h) * cell;
    checks.push({
      group: "size",
      text: `${nameOf(pr.label)} at least ${f(min.minArea)} m², ${f(min.minWidth)} m wide`,
      ok: a >= min.minArea - 1e-6 && width >= min.minWidth - 1e-6,
      detail: `${f(a)} m², ${f(width)} m wide`,
    });
  });
  if (corridors.length > 0) {
    checks.push({
      group: "size",
      text: `Corridors at least ${f(sizes.corridor.minWidth)} m wide`,
      ok: p.kCorridor * cell >= sizes.corridor.minWidth - 1e-6,
    });
  }
  for (const rule of rules) {
    if (rule.rule === "opensTo" || rule.rule === "notOpensTo") {
      if (!p.privates.some((pr) => pr.kind === rule.a)) continue;
      const bad = p.privates.filter((_, k) => doorBroken[k].includes(rule)).map((pr) => pr.label);
      checks.push({
        group: "adjacency",
        text: rule.text,
        ok: bad.length === 0,
        detail:
          bad.length === 0
            ? undefined
            : bad.map((v) => `${nameOf(v)} opens into the ${nameOf(doorInto[v - PRIVATE0]).toLowerCase()}`).join("; "),
      });
      continue;
    }
    const hit = placed.find((q) => q.rule === rule);
    if (!hit) continue;
    checks.push({
      group: "adjacency",
      text: rule.text,
      ok: hit.broken.length === 0,
      detail: hit.broken.length === 0 ? undefined : hit.broken.map(nameOf).join(", "),
    });
  }
  if (walks.length > 0) {
    const far = p.privates.map((pr, k) => ({ v: pr.label, w: walks[k] })).sort((x, y) => y.w - x.w)[0];
    checks.push({
      group: "circulation",
      text: `Every room within ${f(circ.maxWalk)} m walk of the entrance`,
      ok: far.w <= circ.maxWalk + 1e-6,
      detail: `farthest: ${nameOf(far.v)}, ${f(far.w)} m`,
    });
  }
  if (bedrooms.length > 0) {
    const shallow = bedrooms.filter((pr) => walks[pr.label - PRIVATE0] < livingWalk - 1e-6).map((pr) => pr.label);
    checks.push({
      group: "circulation",
      text: "Bedrooms deeper in the plan than the living room (night zone)",
      ok: shallow.length === 0,
      detail: shallow.length === 0 ? undefined : shallow.map(nameOf).join(", "),
    });
  }
  const share = (corridorCells * c2) / total;
  checks.push({
    group: "circulation",
    text: `Corridors take at most ${Math.round(circ.maxCorridorShare * 100)} % of the apartment`,
    ok: share <= circ.maxCorridorShare + 1e-6,
    detail: `${Math.round(share * 100)} %`,
  });
  return { ...ev, checks };
}

const KIND_NAME: Record<PrivateKind, string> = {
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  wc: "WC",
  kitchen: "Kitchen",
  storage: "Storage",
};

/**
 * Walking distance from one cell through the cells whose label passes
 * `walkable`, with diagonal steps (no cutting corners). In cells; Infinity
 * where it cannot be reached. Steps count 2 straight and 3 diagonally, so the
 * result is a close and cheap estimate of the true walk.
 */
function walkDistances(g: Grid, lab: Int16Array, walkable: (v: number) => boolean, from: number): Float64Array {
  const { nx, ny } = g;
  const n = lab.length;
  const INF = 0x3fffffff;
  const d = new Int32Array(n).fill(INF);
  const buckets: number[][] = [];
  d[from] = 0;
  buckets[0] = [from];
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && walkable(lab[y * nx + x]);
  for (let c = 0; c < buckets.length; c++) {
    const bucket = buckets[c];
    if (!bucket) continue;
    for (const i of bucket) {
      if (d[i] !== c) continue;
      const x = i % nx;
      const y = (i - x) / nx;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!ok(x + dx, y + dy)) continue;
          if (dx !== 0 && dy !== 0 && (!ok(x + dx, y) || !ok(x, y + dy))) continue;
          const j = (y + dy) * nx + x + dx;
          const nd = c + (dx !== 0 && dy !== 0 ? 3 : 2);
          if (nd < d[j]) {
            d[j] = nd;
            (buckets[nd] ??= []).push(j);
          }
        }
      }
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = d[i] === INF ? Infinity : d[i] / 2;
  return out;
}

/** Partial layouts kept between steps of the beam search, and how many complete ones are scored. */
const BEAM = 600;
const FINAL_BEAM = 3200;

function search(g: Grid, p: Params, count: number): Evaluated[] {
  const lists = new Map<number, Rect[]>();
  for (const pr of p.privates) {
    if (!lists.has(pr.group)) lists.set(pr.group, privateCandidates(g, p, pr));
  }

  // Beam search: the private rooms are placed one at a time, each from its
  // shortlist, keeping the cheapest combinations. With two rooms the beam
  // holds every combination, so nothing is lost. Rooms of one group take
  // their candidates in list order, so the same set is not tried twice.
  interface State {
    rects: Rect[];
    idx: number[];
    cost: number;
  }
  let states: State[] = [{ rects: [], idx: [], cost: 0 }];
  p.privates.forEach((pr, k) => {
    const list = lists.get(pr.group)!;
    const sameAsPrev = k > 0 && p.privates[k - 1].group === pr.group;
    const next: State[] = [];
    for (const s of states) {
      for (let j = sameAsPrev ? s.idx[k - 1] + 1 : 0; j < list.length; j++) {
        const r = list[j];
        if (s.rects.some((q) => rectIoU(q, r) > 0)) continue;
        next.push({ rects: [...s.rects, r], idx: [...s.idx, j], cost: s.cost + r.cost });
      }
    }
    next.sort((a, b) => a.cost - b.cost);
    const cap = k === p.privates.length - 1 ? FINAL_BEAM : BEAM;
    states = next.length > cap ? next.slice(0, cap) : next;
  });

  const scored: { cost: number; rects: Rect[] }[] = [];
  for (const s of states) {
    const ev = evaluate(g, p, s.rects);
    if (ev) scored.push({ cost: ev.cost, rects: s.rects });
  }
  scored.sort((a, b) => a.cost - b.cost);
  const picked: typeof scored = [];
  for (const s of scored) {
    if (picked.length >= count) break;
    const distinct = picked.every((q) => q.rects.length === 0 || q.rects.some((r, k) => rectIoU(r, s.rects[k]) < 0.6));
    if (distinct) picked.push(s);
  }
  return picked.map((s) => evaluate(g, p, s.rects)!);
}

// ---------------------------------------------------------------- refinement

/**
 * Re-evaluates a coarse layout on the fine grid, then moves one wall of one
 * private room at a time, keeping every move that lowers the cost. This takes
 * wall positions off the coarse search module.
 */
function refine(g: Grid, p: Params, coarse: Evaluated, ratio: number): Evaluated | null {
  const up = (r: Rect) =>
    fitRect(
      g,
      (r.x0 - PAD) * ratio + PAD,
      (r.y0 - PAD) * ratio + PAD,
      (r.x0 + r.w - PAD) * ratio + PAD,
      (r.y0 + r.h - PAD) * ratio + PAD,
    );
  const start: Rect[] = [];
  for (const r of coarse.rects) {
    const fine = up(r);
    if (!fine) return null;
    start.push(fine);
  }
  let cur = evaluate(g, p, start);
  if (!cur) return null;

  const moves: [number, number, number, number][] = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (const step of [4, 2, 1]) {
    let improved = true;
    for (let sweep = 0; improved && sweep < 12; sweep++) {
      improved = false;
      for (let k = 0; k < p.privates.length; k++) {
        const spec = p.privates[k].spec;
        for (const [a, b, c, d] of moves) {
          for (const dir of [-step, step]) {
            const r: Rect = cur.rects[k];
            const moved = fitRect(
              g,
              r.x0 + a * dir,
              r.y0 + b * dir,
              r.x0 + r.w + c * dir,
              r.y0 + r.h + d * dir,
            );
            if (!moved) continue;
            if (moved.x0 === r.x0 && moved.y0 === r.y0 && moved.w === r.w && moved.h === r.h) continue;
            if (!rectValid(g, spec, moved) || !shapeOk(g, spec, moved)) continue;
            const rects = cur.rects.slice();
            rects[k] = moved;
            const ev: Evaluated | null = evaluate(g, p, rects);
            if (ev && ev.cost < cur.cost - 1e-6) {
              cur = ev;
              improved = true;
            }
          }
        }
      }
    }
  }
  return cur;
}

// ------------------------------------------------------------------- kitchen

type Box = [number, number, number, number];

interface KitchenPlacement {
  zone: Box;
  counter: Box;
}

/**
 * Open-plan kitchen: a counter run plus its working aisle, inside the living
 * room, backed along its full length by a solid wall, clear of every door,
 * preferably sharing the bathroom's wet wall and leaving the facade free.
 * Boxes are in grid lines (x0, y0, x1, y1).
 */
function placeKitchen(g: Grid, p: Params, lab: Int16Array, doorPts: Pt[]): KitchenPlacement | null {
  const { nx, ny, cell } = g;
  const W = nx + 1;
  const n = nx * ny;
  const living = new Uint8Array(n);
  const solid = new Uint8Array(n);
  const bath = new Uint8Array(n);
  const block = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = lab[i];
    if (v === LIVING) living[i] = 1;
    if (v === OUT || (v >= PRIVATE0 && v < p.corridor0)) solid[i] = 1;
    if (v >= PRIVATE0 && v < p.corridor0 && isWet(p.privates[v - PRIVATE0].kind)) bath[i] = 1;
    if (g.clear[i]) block[i] = 1;
  }
  const reach = Math.ceil(1.0 / cell);
  for (const d of doorPts) {
    const cx = Math.floor((d.x - g.ox) / cell);
    const cy = Math.floor((d.y - g.oy) / cell);
    for (let y = Math.max(0, cy - reach); y <= Math.min(ny - 1, cy + reach); y++) {
      for (let x = Math.max(0, cx - reach); x <= Math.min(nx - 1, cx + reach); x++) {
        if (Math.hypot(g.ox + (x + 0.5) * cell - d.x, g.oy + (y + 0.5) * cell - d.y) <= 1.0) {
          block[y * nx + x] = 1;
        }
      }
    }
  }
  const sLiving = buildSat(nx, ny, living);
  const sSolid = buildSat(nx, ny, solid);
  const sBath = buildSat(nx, ny, bath);
  const sBlock = buildSat(nx, ny, block);

  const depth = cellsFor(g, p.opts.kitchenDepth);
  const counter = Math.max(1, Math.round(p.opts.kitchenCounterDepth / cell));
  const lenMin = cellsFor(g, p.opts.kitchenLength[0]);
  const lenMax = Math.floor(p.opts.kitchenLength[1] / cell + 1e-9);
  const lenStep = Math.max(1, Math.round(0.2 / cell));

  let best: KitchenPlacement | null = null;
  let bestScore = -Infinity;
  for (let len = lenMin; len <= lenMax; len += lenStep) {
    for (const horizontal of [true, false]) {
      const w = horizontal ? len : depth;
      const h = horizontal ? depth : len;
      // The PAD margin guarantees a row/column of cells on every side.
      for (let y0 = 1; y0 + h < ny; y0++) {
        for (let x0 = 1; x0 + w < nx; x0++) {
          const x1 = x0 + w;
          const y1 = y0 + h;
          if (rectSum(sLiving, W, x0, y0, x1, y1) !== w * h) continue;
          if (rectSum(sBlock, W, x0, y0, x1, y1) !== 0) continue;
          const fac = rectSum(g.satFac, W, x0, y0, x1, y1);
          // The two long sides are the possible backing walls.
          const backs: { strip: Box; counter: Box }[] = horizontal
            ? [
                { strip: [x0, y0 - 1, x1, y0], counter: [x0, y0, x1, y0 + counter] },
                { strip: [x0, y1, x1, y1 + 1], counter: [x0, y1 - counter, x1, y1] },
              ]
            : [
                { strip: [x0 - 1, y0, x0, y1], counter: [x0, y0, x0 + counter, y1] },
                { strip: [x1, y0, x1 + 1, y1], counter: [x1 - counter, y0, x1, y1] },
              ];
          for (const back of backs) {
            const [bx0, by0, bx1, by1] = back.strip;
            if (rectSum(sSolid, W, bx0, by0, bx1, by1) !== len) continue;
            const wet = rectSum(sBath, W, bx0, by0, bx1, by1) / len;
            const ends = horizontal
              ? rectSum(sSolid, W, x0 - 1, y0, x0, y1) + rectSum(sSolid, W, x1, y0, x1 + 1, y1)
              : rectSum(sSolid, W, x0, y0 - 1, x1, y0) + rectSum(sSolid, W, x0, y1, x1, y1 + 1);
            const c: Pt = { x: g.ox + ((x0 + x1) / 2) * cell, y: g.oy + ((y0 + y1) / 2) * cell };
            const score =
              0.3 * len * cell +
              1.5 * wet + // shared wet wall with the bathroom
              0.5 * (ends / (2 * depth)) + // tucked into a corner
              -2.0 * (fac / (2 * (w + h))) + // keep the windows for the sitting area
              (g.stack ? -1.0 * (dist(c, g.stack) / g.diag) : 0);
            if (score > bestScore) {
              bestScore = score;
              best = { zone: [x0, y0, x1, y1], counter: back.counter };
            }
          }
        }
      }
    }
  }
  return best;
}

// ------------------------------------------------------------- vectorisation

function roomId(p: Params, label: number): string {
  if (label === LIVING) return "living";
  if (label < p.corridor0) return p.privates[label - PRIVATE0].id;
  return `corridor-${label - p.corridor0 + 1}`;
}

function roomType(p: Params, label: number): RoomType {
  if (label === LIVING) return "living";
  if (label < p.corridor0) return p.privates[label - PRIVATE0].kind;
  return "corridor";
}

/** Covers one label with a few rectangles: horizontal runs, merged down while they repeat. */
function labelRects(g: Grid, lab: Int16Array, label: number): Box[] {
  const { nx, ny } = g;
  const done: Box[] = [];
  let active = new Map<number, Box>();
  for (let y = 0; y < ny; y++) {
    const nextActive = new Map<number, Box>();
    let x = 0;
    while (x < nx) {
      if (lab[y * nx + x] !== label) {
        x++;
        continue;
      }
      const s = x;
      while (x < nx && lab[y * nx + x] === label) x++;
      const key = s * 65536 + x;
      const prev = active.get(key);
      if (prev) {
        prev[3] = y + 1;
        nextActive.set(key, prev);
        active.delete(key);
      } else {
        nextActive.set(key, [s, y, x, y + 1]);
      }
    }
    done.push(...active.values());
    active = nextActive;
  }
  done.push(...active.values());
  return done;
}

function toLayout(
  g: Grid,
  p: Params,
  ev: Evaluated,
  input: ApartmentInput,
  relax: number,
): Layout {
  const { nx, ny, cell, ox, oy, cos, sin } = g;
  const toWorld = (x: number, y: number): Pt => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const ringToWorld = (r: Ring) => cleanRing(r).map(([x, y]) => toWorld(x, y));
  const thickness = p.opts.wallThickness;

  // Grow rooms two cells outward so they overshoot the true outline, then clip.
  // This closes the staircase gap along walls that are not grid-aligned.
  let lab = ev.lab;
  for (let pass = 0; pass < 2; pass++) {
    const grown = lab.slice();
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (lab[i] !== OUT) continue;
        let pick = OUT;
        for (const [dx, dy] of [
          [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
        ]) {
          const qx = x + dx;
          const qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
          const v = lab[qy * nx + qx];
          if (v > 0) {
            pick = v;
            break;
          }
        }
        grown[i] = pick;
      }
    }
    lab = grown;
  }

  const outline: Ring = g.localPoly.map((q) => [snap(q.x), snap(q.y)]);
  outline.push(outline[0]);

  // Gross shape of each room on the wall centrelines, and the same shape
  // fattened by half a wall, which is what its neighbours must stay clear of.
  const labels: number[] = [];
  const gross = new Map<number, MultiPoly>();
  const fat = new Map<number, MultiPoly>();
  for (let label = LIVING; label < ev.labelCount; label++) {
    const rects = labelRects(g, lab, label);
    if (rects.length === 0) continue;
    const polys = (grow: number) =>
      rects.map(([x0, y0, x1, y1]) =>
        rectPoly(ox + x0 * cell - grow, oy + y0 * cell - grow, ox + x1 * cell + grow, oy + y1 * cell + grow),
      );
    labels.push(label);
    gross.set(label, intersection(unionAll(polys(0)), [outline]) as MultiPoly);
    if (thickness > 0) fat.set(label, unionAll(polys(thickness / 2)));
  }

  const net = new Map<number, Poly>();
  const rooms: Room[] = [];
  for (const label of labels) {
    let shape = gross.get(label)!;
    const others = labels.filter((l) => l !== label).map((l) => fat.get(l)!);
    if (thickness > 0 && others.length > 0) {
      shape = difference(shape, ...others) as MultiPoly;
    }
    const main = largest(shape);
    if (!main) continue;
    net.set(label, main);
    let facCells = 0;
    for (let i = 0; i < ev.lab.length; i++) if (ev.lab[i] === label) facCells += g.facEdges[i];
    rooms.push({
      id: roomId(p, label),
      type: roomType(p, label),
      polygon: ringToWorld(main[0]),
      holes: main.slice(1).map(ringToWorld),
      area: polyArea(main),
      facadeLength: facCells * cell,
    });
  }

  // Doors sit near the end of the shared wall that is closer to the entrance;
  // openings to a corridor take the whole shared stretch.
  const doorWidth = p.opts.doorWidth;
  const doors: Door[] = [
    {
      kind: "entrance",
      rooms: [roomId(p, ev.lab[g.entranceIdx])],
      position: input.entrance,
      width: doorWidth,
    },
  ];
  const doorPts: Pt[] = [];
  const gaps: Poly[] = [];
  for (const { kind, run } of ev.links) {
    const lo = run.s * cell;
    const hi = run.e * cell;
    const at = (t: number): Pt =>
      run.vertical
        ? { x: ox + run.line * cell, y: oy + t }
        : { x: ox + t, y: oy + run.line * cell };
    let along: number;
    let width: number;
    if (kind === "opening") {
      along = (lo + hi) / 2;
      width = hi - lo - thickness;
    } else {
      const inset = doorWidth / 2 + 0.1 + thickness / 2;
      const options = hi - lo >= 2 * inset ? [lo + inset, hi - inset] : [(lo + hi) / 2];
      along = options[0];
      for (const t of options) if (dist(at(t), g.entrance) < dist(at(along), g.entrance)) along = t;
      width = doorWidth;
    }
    const pos = at(along);
    doorPts.push(pos);
    if (thickness > 0) {
      const a = width / 2;
      const b = thickness / 2 + 0.01;
      gaps.push(
        run.vertical
          ? rectPoly(pos.x - b, pos.y - a, pos.x + b, pos.y + a)
          : rectPoly(pos.x - a, pos.y - b, pos.x + a, pos.y + b),
      );
    }
    doors.push({
      kind,
      rooms: [roomId(p, run.a), roomId(p, run.b)],
      position: toWorld(pos.x, pos.y),
      width,
    });
  }

  // Partitions: whatever the net rooms leave of the outline, minus the door gaps.
  const walls: WallPolygon[] = [];
  if (thickness > 0 && net.size > 0) {
    const solid = difference([outline], ...net.values(), ...gaps) as MultiPoly;
    for (const poly of solid) {
      if (polyArea(poly) < 1e-4) continue;
      walls.push({ polygon: ringToWorld(poly[0]), holes: poly.slice(1).map(ringToWorld) });
    }
  }

  const zones: Zone[] = [];
  const livingNet = net.get(LIVING);
  if (p.opts.kitchen && p.opts.program.kitchen === "open" && livingNet) {
    const placed = placeKitchen(g, p, ev.lab, [...doorPts, g.entrance]);
    if (placed) {
      const cut = ([x0, y0, x1, y1]: Box) =>
        largest(
          intersection(
            rectPoly(ox + x0 * cell, oy + y0 * cell, ox + x1 * cell, oy + y1 * cell),
            livingNet,
          ) as MultiPoly,
        );
      const zone = cut(placed.zone);
      const counter = cut(placed.counter);
      if (zone && counter) {
        zones.push({
          type: "kitchen",
          room: "living",
          polygon: ringToWorld(zone[0]),
          counter: ringToWorld(counter[0]),
          area: polyArea(zone),
        });
      }
    }
  }

  const checks = evaluate(g, p, ev.rects, true)?.checks ?? [];
  return { rooms, doors, zones, walls, cost: ev.cost, relaxation: relax, checks };
}
