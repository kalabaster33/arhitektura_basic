/**
 * Object snap, as in AutoCAD: the pointer is pulled to the end, middle,
 * centre, crossing, foot of the perpendicular or nearest point of what is
 * already drawn, and otherwise to the grid. Ortho keeps the new point level
 * or plumb with the last one. Pure functions, no UI imports.
 */
import { type Pt, dist, lerp, lineIntersectionParams, projectParam, snapPoint } from "./geometry.ts";

export const SNAP_MODES = [
  "endpoint",
  "midpoint",
  "center",
  "intersection",
  "perpendicular",
  "nearest",
] as const;
export type SnapMode = (typeof SNAP_MODES)[number];

export const SNAP_LABEL: Record<SnapMode, string> = {
  endpoint: "Endpoint",
  midpoint: "Midpoint",
  center: "Center",
  intersection: "Intersection",
  perpendicular: "Perpendicular",
  nearest: "Nearest",
};

export interface SnapSettings {
  /** Object snap on or off as a whole (F3). */
  osnap: boolean;
  modes: Record<SnapMode, boolean>;
  /** Grid snap on or off (F9). */
  grid: boolean;
  /** Keeps a new point level or plumb with the last one (F8). */
  ortho: boolean;
}

export const DEFAULT_SNAP: SnapSettings = {
  osnap: true,
  modes: {
    endpoint: true,
    midpoint: true,
    center: true,
    intersection: true,
    perpendicular: true,
    nearest: false,
  },
  grid: true,
  ortho: false,
};

/** What can be snapped to: straight pieces, single points and centres of closed shapes. */
export interface SnapGeometry {
  segments: [Pt, Pt][];
  /** Extra end points that are not the end of a segment (opening jambs, wall faces). */
  points: Pt[];
  centers: Pt[];
}

export type SnapKind = SnapMode | "grid" | "free";

export interface SnapResult {
  pt: Pt;
  kind: SnapKind;
}

/** Earlier modes win when two are equally near: an end beats the middle beats the rest. */
const PRIORITY: SnapMode[] = ["endpoint", "intersection", "midpoint", "center", "perpendicular", "nearest"];

/** Segments and closed rings as snap geometry. */
export function snapGeometry(open: [Pt, Pt][], rings: Pt[][], points: Pt[] = []): SnapGeometry {
  const segments = [...open];
  const centers: Pt[] = [];
  for (const ring of rings) {
    if (ring.length < 2) continue;
    for (let i = 0; i < ring.length; i++) segments.push([ring[i], ring[(i + 1) % ring.length]]);
    if (ring.length >= 3) {
      centers.push({
        x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
        y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
      });
    }
  }
  return { segments, points, centers };
}

/**
 * Where a point at `p` lands. `tol` is how near (in metres) an object must be
 * to pull the point; `from` is the last point placed, for perpendicular and
 * ortho; `step` is the grid.
 */
export function findSnap(
  p: Pt,
  geo: SnapGeometry,
  settings: SnapSettings,
  tol: number,
  step: number,
  from?: Pt | null,
): SnapResult {
  const ortho = (q: Pt): Pt =>
    settings.ortho && from
      ? Math.abs(q.x - from.x) >= Math.abs(q.y - from.y)
        ? { x: q.x, y: from.y }
        : { x: from.x, y: q.y }
      : q;

  if (settings.osnap) {
    const candidates: { pt: Pt; kind: SnapMode; d: number }[] = [];
    const offer = (kind: SnapMode, q: Pt) => {
      if (!settings.modes[kind]) return;
      const d = dist(p, q);
      if (d <= tol) candidates.push({ pt: q, kind, d });
    };
    for (const [a, b] of geo.segments) {
      offer("endpoint", a);
      offer("endpoint", b);
      offer("midpoint", lerp(a, b, 0.5));
      if (from && settings.modes.perpendicular) {
        const t = projectParam(from, a, b);
        if (t > 1e-6 && t < 1 - 1e-6) offer("perpendicular", lerp(a, b, t));
      }
      if (settings.modes.nearest) {
        const t = Math.max(0, Math.min(1, projectParam(p, a, b)));
        offer("nearest", lerp(a, b, t));
      }
    }
    for (const q of geo.points) offer("endpoint", q);
    for (const q of geo.centers) offer("center", q);
    if (settings.modes.intersection) {
      // Only segments near the pointer can cross near it.
      const near = geo.segments.filter(([a, b]) => distToSeg(p, a, b) <= tol);
      for (let i = 0; i < near.length; i++) {
        for (let j = i + 1; j < near.length; j++) {
          const [a, b] = near[i];
          const [c, d] = near[j];
          const hit = lineIntersectionParams(a, b, c, d);
          if (!hit) continue;
          const e = 1e-6;
          if (hit.t < -e || hit.t > 1 + e || hit.u < -e || hit.u > 1 + e) continue;
          offer("intersection", lerp(a, b, hit.t));
        }
      }
    }
    if (candidates.length) {
      // "Nearest" is only a last resort, as in AutoCAD. Otherwise the closest wins,
      // and when two are about as close the more telling kind wins.
      const lastResort = (c: { kind: SnapMode }) => (c.kind === "nearest" ? 1 : 0);
      candidates.sort(
        (x, y) =>
          lastResort(x) - lastResort(y) ||
          (Math.abs(x.d - y.d) < tol * 0.25 ? PRIORITY.indexOf(x.kind) - PRIORITY.indexOf(y.kind) : x.d - y.d),
      );
      const best = candidates[0];
      const pt = { x: round(best.pt.x), y: round(best.pt.y) };
      return { pt, kind: best.kind };
    }
  }
  const q = ortho(p);
  if (settings.grid) {
    const g = snapPoint(q, step);
    // With ortho the locked coordinate stays exactly on the last point, even off the grid.
    if (settings.ortho && from) {
      return { pt: q.y === from.y ? { x: g.x, y: from.y } : { x: from.x, y: g.y }, kind: "grid" };
    }
    return { pt: g, kind: "grid" };
  }
  return { pt: { x: round(q.x), y: round(q.y) }, kind: "free" };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const t = Math.max(0, Math.min(1, projectParam(p, a, b)));
  return dist(p, lerp(a, b, t));
}

// --------------------------------------------------------------------- shapes

export const SHAPES = ["line", "rectangle", "polygon", "circle"] as const;
export type Shape = (typeof SHAPES)[number];

/** Corners of the rectangle with opposite corners a and b. */
export function rectangleCorners(a: Pt, b: Pt): Pt[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}

/**
 * Corners of a regular polygon around `centre`, with its first corner at
 * `corner`. A circle is drawn as a polygon of many sides, since walls are straight.
 */
export function regularPolygon(centre: Pt, corner: Pt, sides: number): Pt[] {
  const r = dist(centre, corner);
  const n = Math.max(3, Math.round(sides));
  const start = Math.atan2(corner.y - centre.y, corner.x - centre.x);
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + (2 * Math.PI * i) / n;
    pts.push({ x: round(centre.x + r * Math.cos(a)), y: round(centre.y + r * Math.sin(a)) });
  }
  return pts;
}

/** The closed outline a shape tool draws from its two clicks, or null for a line. */
export function shapeRing(shape: Shape, a: Pt, b: Pt, sides: { polygon: number; circle: number }): Pt[] | null {
  switch (shape) {
    case "line":
      return null;
    case "rectangle":
      return rectangleCorners(a, b);
    case "polygon":
      return regularPolygon(a, b, sides.polygon);
    case "circle":
      return regularPolygon(a, b, sides.circle);
  }
}
