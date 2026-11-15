/**
 * The plot: its outline, a setback per edge, the buildable area that leaves,
 * the footprint of the buildings on it, and the site figures and warnings.
 * Pure functions on the project, no UI imports.
 *
 * Starting values and the definition of the footprint come from a config
 * (src/config/siteRules.json), not from this code.
 */
import { difference, intersection, union } from "polyclip-ts";
import { type AreaConfig, computeBuildingAreas } from "./areas.ts";
import { sortedStoreys } from "./building.ts";
import { type Pt, dist, lerp, ringSignedArea, samePoint } from "./geometry.ts";
import type { Project, Site, SiteLimits } from "./model.ts";
import { buildTopology } from "./topology.ts";

export type FootprintMode = "allStoreys" | "lowestStorey";

export interface SiteRules {
  defaultSetback: number;
  maxCoverage: number | null;
  maxFloorAreaRatio: number | null;
  footprint: FootprintMode;
}

const FOOTPRINT_MODES: FootprintMode[] = ["allStoreys", "lowestStorey"];

/** Checks a config loaded from JSON; throws with the offending key. */
export function parseSiteRules(raw: unknown): SiteRules {
  const c = raw as SiteRules;
  const fail = (key: string): never => {
    throw new Error(`Site rules: invalid or missing "${key}".`);
  };
  if (!c || typeof c !== "object") fail("(root)");
  if (typeof c.defaultSetback !== "number" || !(c.defaultSetback >= 0)) fail("defaultSetback");
  const limit = (key: "maxCoverage" | "maxFloorAreaRatio"): number | null => {
    const v = c[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !(v > 0)) fail(key);
    return v;
  };
  if (!FOOTPRINT_MODES.includes(c.footprint)) fail("footprint");
  return {
    defaultSetback: c.defaultSetback,
    maxCoverage: limit("maxCoverage"),
    maxFloorAreaRatio: limit("maxFloorAreaRatio"),
    footprint: c.footprint,
  };
}

// ---------------------------------------------------------------- plot editing

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** True when p lies on the segment a-b (ends included). */
function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  return (
    Math.abs(cross(a, b, p)) <= 1e-9 * Math.max(1, dist(a, b)) &&
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

/** True when the segments share any point. */
function segmentsTouch(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}

/** Why these corners do not make a usable plot outline, or null when they do. */
export function boundaryProblem(corners: Pt[]): string | null {
  const n = corners.length;
  if (n < 3) return "A plot needs at least three corners.";
  for (let i = 0; i < n; i++) {
    if (samePoint(corners[i], corners[(i + 1) % n])) return "Two corners are in the same place.";
  }
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    // The next edge shares corner b; it may not run back along this one.
    const e = corners[(i + 2) % n];
    if (onSegment(e, a, b) || onSegment(a, b, e)) return "The outline folds back on itself.";
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // these two share corner 0
      if (segmentsTouch(a, b, corners[j], corners[(j + 1) % n])) return "The outline crosses itself.";
    }
  }
  if (Math.abs(ringSignedArea(corners)) < 1e-6) return "The outline encloses no area.";
  return null;
}

function withSite(project: Project, patch: Partial<Site>): Project {
  return { ...project, site: { ...project.site, ...patch } };
}

/**
 * Sets the plot outline. Every edge gets the same setback, and the limits are
 * filled in where the project has none yet. An outline that crosses itself is
 * not applied: the project comes back unchanged.
 */
export function setBoundary(
  project: Project,
  corners: Pt[],
  setback: number,
  limits?: SiteLimits,
): Project {
  const boundary = corners.map((p) => ({ x: round(p.x), y: round(p.y) }));
  if (boundaryProblem(boundary) || !(setback >= 0)) return project;
  const current = project.site.limits;
  return withSite(project, {
    boundary,
    setbacks: boundary.map(() => setback),
    limits: {
      maxCoverage: current.maxCoverage ?? limits?.maxCoverage ?? null,
      maxFloorAreaRatio: current.maxFloorAreaRatio ?? limits?.maxFloorAreaRatio ?? null,
    },
  });
}

/** Removes the plot; the limits stay for the next one. */
export function clearBoundary(project: Project): Project {
  if (project.site.boundary.length === 0) return project;
  return withSite(project, { boundary: [], setbacks: [] });
}

/** Moves one corner. A move that would make the outline cross itself is not applied. */
export function moveBoundaryCorner(project: Project, index: number, to: Pt): Project {
  const { boundary } = project.site;
  if (!boundary[index] || !Number.isFinite(to.x) || !Number.isFinite(to.y)) return project;
  const next = boundary.map((p, i) => (i === index ? { x: round(to.x), y: round(to.y) } : p));
  return boundaryProblem(next) ? project : withSite(project, { boundary: next });
}

/**
 * Removes one corner: the two edges that met there become one, which keeps the
 * setback of the first. Not applied when fewer than three corners would be
 * left or the outline would cross itself.
 */
export function deleteBoundaryCorner(project: Project, index: number): Project {
  const { boundary, setbacks } = project.site;
  if (!boundary[index]) return project;
  const next = boundary.filter((_, i) => i !== index);
  if (boundaryProblem(next)) return project;
  // Edge index (corner -> next corner) disappears; edge index - 1 now spans both.
  return withSite(project, { boundary: next, setbacks: setbacks.filter((_, i) => i !== index) });
}

/** Adds a corner in the middle of an edge; both halves keep the edge's setback. */
export function insertBoundaryCorner(project: Project, edgeIndex: number): Project {
  const { boundary, setbacks } = project.site;
  if (!boundary[edgeIndex]) return project;
  const mid = lerp(boundary[edgeIndex], boundary[(edgeIndex + 1) % boundary.length], 0.5);
  const corner = { x: round(mid.x), y: round(mid.y) };
  return withSite(project, {
    boundary: [...boundary.slice(0, edgeIndex + 1), corner, ...boundary.slice(edgeIndex + 1)],
    setbacks: [...setbacks.slice(0, edgeIndex + 1), setbacks[edgeIndex], ...setbacks.slice(edgeIndex + 1)],
  });
}

export function setSetback(project: Project, edgeIndex: number, setback: number): Project {
  const { setbacks, boundary } = project.site;
  if (!boundary[edgeIndex] || !(setback >= 0)) return project;
  return withSite(project, { setbacks: boundary.map((_, i) => (i === edgeIndex ? setback : setbacks[i] ?? 0)) });
}

/** Sets or clears (null) the planning limits of the plot. */
/** Sets where north is on the plan, in degrees clockwise from the top. */
export function setNorth(project: Project, degrees: number): Project {
  if (!Number.isFinite(degrees)) return project;
  const d = degrees % 360;
  const north = Math.round((d < 0 ? d + 360 : d) * 1e6) / 1e6;
  return north === project.site.north ? project : { ...project, site: { ...project.site, north } };
}

export function setSiteLimits(project: Project, patch: Partial<SiteLimits>): Project {
  const clean = (v: number | null | undefined, old: number | null) =>
    v === undefined ? old : v !== null && v > 0 ? v : null;
  const old = project.site.limits;
  return withSite(project, {
    limits: {
      maxCoverage: clean(patch.maxCoverage, old.maxCoverage),
      maxFloorAreaRatio: clean(patch.maxFloorAreaRatio, old.maxFloorAreaRatio),
    },
  });
}

// ------------------------------------------------------------ derived geometry

/** A shape that may be in several pieces, each an outer ring followed by its holes. */
export type Region = Pt[][][];

type Pair = [number, number];

const toPoly = (ring: Pt[]): Pair[][] => [ring.map((p): Pair => [p.x, p.y])];

function toRegion(multi: Pair[][][]): Region {
  return multi.map((poly) =>
    // polyclip closes its rings by repeating the first point; ours do not.
    poly.map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x: round(x), y: round(y) }))),
  );
}

const fromRegion = (region: Region): Pair[][][] =>
  region.map((poly) => poly.map((ring) => ring.map((p): Pair => [p.x, p.y])));

export function regionArea(region: Region): number {
  let area = 0;
  for (const [outer, ...holes] of region) {
    area += Math.abs(ringSignedArea(outer));
    for (const hole of holes) area -= Math.abs(ringSignedArea(hole));
  }
  return Math.max(0, area);
}

/** Mitres longer than this many setbacks are cut short, as in offsetRingLeft. */
const MITER_LIMIT = 4;

/**
 * The part of the plot that may be built on: the plot less a strip along each
 * edge as deep as that edge's setback. Around a corner that points into the
 * plot the two strips are joined with a mitre, so the buildable area keeps a
 * sharp corner there. Empty when there is no plot or the setbacks use it up.
 */
export function buildableArea(site: Pick<Site, "boundary" | "setbacks">): Region {
  const ring = site.boundary;
  const n = ring.length;
  if (n < 3) return [];
  // Inward is to the left of each edge for a positive ring, to the right otherwise.
  const side = ringSignedArea(ring) >= 0 ? 1 : -1;
  const d = ring.map((_, i) => Math.max(0, site.setbacks[i] ?? 0));
  const dir = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const len = dist(p, q) || 1;
    return { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
  });
  const inward = dir.map((u) => ({ x: -u.y * side, y: u.x * side }));
  const strips: Pair[][][] = [];
  for (let i = 0; i < n; i++) {
    if (d[i] <= 0) continue;
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const m = inward[i];
    strips.push(toPoly([a, b, { x: b.x + m.x * d[i], y: b.y + m.y * d[i] }, { x: a.x + m.x * d[i], y: a.y + m.y * d[i] }]));
  }
  for (let i = 0; i < n; i++) {
    // Corner i sits between edge i - 1 and edge i.
    const k = (i + n - 1) % n;
    if (d[k] <= 0 || d[i] <= 0) continue;
    const turn = (dir[k].x * dir[i].y - dir[k].y * dir[i].x) * side;
    if (turn >= -1e-9) continue; // the corner points outward: the strips already overlap
    const p = ring[i];
    const a = { x: p.x + inward[k].x * d[k], y: p.y + inward[k].y * d[k] };
    const b = { x: p.x + inward[i].x * d[i], y: p.y + inward[i].y * d[i] };
    // Where the two setback lines meet.
    const s = ((b.x - a.x) * dir[i].y - (b.y - a.y) * dir[i].x) / (dir[k].x * dir[i].y - dir[k].y * dir[i].x);
    const fill =
      Math.abs(s) > MITER_LIMIT * Math.max(d[k], d[i])
        ? [p, a, b]
        : [p, a, { x: a.x + dir[k].x * s, y: a.y + dir[k].y * s }, b];
    if (Math.abs(ringSignedArea(fill)) > 1e-12) strips.push(toPoly(fill));
  }
  const plot = toPoly(ring);
  if (strips.length === 0) return [[ring.map((p) => ({ ...p }))]];
  return toRegion(difference(plot, ...strips));
}

/**
 * The buildings as seen from above, to the outside wall faces. With
 * "allStoreys" an upper floor that overhangs the ones below counts; with
 * "lowestStorey" only the lowest storey of each building does.
 */
export function buildingFootprint(site: Pick<Site, "buildings">, mode: FootprintMode): Region {
  const shapes: Pair[][][] = [];
  for (const building of site.buildings) {
    const storeys = mode === "lowestStorey" ? sortedStoreys(building).slice(0, 1) : building.storeys;
    for (const storey of storeys) {
      for (const outline of buildTopology(storey.walls).outlines) {
        if (outline.outerFace.length >= 3 && outline.outerFaceArea > 1e-9) {
          shapes.push(toPoly(outline.outerFace));
        }
      }
    }
  }
  if (shapes.length === 0) return [];
  return toRegion(union(shapes[0], ...shapes.slice(1)));
}

// ---------------------------------------------------------- figures and checks

export interface SiteIssue {
  kind: "outsidePlot" | "insideSetback" | "coverage" | "floorAreaRatio";
  message: string;
}

export interface SiteAnalysis {
  hasPlot: boolean;
  plotArea: number;
  buildable: Region;
  buildableArea: number;
  footprint: Region;
  footprintArea: number;
  /** Total gross floor area of all storeys of all buildings. */
  grossFloorArea: number;
  /** Footprint divided by plot area; null without a plot. */
  coverage: number | null;
  /** Gross floor area divided by plot area; null without a plot. */
  floorAreaRatio: number | null;
  /** Parts of the footprint beyond the plot outline. */
  outsidePlot: Region;
  /** Parts of the footprint on the plot but closer to an edge than its setback. */
  insideSetback: Region;
  issues: SiteIssue[];
}

/** Overlaps smaller than this are drawing noise (1 cm²). */
const AREA_TOL = 1e-4;
/** Ratios are compared with this much play, so a value exactly on the limit passes. */
const RATIO_TOL = 1e-9;

const percent = (v: number) => `${(v * 100).toFixed(1)} %`;

export function analyseSite(site: Site, rules: SiteRules, areaConfig: AreaConfig): SiteAnalysis {
  const footprint = buildingFootprint(site, rules.footprint);
  const footprintArea = regionArea(footprint);
  let grossFloorArea = 0;
  for (const b of site.buildings) grossFloorArea += computeBuildingAreas(b, areaConfig).totals.gross;

  const hasPlot = site.boundary.length >= 3;
  const base = {
    footprint,
    footprintArea,
    grossFloorArea,
  };
  if (!hasPlot) {
    return {
      ...base,
      hasPlot,
      plotArea: 0,
      buildable: [],
      buildableArea: 0,
      coverage: null,
      floorAreaRatio: null,
      outsidePlot: [],
      insideSetback: [],
      issues: [],
    };
  }

  const plotArea = Math.abs(ringSignedArea(site.boundary));
  const buildable = buildableArea(site);
  const plot = toPoly(site.boundary);
  let outsidePlot: Region = [];
  let insideSetback: Region = [];
  if (footprint.length > 0) {
    const shape = fromRegion(footprint);
    outsidePlot = toRegion(difference(shape, plot));
    const onPlot = intersection(shape, plot);
    insideSetback =
      onPlot.length === 0
        ? []
        : buildable.length === 0
          ? toRegion(onPlot)
          : toRegion(difference(onPlot, fromRegion(buildable)));
  }
  const drop = (r: Region) => r.filter((poly) => regionArea([poly]) > AREA_TOL);
  outsidePlot = drop(outsidePlot);
  insideSetback = drop(insideSetback);

  const coverage = footprintArea / plotArea;
  const floorAreaRatio = grossFloorArea / plotArea;
  const issues: SiteIssue[] = [];
  if (outsidePlot.length > 0) {
    issues.push({
      kind: "outsidePlot",
      message: `The building reaches beyond the plot outline (${regionArea(outsidePlot).toFixed(2)} m² outside).`,
    });
  }
  if (insideSetback.length > 0) {
    issues.push({
      kind: "insideSetback",
      message: `The building crosses a setback line (${regionArea(insideSetback).toFixed(2)} m² inside the setbacks).`,
    });
  }
  const { maxCoverage, maxFloorAreaRatio } = site.limits;
  if (maxCoverage !== null && coverage > maxCoverage + RATIO_TOL) {
    issues.push({
      kind: "coverage",
      message: `Site coverage is ${percent(coverage)}, above the limit of ${percent(maxCoverage)}.`,
    });
  }
  if (maxFloorAreaRatio !== null && floorAreaRatio > maxFloorAreaRatio + RATIO_TOL) {
    issues.push({
      kind: "floorAreaRatio",
      message: `Floor area ratio is ${floorAreaRatio.toFixed(2)}, above the limit of ${maxFloorAreaRatio.toFixed(2)}.`,
    });
  }
  return {
    ...base,
    hasPlot,
    plotArea,
    buildable,
    buildableArea: regionArea(buildable),
    coverage,
    floorAreaRatio,
    outsidePlot,
    insideSetback,
    issues,
  };
}
