/**
 * Dimensions of a storey plan.
 *
 * Three kinds: chains around the building (openings, rooms, overall length on
 * each of its four sides), the clear width and length of every room, and
 * dimensions placed by hand. The first two are worked out from the walls every
 * time, so they always follow the plan; only the hand-placed ones are stored.
 *
 * Pure functions, no UI imports. How dimensions look comes from a config
 * (src/config/dimensionStyle.json). Coordinates are the model's: metres, y down.
 */
import { type Entity, wallRegion } from "./drawing.ts";
import { type Pt, dist, pointInPolygon } from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Annotations, Dimension, Storey } from "./model.ts";
import { openingGeometry, openingSides } from "./openings.ts";
import { type LinkedSpaces, linkSpaces } from "./spaces.ts";

export type DimensionUnit = "mm" | "cm" | "m";

export interface DimensionStyle {
  unit: DimensionUnit;
  decimals: number;
  measureTo: "faces" | "centrelines";
  /** On screen the plan is treated as if drawn at 1:screenScale. */
  screenScale: number;
  textHeightMm: number;
  firstChainMm: number;
  chainSpacingMm: number;
  tickMm: number;
  extensionMm: number;
  textGapMm: number;
  roomInsetMm: number;
}

const UNIT_FACTOR: Record<DimensionUnit, number> = { mm: 1000, cm: 100, m: 1 };

/** Checks a config loaded from JSON; throws with the offending key. */
export function parseDimensionStyle(raw: unknown): DimensionStyle {
  const c = raw as DimensionStyle;
  const fail = (key: string): never => {
    throw new Error(`Dimension style: invalid or missing "${key}".`);
  };
  if (!c || typeof c !== "object") fail("(root)");
  if (!(c.unit in UNIT_FACTOR)) fail("unit");
  if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 4) fail("decimals");
  if (c.measureTo !== "faces" && c.measureTo !== "centrelines") fail("measureTo");
  const sizes = [
    "screenScale",
    "textHeightMm",
    "firstChainMm",
    "chainSpacingMm",
    "tickMm",
    "extensionMm",
    "textGapMm",
    "roomInsetMm",
  ] as const;
  for (const key of sizes) {
    if (typeof c[key] !== "number" || !Number.isFinite(c[key]) || c[key] <= 0) fail(key);
  }
  return {
    unit: c.unit,
    decimals: c.decimals,
    measureTo: c.measureTo,
    screenScale: c.screenScale,
    textHeightMm: c.textHeightMm,
    firstChainMm: c.firstChainMm,
    chainSpacingMm: c.chainSpacingMm,
    tickMm: c.tickMm,
    extensionMm: c.extensionMm,
    textGapMm: c.textGapMm,
    roomInsetMm: c.roomInsetMm,
  };
}

/**
 * A length in metres as it is written on a dimension. A value that is not
 * whole at the configured decimals gets one more, so a 12.5 cm wall is not
 * written as 13.
 */
export function formatDimension(metres: number, style: Pick<DimensionStyle, "unit" | "decimals">): string {
  const v = metres * UNIT_FACTOR[style.unit];
  const coarse = v.toFixed(style.decimals);
  const fine = v.toFixed(style.decimals + 1);
  return Math.abs(Number(coarse) - Number(fine)) < 1e-9 ? coarse : fine;
}

// -------------------------------------------------------------------- chains

/** One measured stretch. `from` and `to` are on the dimension line. */
export interface DimSpan {
  from: Pt;
  to: Pt;
  /** The length written on it, in metres. */
  value: number;
}

export type DimSide = "top" | "bottom" | "left" | "right";

export interface DimChain {
  kind: "openings" | "rooms" | "overall" | "room" | "own";
  /** For the chains around the building: which side they are on. */
  side?: DimSide;
  /** For a hand-placed dimension: its id. For a room's dimension: the room. */
  id?: string;
  /** Collinear, in order along the line. */
  spans: DimSpan[];
  /** Lines from the measured points to the dimension line (hand-placed dimensions). */
  witness?: [Pt, Pt][];
}

/** Stretches shorter than this are drawing noise, not something to dimension. */
const MIN_SPAN = 1e-3;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The storey to the outside wall faces, openings filled in. */
function buildingBox(storey: Pick<Storey, "walls">): Box | null {
  const pts = wallRegion({ walls: storey.walls, openings: [] }).flat(2);
  if (pts.length === 0) return null;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    box.minX = Math.min(box.minX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

/**
 * How one side of the building is looked at: `along` is the coordinate that
 * runs along the side, `depth` how far into the building a point is from it.
 */
interface SideView {
  side: DimSide;
  along: (p: Pt) => number;
  depth: (p: Pt) => number;
  /** Unit vector pointing away from the building. */
  out: Pt;
  /** Unit vector in which `along` grows. */
  axis: Pt;
  range: [number, number];
  /** The point at `u` along the side and `d` metres out from it. */
  at: (u: number, d: number) => Pt;
}

function sideViews(box: Box): SideView[] {
  return [
    {
      side: "top",
      along: (p) => p.x,
      depth: (p) => p.y - box.minY,
      out: { x: 0, y: -1 },
      axis: { x: 1, y: 0 },
      range: [box.minX, box.maxX],
      at: (u, d) => ({ x: u, y: box.minY - d }),
    },
    {
      side: "bottom",
      along: (p) => p.x,
      depth: (p) => box.maxY - p.y,
      out: { x: 0, y: 1 },
      axis: { x: 1, y: 0 },
      range: [box.minX, box.maxX],
      at: (u, d) => ({ x: u, y: box.maxY + d }),
    },
    {
      side: "left",
      along: (p) => p.y,
      depth: (p) => p.x - box.minX,
      out: { x: -1, y: 0 },
      axis: { x: 0, y: 1 },
      range: [box.minY, box.maxY],
      at: (u, d) => ({ x: box.minX - d, y: u }),
    },
    {
      side: "right",
      along: (p) => p.y,
      depth: (p) => box.maxX - p.x,
      out: { x: 1, y: 0 },
      axis: { x: 0, y: 1 },
      range: [box.minY, box.maxY],
      at: (u, d) => ({ x: box.maxX + d, y: u }),
    },
  ];
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Sorted, without repeats closer than MIN_SPAN. */
function breakpoints(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > MIN_SPAN);
}

/**
 * Where the rooms seen from one side begin and end along it. From each
 * position along the side the nearest room counts, so a room hidden behind
 * another is not measured. With "centrelines" the breaks are the middles of
 * the walls between the rooms instead of the wall faces.
 */
function roomBreaks(
  view: SideView,
  linked: LinkedSpaces,
  measureTo: DimensionStyle["measureTo"],
  thickestWall: number,
): number[] {
  const rooms = linked.topology.faces
    .filter((f) => f.netArea > 0 && f.netOuter.length >= 3)
    .map((f) => {
      const us = f.netOuter.map(view.along);
      return { lo: Math.min(...us), hi: Math.max(...us), depth: Math.min(...f.netOuter.map(view.depth)) };
    });
  if (rooms.length === 0) return [];
  const [u0, u1] = view.range;
  const cuts = breakpoints([u0, u1, ...rooms.flatMap((r) => [r.lo, r.hi]).filter((u) => u > u0 && u < u1)]);
  // Which room, if any, is seen in each stretch between two cuts.
  const seen: number[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const mid = (cuts[i] + cuts[i + 1]) / 2;
    let best = -1;
    rooms.forEach((r, k) => {
      if (r.lo < mid && mid < r.hi && (best < 0 || r.depth < rooms[best].depth)) best = k;
    });
    seen.push(best);
  }
  // A sliver no wider than a wall, between two nearer rooms, is the wall
  // between them and not a glimpse of the room behind it.
  const depthAt = (i: number) => (i < 0 || i >= seen.length || seen[i] < 0 ? -Infinity : rooms[seen[i]].depth);
  const walls = seen.map(
    (k, i) =>
      k >= 0 &&
      cuts[i + 1] - cuts[i] <= thickestWall + 1e-6 &&
      rooms[k].depth > depthAt(i - 1) &&
      rooms[k].depth > depthAt(i + 1),
  );
  walls.forEach((isWall, i) => {
    if (isWall) seen[i] = -1;
  });
  // Merge neighbouring stretches that show the same thing.
  const edges = [cuts[0]];
  const kinds: number[] = [];
  seen.forEach((k, i) => {
    if (i > 0 && k === kinds[kinds.length - 1]) edges[edges.length - 1] = cuts[i + 1];
    else {
      kinds.push(k);
      edges.push(cuts[i + 1]);
    }
  });
  if (measureTo === "faces") return edges;
  // Wall axis to wall axis: the middle of every stretch that shows no room.
  const axes: number[] = [];
  kinds.forEach((k, i) => {
    if (k < 0) axes.push((edges[i] + edges[i + 1]) / 2);
  });
  return axes;
}

/** The jambs, along the side, of the openings in walls that face it. */
function openingBreaks(view: SideView, storey: Storey, linked: LinkedSpaces): number[] {
  const out: number[] = [];
  for (const o of storey.openings) {
    const wall = storey.walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const g = openingGeometry(wall, o);
    // Only walls that run along this side; a slanted wall would be foreshortened.
    if (Math.abs(g.dir.x * view.axis.x + g.dir.y * view.axis.y) < 0.9995) continue;
    const sides = openingSides(storey, o, linked);
    const facing = g.normal.x * view.out.x + g.normal.y * view.out.y > 0 ? sides[0] : sides[1];
    if (facing !== null) continue; // a room is in the way: not an outside wall on this side
    const centre = view.along(g.centre);
    out.push(centre - o.width / 2, centre + o.width / 2);
  }
  return out;
}

const spansAlong = (view: SideView, cuts: number[], d: number): DimSpan[] => {
  const spans: DimSpan[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const value = cuts[i + 1] - cuts[i];
    if (value > MIN_SPAN) spans.push({ from: view.at(cuts[i], d), to: view.at(cuts[i + 1], d), value: round(value) });
  }
  return spans;
};

/**
 * The chains around the building. On each of its four sides, from the wall
 * outward: openings and the wall between them, then rooms and wall
 * thicknesses, then the overall length. A chain with nothing to say (no
 * openings on that side, no rooms) is left out and the others move in.
 * `scale` (100 = 1:100) sets how far apart the chains are in metres.
 */
export function outsideChains(
  storey: Storey,
  style: DimensionStyle,
  scale: number,
  linked: LinkedSpaces = linkSpaces(storey),
): DimChain[] {
  const box = buildingBox(storey);
  if (!box) return [];
  const mm = scale / 1000;
  const thickestWall = Math.max(0, ...storey.walls.map((w) => w.thickness));
  const chains: DimChain[] = [];
  for (const view of sideViews(box)) {
    const [u0, u1] = view.range;
    if (u1 - u0 <= MIN_SPAN) continue;
    const lists: { kind: DimChain["kind"]; cuts: number[] }[] = [];
    const jambs = openingBreaks(view, storey, linked);
    if (jambs.length) lists.push({ kind: "openings", cuts: breakpoints([u0, ...jambs, u1]) });
    const rooms = roomBreaks(view, linked, style.measureTo, thickestWall);
    if (rooms.length > 2) lists.push({ kind: "rooms", cuts: rooms });
    lists.push({ kind: "overall", cuts: [u0, u1] });
    lists.forEach(({ kind, cuts }, i) => {
      const d = (style.firstChainMm + i * style.chainSpacingMm) * mm;
      const spans = spansAlong(view, cuts, d);
      if (spans.length) chains.push({ kind, side: view.side, spans });
    });
  }
  return chains;
}

/** The stretch of the line through `p` (horizontal or vertical) that lies inside a room. */
function chord(rings: Pt[][], p: Pt, horizontal: boolean): [number, number] | null {
  const u = (q: Pt) => (horizontal ? q.x : q.y);
  const v = (q: Pt) => (horizontal ? q.y : q.x);
  const level = v(p);
  const hits: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (v(a) > level !== v(b) > level) hits.push(u(a) + ((level - v(a)) / (v(b) - v(a))) * (u(b) - u(a)));
    }
  }
  hits.sort((a, b) => a - b);
  for (let i = 0; i + 1 < hits.length; i += 2) {
    if (hits[i] <= u(p) && u(p) <= hits[i + 1]) return [hits[i], hits[i + 1]];
  }
  return null;
}

/**
 * The clear width and length of every room, between the inside wall faces:
 * one line across the room under its label and one down it near its left
 * wall. In a room that is not a rectangle they measure where they are drawn.
 */
export function roomChains(
  storey: Storey,
  style: DimensionStyle,
  scale: number,
  linked: LinkedSpaces = linkSpaces(storey),
): DimChain[] {
  const mm = scale / 1000;
  const inset = style.roomInsetMm * mm;
  const chains: DimChain[] = [];
  for (const space of storey.spaces) {
    const face = linked.faceBySpaceId.get(space.id);
    if (!face || face.netArea <= 0) continue;
    const rings = [face.netOuter, ...face.netHoles];
    const inside = (p: Pt) => pointInPolygon(p, face.netOuter, face.netHoles);
    // Under the label if there is room for it there, otherwise above it.
    const below = { x: space.anchor.x, y: space.anchor.y + 1.8 * inset };
    const above = { x: space.anchor.x, y: space.anchor.y - 1.8 * inset };
    const base = inside(below) ? below : inside(above) ? above : null;
    const through = base ?? space.anchor;
    const across = chord(rings, through, true);
    if (!across) continue;
    if (base && across[1] - across[0] > MIN_SPAN) {
      chains.push({
        kind: "room",
        id: space.id,
        spans: [
          { from: { x: across[0], y: base.y }, to: { x: across[1], y: base.y }, value: round(across[1] - across[0]) },
        ],
      });
    }
    const x = across[0] + Math.min(inset, (across[1] - across[0]) / 4);
    const down = chord(rings, { x, y: through.y }, false);
    if (down && down[1] - down[0] > MIN_SPAN) {
      chains.push({
        kind: "room",
        id: space.id,
        spans: [{ from: { x, y: down[0] }, to: { x, y: down[1] }, value: round(down[1] - down[0]) }],
      });
    }
  }
  return chains;
}

/** A hand-placed dimension as a chain of one span, with its two witness lines. */
export function ownChain(d: Dimension): DimChain | null {
  const length = dist(d.a, d.b);
  if (length <= MIN_SPAN) return null;
  const n = { x: -(d.b.y - d.a.y) / length, y: (d.b.x - d.a.x) / length };
  const from = { x: d.a.x + n.x * d.offset, y: d.a.y + n.y * d.offset };
  const to = { x: d.b.x + n.x * d.offset, y: d.b.y + n.y * d.offset };
  return {
    kind: "own",
    id: d.id,
    spans: [{ from, to, value: round(length) }],
    witness: [
      [d.a, from],
      [d.b, to],
    ],
  };
}

// ------------------------------------------------------------------- drawing

/**
 * The direction lettering runs along a line so that it reads upright: left to
 * right, and bottom to top on a vertical line. `up` points from the line to
 * the side the figures stand on.
 */
export function textFrame(from: Pt, to: Pt): { angle: number; dir: Pt; up: Pt } {
  let angle = Math.atan2(to.y - from.y, to.x - from.x);
  const eps = 1e-9;
  if (angle >= Math.PI / 2 - eps) angle -= Math.PI;
  else if (angle < -Math.PI / 2 - eps) angle += Math.PI;
  return {
    angle,
    dir: { x: Math.cos(angle), y: Math.sin(angle) },
    up: { x: Math.sin(angle), y: -Math.cos(angle) },
  };
}

/** Chains as lines and figures. `scale` (100 = 1:100) sets the size of ticks and lettering. */
export function chainEntities(chains: DimChain[], style: DimensionStyle, scale: number): Entity[] {
  const mm = scale / 1000;
  const h = style.textHeightMm * mm;
  const ext = style.extensionMm * mm;
  const tick = (style.tickMm * mm) / 2;
  const gap = style.textGapMm * mm;
  const out: Entity[] = [];
  const line = (a: Pt, b: Pt) =>
    out.push({ kind: "polyline", layer: "dimensions", points: [a, b].map((p) => ({ x: round(p.x), y: round(p.y) })), closed: false });

  for (const chain of chains) {
    if (chain.spans.length === 0) continue;
    const first = chain.spans[0].from;
    const last = chain.spans[chain.spans.length - 1].to;
    const { angle, dir, up } = textFrame(first, last);
    // Along the chain as it was given (which may be against the reading direction).
    const length = dist(first, last) || 1;
    const run = { x: (last.x - first.x) / length, y: (last.y - first.y) / length };
    line({ x: first.x - run.x * ext, y: first.y - run.y * ext }, { x: last.x + run.x * ext, y: last.y + run.y * ext });

    const marks = [first, ...chain.spans.map((s) => s.to)];
    for (const p of marks) {
      // A slanted stroke, rising in the reading direction.
      const s = { x: (dir.x + up.x) * tick * Math.SQRT1_2, y: (dir.y + up.y) * tick * Math.SQRT1_2 };
      line({ x: p.x - s.x, y: p.y - s.y }, { x: p.x + s.x, y: p.y + s.y });
      if (!chain.witness) line({ x: p.x - up.x * ext, y: p.y - up.y * ext }, { x: p.x + up.x * ext, y: p.y + up.y * ext });
    }
    for (const [point, onLine] of chain.witness ?? []) {
      const d = dist(point, onLine);
      if (d <= ext) continue;
      const w = { x: (onLine.x - point.x) / d, y: (onLine.y - point.y) / d };
      line({ x: point.x + w.x * ext, y: point.y + w.y * ext }, { x: onLine.x + w.x * ext, y: onLine.y + w.y * ext });
    }

    // Figures stand on the line. One too wide for its stretch goes under the
    // line instead, and the next such one back on top, so neighbours do not collide.
    let cramped = 0;
    for (const span of chain.spans) {
      const text = formatDimension(span.value, style);
      const narrow = dist(span.from, span.to) < text.length * h * 0.75 + gap;
      const sign = narrow && cramped++ % 2 === 0 ? -1 : 1;
      if (!narrow) cramped = 0;
      const off = (gap + h / 2) * sign;
      out.push({
        kind: "text",
        layer: "dimensions",
        at: {
          x: round((span.from.x + span.to.x) / 2 + up.x * off),
          y: round((span.from.y + span.to.y) / 2 + up.y * off),
        },
        text,
        height: h,
        angle,
      });
    }
  }
  return out;
}

/** Every chain of a storey that is switched on, hand-placed ones included. */
export function storeyChains(
  storey: Storey,
  annotations: Pick<Annotations, "outsideDimensions" | "roomDimensions">,
  style: DimensionStyle,
  scale: number,
  linked: LinkedSpaces = linkSpaces(storey),
): DimChain[] {
  const chains: DimChain[] = [];
  if (annotations.outsideDimensions) chains.push(...outsideChains(storey, style, scale, linked));
  if (annotations.roomDimensions) chains.push(...roomChains(storey, style, scale, linked));
  for (const d of storey.dimensions) {
    const chain = ownChain(d);
    if (chain) chains.push(chain);
  }
  return chains;
}

/** All dimensions of a storey as shapes, ready for the screen, a PDF or a DXF. */
export function storeyDimensions(
  storey: Storey,
  annotations: Pick<Annotations, "outsideDimensions" | "roomDimensions">,
  style: DimensionStyle,
  scale: number,
): Entity[] {
  return chainEntities(storeyChains(storey, annotations, style, scale), style, scale);
}

// ------------------------------------------------------------------- editing

/** Adds a hand-placed dimension; unchanged when the two points are the same. */
export function addDimension(
  storey: Storey,
  a: Pt,
  b: Pt,
  offset: number,
  makeId: (prefix: string) => string = newId,
): Storey {
  if (dist(a, b) <= MIN_SPAN || !Number.isFinite(offset)) return storey;
  const dimension: Dimension = { id: makeId("dimension"), a: { ...a }, b: { ...b }, offset: round(offset) };
  return { ...storey, dimensions: [...storey.dimensions, dimension] };
}

export function deleteDimension(storey: Storey, id: string): Storey {
  if (!storey.dimensions.some((d) => d.id === id)) return storey;
  return { ...storey, dimensions: storey.dimensions.filter((d) => d.id !== id) };
}

/** How far `p` is from the line a -> b, positive to its left: the offset a dimension there would have. */
export function offsetFromLine(a: Pt, b: Pt, p: Pt): number {
  const length = dist(a, b);
  if (length <= MIN_SPAN) return 0;
  return (-(b.y - a.y) * (p.x - a.x) + (b.x - a.x) * (p.y - a.y)) / length;
}

/** Points worth snapping a dimension to: wall corners, opening jambs and wall ends. */
export function dimensionSnapPoints(storey: Pick<Storey, "walls" | "openings">): Pt[] {
  return [...wallRegion(storey).flat(2), ...storey.walls.flatMap((w) => [w.a, w.b])];
}
