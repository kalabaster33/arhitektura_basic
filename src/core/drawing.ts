/**
 * A plan as a plain list of shapes and lettering, ready to be written to a
 * file. The PDF and DXF exports both read this, so they always show the same
 * thing. Pure functions, no UI imports.
 *
 * Coordinates are the model's: metres, x to the right, y DOWN (as on screen).
 * A writer whose y axis points up (DXF) flips it.
 */
import { difference, union } from "polyclip-ts";
import { type AreaConfig, computeStoreyAreas, formatArea } from "./areas.ts";
import { type Pt, dist, ringSignedArea } from "./geometry.ts";
import type { Site, Storey } from "./model.ts";
import { openingGeometry } from "./openings.ts";
import type { Region, SiteAnalysis } from "./site.ts";

export const LAYER_KEYS = [
  "walls",
  "doors",
  "windows",
  "rooms",
  "dimensions",
  "plot",
  "buildable",
  "footprint",
  "setbacks",
  "titles",
] as const;

export type LayerKey = (typeof LAYER_KEYS)[number];

export type Entity =
  /** A shape with holes, e.g. the walls of a storey cut where the openings are. */
  | { kind: "region"; layer: LayerKey; region: Region; filled: boolean }
  | { kind: "polyline"; layer: LayerKey; points: Pt[]; closed: boolean; dashed?: boolean }
  /**
   * Part of a circle from angle `start`, turning by `sweep` radians. Angles are
   * measured in model coordinates: a point is centre + radius * (cos, sin).
   */
  | { kind: "arc"; layer: LayerKey; centre: Pt; radius: number; start: number; sweep: number }
  /**
   * One line of lettering, centred on `at`. `height` is in metres. `angle`
   * turns it about `at`, in radians in model coordinates: the lettering runs
   * in the direction (cos, sin), so -PI/2 reads from the bottom of the plan up.
   */
  | { kind: "text"; layer: LayerKey; at: Pt; text: string; height: number; bold?: boolean; angle?: number };

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Drawing {
  entities: Entity[];
  /** Null when there is nothing to draw. */
  bounds: Bounds | null;
}

// ------------------------------------------------------------------- helpers

/** Points along an arc, both ends included. */
export function arcPoints(arc: Extract<Entity, { kind: "arc" }>, segments = 16): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = arc.start + (arc.sweep * i) / segments;
    pts.push({ x: arc.centre.x + arc.radius * Math.cos(a), y: arc.centre.y + arc.radius * Math.sin(a) });
  }
  return pts;
}

/** Every point that matters for how much room an entity takes. */
function extentPoints(e: Entity): Pt[] {
  switch (e.kind) {
    case "region":
      return e.region.flat(2);
    case "polyline":
      return e.points;
    case "arc":
      return arcPoints(e);
    case "text": {
      // Lettering is roughly 0.6 of its height wide per character.
      const half = (e.text.length * e.height * 0.6) / 2;
      // Turned lettering: allow for it in every direction.
      const tall = e.angle ? half : e.height / 2;
      return [
        { x: e.at.x - half, y: e.at.y - tall },
        { x: e.at.x + half, y: e.at.y + tall },
      ];
    }
  }
}

export function boundsOf(entities: Entity[]): Bounds | null {
  let b: Bounds | null = null;
  for (const e of entities) {
    for (const p of extentPoints(e)) {
      if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      else {
        b.minX = Math.min(b.minX, p.x);
        b.minY = Math.min(b.minY, p.y);
        b.maxX = Math.max(b.maxX, p.x);
        b.maxY = Math.max(b.maxY, p.y);
      }
    }
  }
  return b;
}

const makeDrawing = (entities: Entity[]): Drawing => ({ entities, bounds: boundsOf(entities) });

/** The same drawing with more on it. */
export function addEntities(drawing: Drawing, extra: Entity[]): Drawing {
  return extra.length ? makeDrawing([...drawing.entities, ...extra]) : drawing;
}

/** The same drawing moved by (dx, dy). */
export function translateDrawing(drawing: Drawing, dx: number, dy: number): Drawing {
  if (dx === 0 && dy === 0) return drawing;
  const move = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  const entities = drawing.entities.map((e): Entity => {
    switch (e.kind) {
      case "region":
        return { ...e, region: e.region.map((poly) => poly.map((ring) => ring.map(move))) };
      case "polyline":
        return { ...e, points: e.points.map(move) };
      case "arc":
        return { ...e, centre: move(e.centre) };
      case "text":
        return { ...e, at: move(e.at) };
    }
  });
  return makeDrawing(entities);
}

type Pair = [number, number];

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const toPoly = (ring: Pt[]): Pair[][] => [ring.map((p): Pair => [p.x, p.y])];
const toRegion = (multi: Pair[][][]): Region =>
  // polyclip closes its rings by repeating the first point; ours do not.
  multi.map((poly) => poly.map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x: round(x), y: round(y) }))));

// -------------------------------------------------------------------- storey

/** How far a gap is cut beyond the wall faces, so no sliver of wall is left. */
const GAP_OVERCUT = 0.005;

/**
 * The walls of a storey as one shape: every wall as a rectangle of its own
 * thickness, merged where walls meet, with a gap cut at every door and window.
 * Wall ends are squared off half a thickness beyond the centreline end, which
 * is what fills the corner where two walls meet (and what the editor draws).
 */
export function wallRegion(storey: Pick<Storey, "walls" | "openings">): Region {
  const rects: Pair[][][] = [];
  for (const w of storey.walls) {
    const len = dist(w.a, w.b);
    if (len < 1e-9 || w.thickness <= 0) continue;
    const h = w.thickness / 2;
    const u = { x: ((w.b.x - w.a.x) / len) * h, y: ((w.b.y - w.a.y) / len) * h };
    const n = { x: -u.y, y: u.x };
    rects.push(
      toPoly([
        { x: w.a.x - u.x + n.x, y: w.a.y - u.y + n.y },
        { x: w.b.x + u.x + n.x, y: w.b.y + u.y + n.y },
        { x: w.b.x + u.x - n.x, y: w.b.y + u.y - n.y },
        { x: w.a.x - u.x - n.x, y: w.a.y - u.y - n.y },
      ]),
    );
  }
  if (rects.length === 0) return [];
  const gaps: Pair[][][] = [];
  for (const o of storey.openings) {
    const wall = storey.walls.find((w) => w.id === o.wallId);
    if (!wall || o.width <= 0) continue;
    const g = openingGeometry(wall, o);
    const h = g.thickness / 2 + GAP_OVERCUT;
    const at = (along: number, across: number): Pt => ({
      x: g.start.x + g.dir.x * along + g.normal.x * across,
      y: g.start.y + g.dir.y * along + g.normal.y * across,
    });
    gaps.push(toPoly([at(0, -h), at(o.width, -h), at(o.width, h), at(0, h)]));
  }
  const merged = union(rects[0], ...rects.slice(1));
  return toRegion(gaps.length ? difference(merged, ...gaps) : merged);
}

/**
 * One storey: walls, door and window symbols, and a label in every room with
 * its name, its net area and, where it has one, its apartment.
 * `textHeight` is the height of the lettering in metres.
 */
export function storeyDrawing(storey: Storey, areaConfig: AreaConfig, textHeight: number): Drawing {
  const entities: Entity[] = [];
  const walls = wallRegion(storey);
  if (walls.length) entities.push({ kind: "region", layer: "walls", region: walls, filled: true });

  for (const o of storey.openings) {
    const wall = storey.walls.find((w) => w.id === o.wallId);
    if (!wall || o.width <= 0) continue;
    const g = openingGeometry(wall, o);
    const half = g.thickness / 2;
    const w = o.width;
    const at = (along: number, across: number): Pt => ({
      x: round(g.start.x + g.dir.x * along + g.normal.x * across),
      y: round(g.start.y + g.dir.y * along + g.normal.y * across),
    });
    if (o.kind === "door") {
      // Leaf standing open at the first jamb, and the path its free edge takes.
      entities.push({ kind: "polyline", layer: "doors", points: [at(0, half), at(0, half + w)], closed: false });
      entities.push({
        kind: "arc",
        layer: "doors",
        centre: at(0, half),
        radius: w,
        start: Math.atan2(g.normal.y, g.normal.x),
        sweep: -Math.PI / 2,
      });
    } else {
      entities.push({
        kind: "polyline",
        layer: "windows",
        points: [at(0, -half), at(w, -half), at(w, half), at(0, half)],
        closed: true,
      });
      entities.push({ kind: "polyline", layer: "windows", points: [at(0, 0), at(w, 0)], closed: false });
    }
  }

  const netById = new Map(computeStoreyAreas(storey, areaConfig).spaces.map((s) => [s.spaceId, s.net]));
  const apartmentOf = new Map<string, string>();
  for (const a of storey.apartments) for (const id of a.spaceIds) apartmentOf.set(id, a.name);
  const line = textHeight * 1.9;
  for (const space of storey.spaces) {
    const net = netById.get(space.id);
    if (net === undefined) continue;
    const lines: { text: string; bold?: boolean }[] = [
      { text: space.name, bold: true },
      { text: `${formatArea(net, areaConfig)} m²` },
    ];
    const apartment = apartmentOf.get(space.id);
    if (apartment) lines.push({ text: apartment });
    lines.forEach((l, i) => {
      if (!l.text.trim()) return;
      entities.push({
        kind: "text",
        layer: "rooms",
        at: { x: space.anchor.x, y: round(space.anchor.y + (i - (lines.length - 1) / 2) * line) },
        text: l.text,
        height: textHeight,
        bold: l.bold,
      });
    });
  }
  return makeDrawing(entities);
}

// ---------------------------------------------------------------------- site

/**
 * The site plan: plot outline, buildable area (dashed), building footprint
 * and the setback of each edge written beside it.
 */
export function siteDrawing(
  site: Pick<Site, "boundary" | "setbacks">,
  analysis: Pick<SiteAnalysis, "buildable" | "footprint">,
  textHeight: number,
): Drawing {
  const entities: Entity[] = [];
  const ring = site.boundary;
  const n = ring.length;
  if (n >= 3) {
    entities.push({ kind: "polyline", layer: "plot", points: ring.map((p) => ({ ...p })), closed: true });
  }
  for (const poly of analysis.buildable) {
    for (const r of poly) {
      entities.push({ kind: "polyline", layer: "buildable", points: r, closed: true, dashed: true });
    }
  }
  if (analysis.footprint.length) {
    entities.push({ kind: "region", layer: "footprint", region: analysis.footprint, filled: true });
  }
  if (n >= 3) {
    const side = ringSignedArea(ring) >= 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const d = site.setbacks[i] ?? 0;
      if (d <= 0) continue;
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const len = dist(a, b) || 1;
      const inward = { x: (-(b.y - a.y) / len) * side, y: ((b.x - a.x) / len) * side };
      entities.push({
        kind: "text",
        layer: "setbacks",
        at: {
          x: round((a.x + b.x) / 2 + (inward.x * d) / 2),
          y: round((a.y + b.y) / 2 + (inward.y * d) / 2),
        },
        text: d.toFixed(2),
        height: textHeight,
      });
    }
  }
  return makeDrawing(entities);
}
