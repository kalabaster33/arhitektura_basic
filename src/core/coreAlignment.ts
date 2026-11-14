/**
 * Vertical core check: stairs, elevators and shafts must sit in the same place
 * on every floor. Compares each storey with the one directly above it.
 * Which space types count and how much play is allowed come from a config
 * (src/config/coreAlignment.json), not from this code.
 */
import { sortedStoreys } from "./building.ts";
import { type Pt, distToSegment, pointInRing } from "./geometry.ts";
import { type Building, type SpaceType, type Storey, SPACE_TYPES } from "./model.ts";
import { linkSpaces } from "./spaces.ts";

export interface CoreConfig {
  coreSpaceTypes: SpaceType[];
  tolerance: number;
}

export function parseCoreConfig(raw: unknown): CoreConfig {
  const c = raw as CoreConfig;
  if (!c || !Array.isArray(c.coreSpaceTypes) || c.coreSpaceTypes.length === 0) {
    throw new Error('Core alignment: invalid or missing "coreSpaceTypes".');
  }
  for (const t of c.coreSpaceTypes) {
    if (!SPACE_TYPES.includes(t)) throw new Error(`Core alignment: unknown space type "${t}".`);
  }
  if (typeof c.tolerance !== "number" || !(c.tolerance >= 0)) {
    throw new Error('Core alignment: invalid or missing "tolerance".');
  }
  return { coreSpaceTypes: [...c.coreSpaceTypes], tolerance: c.tolerance };
}

/** One core space on one storey, with its outline at the inside wall faces. */
export interface CoreOutline {
  storeyId: string;
  spaceId: string;
  name: string;
  type: SpaceType;
  outline: Pt[];
  anchor: Pt;
}

export function coreOutlines(storey: Storey, config: CoreConfig): CoreOutline[] {
  const { faceBySpaceId } = linkSpaces(storey);
  const out: CoreOutline[] = [];
  for (const space of storey.spaces) {
    if (!config.coreSpaceTypes.includes(space.type)) continue;
    const face = faceBySpaceId.get(space.id);
    if (!face) continue;
    out.push({
      storeyId: storey.id,
      spaceId: space.id,
      name: space.name,
      type: space.type,
      outline: face.netArea > 0 ? face.netOuter : face.outer,
      anchor: space.anchor,
    });
  }
  return out;
}

function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, distToSegment(p, ring[i], ring[(i + 1) % ring.length]));
  }
  return best;
}

/**
 * How far apart two outlines are: the largest distance from a corner of either
 * one to the other outline. Zero when they coincide; equal to the shift when
 * one is a moved copy of the other.
 */
export function outlineDeviation(a: Pt[], b: Pt[]): number {
  let worst = 0;
  for (const p of a) worst = Math.max(worst, distToRing(p, b));
  for (const p of b) worst = Math.max(worst, distToRing(p, a));
  return worst;
}

export interface CoreIssue {
  /** misaligned: both floors have it, in different places. missing: one floor lacks it. */
  kind: "misaligned" | "missing";
  type: SpaceType;
  /** The space the warning is about. */
  storeyId: string;
  spaceId: string;
  /** The neighbouring storey it was compared with, and its counterpart if any. */
  otherStoreyId: string;
  otherSpaceId?: string;
  /** For misaligned: how far apart the outlines are, in metres. */
  deviation?: number;
  message: string;
}

export function checkCoreAlignment(building: Building, config: CoreConfig): CoreIssue[] {
  const issues: CoreIssue[] = [];
  const storeys = sortedStoreys(building);
  const outlines = storeys.map((s) => coreOutlines(s, config));
  for (let i = 0; i + 1 < storeys.length; i++) {
    const below = storeys[i];
    const above = storeys[i + 1];
    // Candidate pairs: same type and overlapping in plan. Closest pairs are matched first.
    const pairs: { a: CoreOutline; b: CoreOutline; deviation: number }[] = [];
    for (const a of outlines[i]) {
      for (const b of outlines[i + 1]) {
        if (a.type !== b.type) continue;
        const deviation = outlineDeviation(a.outline, b.outline);
        const overlap =
          deviation <= config.tolerance ||
          pointInRing(a.anchor, b.outline) ||
          pointInRing(b.anchor, a.outline);
        if (overlap) pairs.push({ a, b, deviation });
      }
    }
    pairs.sort((p, q) => p.deviation - q.deviation);
    const matched = new Set<string>();
    for (const { a, b, deviation } of pairs) {
      if (matched.has(a.spaceId) || matched.has(b.spaceId)) continue;
      matched.add(a.spaceId);
      matched.add(b.spaceId);
      if (deviation <= config.tolerance) continue;
      issues.push({
        kind: "misaligned",
        type: b.type,
        storeyId: above.id,
        spaceId: b.spaceId,
        otherStoreyId: below.id,
        otherSpaceId: a.spaceId,
        deviation,
        message: `${b.type} "${b.name}" on ${above.name} is ${deviation.toFixed(2)} m off the ${a.type} "${a.name}" on ${below.name}.`,
      });
    }
    for (const a of outlines[i]) {
      if (matched.has(a.spaceId)) continue;
      issues.push({
        kind: "missing",
        type: a.type,
        storeyId: below.id,
        spaceId: a.spaceId,
        otherStoreyId: above.id,
        message: `${a.type} "${a.name}" on ${below.name} has no ${a.type} above it on ${above.name}.`,
      });
    }
    for (const b of outlines[i + 1]) {
      if (matched.has(b.spaceId)) continue;
      issues.push({
        kind: "missing",
        type: b.type,
        storeyId: above.id,
        spaceId: b.spaceId,
        otherStoreyId: below.id,
        message: `${b.type} "${b.name}" on ${above.name} has no ${b.type} below it on ${below.name}.`,
      });
    }
  }
  return issues;
}
