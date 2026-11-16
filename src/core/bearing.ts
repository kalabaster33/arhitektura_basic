/**
 * How evenly the load-bearing walls of a storey are spread: the centre of
 * stiffness against the centre of mass, and whether the storey would twist.
 *
 * Every carrying element is taken as a cantilever whose stiffness is its
 * second moment of area: a wall piece of thickness t and length L resists a
 * push along itself with t L^3 / 12 and across itself with L t^3 / 12; a
 * column of width w (along x) and depth d (along y) with d w^3 / 12 along x
 * and w d^3 / 12 along y. Doors and windows cut a wall into separate pieces.
 * The outside walls, the core walls, the walls marked load-bearing and the
 * columns carry; partitions do not. The mass is spread evenly over the floor.
 *
 * The test is the regularity criterion of Eurocode 8 (EN 1998-1, 4.2.3.2 (6)):
 * in each direction the eccentricity is at most 0.30 times the torsional
 * radius, and the torsional radius is at least the radius of gyration of the
 * floor. The factor and whether the second part is checked come from
 * src/config/bearingCheck.json. Pure functions, no UI imports.
 */
import { type Pt, dist } from "./geometry.ts";
import type { Building, Storey, Wall } from "./model.ts";
import { linkSpaces } from "./spaces.ts";
import { storeyOutline } from "./structure.ts";

export interface BearingConfig {
  maxEccentricityRatio: number;
  checkGyration: boolean;
}

export function parseBearingConfig(raw: unknown): BearingConfig {
  const c = raw as Partial<BearingConfig> | null;
  const ratio = c?.maxEccentricityRatio;
  if (typeof ratio !== "number" || !(ratio > 0)) throw new Error('Bearing check: invalid or missing "maxEccentricityRatio".');
  if (typeof c?.checkGyration !== "boolean") throw new Error('Bearing check: invalid or missing "checkGyration".');
  return { maxEccentricityRatio: ratio, checkGyration: c.checkGyration };
}

/** True for a wall that carries the building. */
export const carries = (w: Wall): boolean => w.part !== undefined || w.loadBearing === true;

/** One carrying element: where it is and how stiff it is against a push along x and along y. */
interface Element {
  at: Pt;
  kx: number;
  ky: number;
}

/** The solid pieces of a wall between its doors and windows, as distances from its `a` end. */
function solidPieces(storey: Storey, wall: Wall): [number, number][] {
  const length = dist(wall.a, wall.b);
  const cuts = storey.openings
    .filter((o) => o.wallId === wall.id)
    .map((o): [number, number] => [o.offset - o.width / 2, o.offset + o.width / 2])
    .sort((p, q) => p[0] - q[0]);
  const pieces: [number, number][] = [];
  let from = 0;
  for (const [a, b] of cuts) {
    if (a > from) pieces.push([from, Math.min(a, length)]);
    from = Math.max(from, b);
  }
  if (from < length) pieces.push([from, length]);
  return pieces.filter(([a, b]) => b - a > 1e-3);
}

function elements(storey: Storey): Element[] {
  const out: Element[] = [];
  for (const w of storey.walls) {
    if (!carries(w)) continue;
    const length = dist(w.a, w.b);
    if (length < 1e-6) continue;
    const ux = (w.b.x - w.a.x) / length;
    const uy = (w.b.y - w.a.y) / length;
    for (const [s0, s1] of solidPieces(storey, w)) {
      const l = s1 - s0;
      const along = (w.thickness * l ** 3) / 12;
      const across = (l * w.thickness ** 3) / 12;
      const mid = (s0 + s1) / 2;
      out.push({
        at: { x: w.a.x + ux * mid, y: w.a.y + uy * mid },
        kx: along * ux * ux + across * uy * uy,
        ky: along * uy * uy + across * ux * ux,
      });
    }
  }
  for (const c of storey.columns ?? []) {
    out.push({ at: c.at, kx: (c.d * c.w ** 3) / 12, ky: (c.w * c.d ** 3) / 12 });
  }
  return out;
}

/** Area, centroid and polar second moment (about the centroid) of a polygon. */
function ringMoments(ring: Pt[]): { area: number; centre: Pt; polar: number } | null {
  let a = 0;
  let cx = 0;
  let cy = 0;
  let ixx = 0;
  let iyy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
    ixx += (p.y * p.y + p.y * q.y + q.y * q.y) * cross;
    iyy += (p.x * p.x + p.x * q.x + q.x * q.x) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) return null;
  const centre = { x: cx / (6 * a), y: cy / (6 * a) };
  // Signs cancel: every sum carries the orientation of the ring, and so does a.
  const polarOrigin = (ixx + iyy) / 12;
  const polar = Math.abs(polarOrigin - a * (centre.x ** 2 + centre.y ** 2));
  return { area: Math.abs(a), centre, polar };
}

export interface BearingResult {
  /** Carrying pieces counted: wall pieces between openings, and columns. */
  elements: number;
  /** Middle of the floor, where its mass acts. Null without an outline. */
  centreOfMass: Pt | null;
  /** Null when nothing carries in one of the two directions. */
  centreOfStiffness: Pt | null;
  /** Distance between the two centres, along x and along y. */
  eccentricity: { x: number; y: number } | null;
  /** Torsional radius for a push along y (r_x) and along x (r_y). */
  radius: { x: number; y: number } | null;
  /** Radius of gyration of the floor (l_s). */
  gyration: number | null;
  /** Problems in plain words; empty when the storey passes. */
  problems: string[];
}

const fmt = (v: number) => v.toFixed(2);

/** The check for one storey. */
export function checkBearing(building: Building, storey: Storey, config: BearingConfig): BearingResult {
  let outline = storeyOutline(building, storey.id);
  if (outline.length < 3) {
    // A plan drawn without a structure: the outside face of its largest group of walls.
    const largest = linkSpaces(storey).topology.outlines.sort((p, q) => q.outerFaceArea - p.outerFaceArea)[0];
    outline = largest?.outerFace ?? [];
  }
  const mass = outline.length >= 3 ? ringMoments(outline) : null;
  const list = elements(storey);
  const sumX = list.reduce((s, e) => s + e.kx, 0);
  const sumY = list.reduce((s, e) => s + e.ky, 0);
  const result: BearingResult = {
    elements: list.length,
    centreOfMass: mass?.centre ?? null,
    centreOfStiffness: null,
    eccentricity: null,
    radius: null,
    gyration: mass ? Math.sqrt(mass.polar / mass.area) : null,
    problems: [],
  };
  if (!mass) {
    result.problems.push("The storey has no outline, so its centre of mass is unknown.");
    return result;
  }
  // Compared with the stiffest element, anything below this is nothing.
  const tiny = 1e-9 * Math.max(sumX, sumY, 1e-12);
  if (!(sumX > tiny) || !(sumY > tiny)) {
    const missing = [!(sumX > tiny) && "x", !(sumY > tiny) && "y"].filter(Boolean).join(" and ");
    result.problems.push(`Nothing carries a push along ${missing}.`);
    return result;
  }
  const cs = {
    x: list.reduce((s, e) => s + e.ky * e.at.x, 0) / sumY,
    y: list.reduce((s, e) => s + e.kx * e.at.y, 0) / sumX,
  };
  const torsion = list.reduce((s, e) => s + e.kx * (e.at.y - cs.y) ** 2 + e.ky * (e.at.x - cs.x) ** 2, 0);
  const ecc = { x: Math.abs(cs.x - mass.centre.x), y: Math.abs(cs.y - mass.centre.y) };
  const radius = { x: Math.sqrt(torsion / sumY), y: Math.sqrt(torsion / sumX) };
  result.centreOfStiffness = cs;
  result.eccentricity = ecc;
  result.radius = radius;
  const k = config.maxEccentricityRatio;
  for (const axis of ["x", "y"] as const) {
    if (ecc[axis] > k * radius[axis] + 1e-9) {
      result.problems.push(
        `The centre of stiffness is ${fmt(ecc[axis])} m off the centre of mass along ${axis}; at most ${fmt(k * radius[axis])} m (${k} × torsional radius ${fmt(radius[axis])} m).`,
      );
    }
    if (config.checkGyration && radius[axis] < result.gyration! - 1e-9) {
      result.problems.push(
        `The torsional radius r${axis} is ${fmt(radius[axis])} m, less than the radius of gyration of the floor (${fmt(result.gyration!)} m): the storey twists easily. Put load-bearing walls nearer the outside.`,
      );
    }
  }
  return result;
}
