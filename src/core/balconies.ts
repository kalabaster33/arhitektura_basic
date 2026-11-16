/**
 * Balconies against the plot: a balcony stands out from the facade, so it can
 * come closer to the plot edge than the building. Each one must stay on the
 * plot and keep the setback of every plot edge, less how far a balcony is
 * allowed to reach into it (src/config/balconies.json). Loggias lie inside the
 * building outline and are checked with the building (see site.ts).
 * Pure functions, no UI imports.
 */
import { type Pt, distToSegment, lineIntersectionParams, pointInRing } from "./geometry.ts";
import type { Balcony, Building, Site } from "./model.ts";
import { balconyOutline, placeableBalconies } from "./structure.ts";

export interface BalconyConfig {
  width: number;
  depth: number;
  railing: number;
  maxIntoSetback: number;
}

export function parseBalconyConfig(raw: unknown): BalconyConfig {
  const c = raw as Partial<BalconyConfig> | null;
  const out = {} as BalconyConfig;
  for (const key of ["width", "depth", "railing", "maxIntoSetback"] as const) {
    const v = c?.[key];
    const ok = typeof v === "number" && Number.isFinite(v) && (key === "maxIntoSetback" ? v >= 0 : v > 0);
    if (!ok) throw new Error(`Balconies: invalid or missing "${key}".`);
    out[key] = v;
  }
  return out;
}

/** Shortest distance between a closed ring and a segment; 0 where they touch or cross. */
function ringToSegment(ring: Pt[], a: Pt, b: Pt): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const x = lineIntersectionParams(p, q, a, b);
    if (x && x.t >= 0 && x.t <= 1 && x.u >= 0 && x.u <= 1) return 0;
    best = Math.min(best, distToSegment(p, a, b), distToSegment(a, p, q), distToSegment(b, p, q));
  }
  return best;
}

export interface BalconyIssue {
  balconyId: string;
  message: string;
}

/** Label used in messages: "Balcony 2 on side 3". */
export function balconyLabel(list: Balcony[], b: Balcony): string {
  const same = list.filter((o) => o.kind === b.kind);
  const name = b.kind === "balcony" ? "Balcony" : "Loggia";
  return `${name}${same.length > 1 ? ` ${same.indexOf(b) + 1}` : ""} on side ${b.edge + 1}`;
}

/** Balconies that leave the plot or come too close to one of its edges. */
export function balconySiteIssues(site: Pick<Site, "boundary" | "setbacks">, building: Building, config: BalconyConfig): BalconyIssue[] {
  const plot = site.boundary;
  if (plot.length < 3) return [];
  const all = building.structure.balconies ?? [];
  const issues: BalconyIssue[] = [];
  for (const b of placeableBalconies(building.structure)) {
    if (b.kind !== "balcony") continue;
    const ring = balconyOutline(building.structure, b);
    const label = balconyLabel(all, b);
    if (!ring.every((p) => pointInRing(p, plot))) {
      issues.push({ balconyId: b.id, message: `${label} reaches beyond the plot outline.` });
      continue;
    }
    let worst: { edge: number; distance: number; need: number } | null = null;
    plot.forEach((p, j) => {
      const need = Math.max(0, (site.setbacks[j] ?? 0) - config.maxIntoSetback);
      if (need <= 0) return;
      const distance = ringToSegment(ring, p, plot[(j + 1) % plot.length]);
      if (distance < need - 1e-6 && (!worst || need - distance > worst.need - worst.distance)) {
        worst = { edge: j, distance, need };
      }
    });
    if (worst) {
      const w = worst as { edge: number; distance: number; need: number };
      issues.push({
        balconyId: b.id,
        message: `${label} is ${w.distance.toFixed(2)} m from plot edge ${w.edge + 1}; it must keep at least ${w.need.toFixed(2)} m.`,
      });
    }
  }
  return issues;
}
