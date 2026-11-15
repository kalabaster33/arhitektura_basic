/**
 * Automatic windows: every room of a type listed in the rules gets windows in
 * the exterior walls along it, sized by its type and counted from its floor
 * area. Which types, the sizes and the ratio come from a config
 * (src/config/windowRules.json), not from this code.
 */
import { polygonArea } from "./geometry.ts";
import { newId } from "./ids.ts";
import { type Opening, SPACE_TYPES, type SpaceType, type Storey, type Wall } from "./model.ts";
import { addOpening, openingSides, wallFreeSpans } from "./openings.ts";
import { type LinkedSpaces, linkSpaces } from "./spaces.ts";

export interface WindowSpec {
  width: number;
  height: number;
  sill: number;
  /** Most windows one room of this type gets. */
  max: number;
}

export interface WindowRules {
  glazingRatio: number;
  jambClearance: number;
  pier: number;
  minWidth: number;
  types: Partial<Record<SpaceType, WindowSpec>>;
}

export function parseWindowRules(raw: unknown): WindowRules {
  const c = raw as Record<string, unknown>;
  const num = (key: string, min: number): number => {
    const v = c?.[key];
    if (typeof v !== "number" || !(v >= min)) throw new Error(`Window rules: invalid or missing "${key}".`);
    return v;
  };
  const rules: WindowRules = {
    glazingRatio: num("glazingRatio", 0),
    jambClearance: num("jambClearance", 0),
    pier: num("pier", 0),
    minWidth: num("minWidth", 0.01),
    types: {},
  };
  const types = c?.types;
  if (!types || typeof types !== "object") throw new Error('Window rules: invalid or missing "types".');
  for (const [type, value] of Object.entries(types as Record<string, unknown>)) {
    if (!SPACE_TYPES.includes(type as SpaceType)) throw new Error(`Window rules: unknown space type "${type}".`);
    const s = value as WindowSpec;
    const ok =
      s && s.width >= rules.minWidth && s.height > 0 && s.sill >= 0 && Number.isInteger(s.max) && s.max >= 1;
    if (!ok) throw new Error(`Window rules: invalid window for "${type}".`);
    rules.types[type as SpaceType] = { width: s.width, height: s.height, sill: s.sill, max: s.max };
  }
  return rules;
}

/** A stretch of exterior wall along one room where windows may go. */
interface Stretch {
  wall: Wall;
  start: number;
  end: number;
}

const probe = (wall: Wall, offset: number): Opening => ({
  id: "probe",
  wallId: wall.id,
  kind: "window",
  offset,
  width: 0.01,
  height: 1,
  sill: 0,
});

/** The free stretches of exterior wall of each room, keyed by room. */
function facadeStretches(storey: Storey, linked: LinkedSpaces): Map<string, Stretch[]> {
  const out = new Map<string, Stretch[]>();
  for (const wall of storey.walls) {
    if (wall.kind !== "exterior") continue;
    for (const [start, end] of wallFreeSpans(storey, wall)) {
      const [left, right] = openingSides(storey, probe(wall, (start + end) / 2), linked);
      if ((left === null) === (right === null)) continue; // not between a room and outdoors
      const room = (left ?? right)!;
      const list = out.get(room) ?? [];
      list.push({ wall, start, end });
      out.set(room, list);
    }
  }
  return out;
}

/** Room ids that already have a window in an exterior wall. */
function litRooms(storey: Storey, linked: LinkedSpaces): Set<string> {
  const lit = new Set<string>();
  const kind = new Map(storey.walls.map((w) => [w.id, w.kind]));
  for (const o of storey.openings) {
    if (o.kind !== "window" || kind.get(o.wallId) !== "exterior") continue;
    for (const side of openingSides(storey, o, linked)) if (side) lit.add(side);
  }
  return lit;
}

/** Windows in exterior walls that light one of the given rooms. */
export function roomWindowIds(storey: Storey, spaceIds: Iterable<string>, linked = linkSpaces(storey)): string[] {
  const rooms = new Set(spaceIds);
  const kind = new Map(storey.walls.map((w) => [w.id, w.kind]));
  return storey.openings
    .filter(
      (o) =>
        o.kind === "window" &&
        kind.get(o.wallId) === "exterior" &&
        openingSides(storey, o, linked).some((s) => s !== null && rooms.has(s)),
    )
    .map((o) => o.id);
}

/** Removes the windows in exterior walls that light any of the given rooms. */
export function removeRoomWindows(storey: Storey, spaceIds: Iterable<string>): Storey {
  const drop = new Set(roomWindowIds(storey, spaceIds));
  if (drop.size === 0) return storey;
  return { ...storey, openings: storey.openings.filter((o) => !drop.has(o.id)) };
}

/** Where `count` windows of `width` go on stretches of these usable lengths: windows per stretch. */
function share(lengths: number[], count: number, width: number, pier: number): number[] {
  const per = lengths.map(() => 0);
  const fits = (i: number, k: number) => k * width + (k - 1) * pier <= lengths[i] + 1e-9;
  for (let n = 0; n < count; n++) {
    // The stretch that would keep the most wall per window.
    let best = -1;
    let bestRoom = -Infinity;
    lengths.forEach((len, i) => {
      if (!fits(i, per[i] + 1)) return;
      const room = len / (per[i] + 1);
      if (room > bestRoom + 1e-9) {
        bestRoom = room;
        best = i;
      }
    });
    if (best < 0) break;
    per[best]++;
  }
  return per;
}

export interface PlaceWindowsOptions {
  /** Only these rooms; every room of the storey when left out. */
  spaceIds?: string[];
  /**
   * Remove the rooms' present windows in exterior walls first. Otherwise a room
   * that already has one is left as it is.
   */
  replace?: boolean;
  makeId?: (prefix: string) => string;
}

/**
 * Puts windows in the exterior walls of the rooms whose type the rules list.
 * Each room gets enough windows for the glazing ratio (at least one, at most
 * its type's maximum), on its longest free stretches of facade, spread evenly.
 * Rooms with no free facade are left without.
 */
export function placeWindows(storey: Storey, rules: WindowRules, options: PlaceWindowsOptions = {}): Storey {
  const makeId = options.makeId ?? newId;
  let next = storey;
  if (options.replace) {
    const ids = options.spaceIds ?? storey.spaces.filter((s) => rules.types[s.type]).map((s) => s.id);
    next = removeRoomWindows(next, ids);
  }
  const linked = linkSpaces(next);
  const stretches = facadeStretches(next, linked);
  const lit = litRooms(next, linked);
  const wanted = options.spaceIds ? new Set(options.spaceIds) : null;

  for (const space of next.spaces) {
    if (wanted && !wanted.has(space.id)) continue;
    const spec = rules.types[space.type];
    const face = linked.faceBySpaceId.get(space.id);
    if (!spec || !face || lit.has(space.id)) continue;
    const usable = (stretches.get(space.id) ?? [])
      .map((s) => ({ ...s, start: s.start + rules.jambClearance, end: s.end - rules.jambClearance }))
      .filter((s) => s.end - s.start >= rules.minWidth - 1e-9)
      .sort((a, b) => b.end - b.start - (a.end - a.start));
    if (usable.length === 0) continue;

    const area = polygonArea(face.outer, face.holes);
    const count = Math.max(1, Math.min(spec.max, Math.ceil((rules.glazingRatio * area) / (spec.width * spec.height))));
    const lengths = usable.map((s) => s.end - s.start);
    let width = spec.width;
    let per = share(lengths, count, width, rules.pier);
    if (per.every((k) => k === 0)) {
      // Too short a facade for the full size: one narrower window on the longest stretch.
      width = Math.max(rules.minWidth, Math.min(spec.width, lengths[0]));
      per = share(lengths, 1, width, rules.pier);
    }
    usable.forEach((s, i) => {
      const k = per[i];
      const pitch = (s.end - s.start) / k;
      for (let j = 0; j < k; j++) {
        next = addOpening(
          next,
          s.wall.id,
          "window",
          s.start + pitch * (j + 0.5),
          { width, height: spec.height, sill: spec.sill },
          makeId,
        );
      }
    });
  }
  return next;
}
