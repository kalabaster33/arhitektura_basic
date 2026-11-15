/**
 * Auto-layout: runs the room subdivision engine (src/roomSubdivision.ts) on an
 * apartment and turns its answer into ordinary walls, doors and rooms.
 *
 * In: the apartment is emptied of its own partitions, and its outline at the
 * inside wall faces, its facade edges and its entrance door are handed to the
 * engine. Out: the engine's rooms tile that outline; the lines where two rooms
 * meet become partition centrelines, extended to the centrelines of the walls
 * around the apartment so they join them. A proposal whose walls do not give
 * exactly the rooms the engine meant is thrown away, never applied.
 *
 * The sizes the engine works to come from a config
 * (src/config/layoutRules.json), not from this code.
 */
import {
  ADJACENCY_KINDS,
  type AdjacencyRule,
  type ApartmentInput,
  type CirculationRules,
  type Layout,
  RULE_ROOMS,
  type RoomProgram,
  type RoomSize,
  type RoomType,
  type RuleCheck,
  SIZED_ROOMS,
  type SizedRoom,
  type SubdivisionOptions,
  facadeShortfall,
  generateLayouts,
} from "../roomSubdivision.ts";
import { describeApartments } from "./apartments.ts";
import { addWall, deleteWall, updateSpace } from "./edit.ts";
import {
  type Pt,
  dist,
  distToSegment,
  interiorPoint,
  lineIntersectionParams,
  pointInPolygon,
  roundTo,
} from "./geometry.ts";
import type { LayoutRulesDoc, SpaceType, Storey, Wall } from "./model.ts";
import { type OpeningSize, addOpening, locateOnWall, openingSides } from "./openings.ts";
import { type WindowRules, placeWindows, removeRoomWindows } from "./windows.ts";
import { type LinkedSpaces, linkSpaces } from "./spaces.ts";

export type LayoutRules = Partial<SubdivisionOptions>;

const NUMBER_RULES = [
  "maxBedroomAspect",
  "maxBathroomAspect",
  "minCorridorArea",
  "doorWidth",
  "entranceClearance",
  "minLivingFacade",
  "minBedroomFacade",
  "bedroomShare",
  "bathroomShare",
] as const;
const RANGE_RULES = ["bedroomAreaRange", "bathroomAreaRange"] as const;

/** Checks rules loaded from JSON; throws with the offending key. */
export function parseLayoutRules(raw: unknown): LayoutRules {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== "object") throw new Error("Layout rules: not an object.");
  const rules: LayoutRules = {};
  for (const key of NUMBER_RULES) {
    const v = c[key];
    if (typeof v !== "number" || !(v > 0)) throw new Error(`Layout rules: invalid or missing "${key}".`);
    rules[key] = v;
  }
  for (const key of RANGE_RULES) {
    const v = c[key];
    const ok =
      Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && x > 0) && v[0] <= v[1];
    if (!ok) throw new Error(`Layout rules: invalid or missing "${key}".`);
    rules[key] = [v[0], v[1]] as [number, number];
  }

  // Room sizes.
  const rooms = c.rooms as Record<string, RoomSize> | undefined;
  if (!rooms || typeof rooms !== "object") throw new Error('Layout rules: invalid or missing "rooms".');
  const sizes = {} as Record<SizedRoom, RoomSize>;
  for (const kind of SIZED_ROOMS) {
    const r = rooms[kind];
    const ok = r && typeof r.minArea === "number" && r.minArea >= 0 && typeof r.minWidth === "number" && r.minWidth > 0;
    if (!ok) throw new Error(`Layout rules: invalid or missing size for "${kind}" in "rooms".`);
    sizes[kind] = { minArea: r.minArea, minWidth: r.minWidth };
  }
  for (const kind of Object.keys(rooms)) {
    if (!SIZED_ROOMS.includes(kind as SizedRoom)) throw new Error(`Layout rules: unknown room "${kind}" in "rooms".`);
  }
  rules.roomSizes = sizes;

  // Adjacency.
  if (!Array.isArray(c.adjacency)) throw new Error('Layout rules: invalid or missing "adjacency".');
  rules.adjacency = c.adjacency.map((raw, i): AdjacencyRule => {
    const r = raw as AdjacencyRule;
    const where = `adjacency rule ${i + 1}`;
    if (!r || !RULE_ROOMS.includes(r.a) || !RULE_ROOMS.includes(r.b)) {
      throw new Error(`Layout rules: ${where} names an unknown room (use ${RULE_ROOMS.join(", ")}).`);
    }
    if (!ADJACENCY_KINDS.includes(r.rule)) {
      throw new Error(`Layout rules: ${where} has an unknown rule (use ${ADJACENCY_KINDS.join(", ")}).`);
    }
    if (r.a === "entrance" || r.a === "living" || r.a === "corridor") {
      if (r.rule === "opensTo" || r.rule === "notOpensTo") {
        throw new Error(`Layout rules: ${where}: only a room with a door of its own can have a door rule.`);
      }
    }
    if (r.a === "entrance") throw new Error(`Layout rules: ${where}: put the entrance second.`);
    if (typeof r.weight !== "number" || !(r.weight >= 0)) throw new Error(`Layout rules: ${where} has an invalid weight.`);
    if (typeof r.text !== "string" || r.text.trim() === "") throw new Error(`Layout rules: ${where} needs a text.`);
    return { a: r.a, b: r.b, rule: r.rule, weight: r.weight, hard: r.hard === true, text: r.text };
  });

  // Circulation.
  const circ = c.circulation as Record<string, unknown> | undefined;
  if (!circ || typeof circ !== "object") throw new Error('Layout rules: invalid or missing "circulation".');
  const cnum = (key: keyof CirculationRules, positive: boolean): number => {
    const v = circ[key];
    if (typeof v !== "number" || !(positive ? v > 0 : v >= 0)) {
      throw new Error(`Layout rules: invalid or missing "circulation.${key}".`);
    }
    return v;
  };
  rules.circulation = {
    walkWeight: cnum("walkWeight", false),
    maxWalk: cnum("maxWalk", true),
    nightZone: cnum("nightZone", false),
    maxCorridorShare: cnum("maxCorridorShare", true),
    nearDistance: cnum("nearDistance", true),
  };
  return rules;
}

/** The editable part of a rules file: room sizes, adjacency and walking. */
export function rulesDoc(raw: unknown): LayoutRulesDoc {
  const c = raw as LayoutRulesDoc;
  return structuredClone({ rooms: c.rooms, adjacency: c.adjacency, circulation: c.circulation });
}

/**
 * The rules a project works to: the config, with the project's own room
 * sizes, adjacency and walking rules in place of the config's when they pass
 * the checks. `error` says why they did not.
 */
export function resolveLayoutRules(config: unknown, own?: LayoutRulesDoc): { rules: LayoutRules; error?: string } {
  const base = parseLayoutRules(config);
  if (!own) return { rules: base };
  try {
    return { rules: parseLayoutRules({ ...(config as object), ...own }) };
  } catch (e) {
    return { rules: base, error: e instanceof Error ? e.message : String(e) };
  }
}

const PROBE = 0.01;

function spaceAt(storey: Storey, linked: LinkedSpaces, p: Pt): string | null {
  for (const space of storey.spaces) {
    const face = linked.faceBySpaceId.get(space.id);
    if (face && pointInPolygon(p, face.outer, face.holes)) return space.id;
  }
  return null;
}

/**
 * Walls that lie wholly inside the apartment: its rooms on both sides, all the
 * way along. These are the partitions a new layout replaces.
 */
export function apartmentInteriorWalls(
  storey: Storey,
  apartmentId: string,
  linked: LinkedSpaces = linkSpaces(storey),
): string[] {
  const apartment = storey.apartments.find((a) => a.id === apartmentId);
  if (!apartment) return [];
  const members = new Set(apartment.spaceIds);
  const candidates = new Set<string>();
  for (const id of apartment.spaceIds) {
    for (const wallId of linked.faceBySpaceId.get(id)?.wallIds ?? []) candidates.add(wallId);
  }
  const inside = (p: Pt) => {
    const id = spaceAt(storey, linked, p);
    return id !== null && members.has(id);
  };
  return storey.walls
    .filter((w) => {
      if (!candidates.has(w.id)) return false;
      const length = dist(w.a, w.b);
      const n = { x: -(w.b.y - w.a.y) / length, y: (w.b.x - w.a.x) / length };
      return [0.25, 0.5, 0.75].every((t) => {
        const m = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
        return (
          inside({ x: m.x + n.x * PROBE, y: m.y + n.y * PROBE }) &&
          inside({ x: m.x - n.x * PROBE, y: m.y - n.y * PROBE })
        );
      });
    })
    .map((w) => w.id);
}

export type LayoutInput =
  | {
      ok: true;
      /** The storey with the apartment's own partitions removed. */
      shell: Storey;
      /** The one room the emptied apartment consists of. */
      spaceId: string;
      input: ApartmentInput;
    }
  | { ok: false; reason: string };

/** What the engine needs to know about an apartment, or why it cannot run. */
export function buildLayoutInput(storey: Storey, apartmentId: string): LayoutInput {
  const no = (reason: string): LayoutInput => ({ ok: false, reason });
  const apartment = storey.apartments.find((a) => a.id === apartmentId);
  if (!apartment) return no("No such apartment.");
  if (apartment.spaceIds.length === 0) return no("It has no rooms yet.");

  let shell = storey;
  for (const id of apartmentInteriorWalls(storey, apartmentId)) shell = deleteWall(shell, id);
  const emptied = shell.apartments.find((a) => a.id === apartmentId)!;
  if (emptied.spaceIds.length !== 1) {
    return no("Its rooms do not adjoin, or a wall between them also bounds another room.");
  }
  const spaceId = emptied.spaceIds[0];
  const linked = linkSpaces(shell);
  const face = linked.faceBySpaceId.get(spaceId);
  if (!face || !(face.netArea > 0)) return no("It has no floor area.");
  if (face.holes.length > 0) return no("It encloses another room, which the generator cannot work around.");

  const polygon = face.netOuter;
  const walls = shell.walls.filter((w) => face.wallIds.includes(w.id));
  const facadeEdges: number[] = [];
  polygon.forEach((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    if (dist(p, q) < 1e-6) return;
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    // The wall this edge is the inside face of.
    let best: Wall | null = null;
    let bestMiss = Infinity;
    for (const w of walls) {
      const miss = Math.abs(distToSegment(mid, w.a, w.b) - w.thickness / 2);
      if (miss < bestMiss) {
        bestMiss = miss;
        best = w;
      }
    }
    if (best?.kind === "exterior") facadeEdges.push(i);
  });
  if (facadeEdges.length === 0) return no("It has no exterior wall, so no room would get daylight.");

  const info = describeApartments(shell, linked).find((a) => a.apartmentId === apartmentId)!;
  if (info.entrances.length === 0) return no("It has no entrance door.");

  const input: ApartmentInput = { polygon, facadeEdges, entrance: info.entrances[0].position };
  const shaft = shell.spaces.find(
    (s) =>
      s.type === "shaft" &&
      s.id !== spaceId &&
      linked.faceBySpaceId.get(s.id)?.wallIds.some((id) => face.wallIds.includes(id)),
  );
  if (shaft) input.plumbingStack = shaft.anchor;
  return { ok: true, shell, spaceId, input };
}

export interface ApplyOptions {
  /** Thickness of the partitions that are created. */
  partitionThickness: number;
  /** Height of the doors that are created (their width comes from the rules). */
  door: OpeningSize;
  /** Grid step; partitions of a square-set apartment are put on it. */
  snap: number;
  /**
   * When given, the apartment's windows in exterior walls are replaced by new
   * ones placed by these rules, room by room.
   */
  windows?: WindowRules;
}

const ROOM_LABEL: Record<RoomType, { name: string; type: SpaceType }> = {
  living: { name: "Living room", type: "living" },
  bedroom: { name: "Bedroom", type: "bedroom" },
  bathroom: { name: "Bathroom", type: "bathroom" },
  wc: { name: "WC", type: "bathroom" },
  kitchen: { name: "Kitchen", type: "kitchen" },
  storage: { name: "Storage", type: "storage" },
  corridor: { name: "Corridor", type: "corridor" },
};
const ROOM_RANK: RoomType[] = ["living", "bedroom", "kitchen", "bathroom", "wc", "storage", "corridor"];

const micro = (v: number) => Math.round(v * 1e6) / 1e6;

/** Direction of the engine's grid: along the longest facade edge. */
function gridAngle(input: ApartmentInput): number {
  const n = input.polygon.length;
  let theta = 0;
  let longest = -1;
  for (const raw of new Set(input.facadeEdges.map((i) => ((i % n) + n) % n))) {
    const a = input.polygon[raw];
    const b = input.polygon[(raw + 1) % n];
    const length = dist(a, b);
    if (length > longest) {
      longest = length;
      theta = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return theta;
}

/**
 * Centrelines of the partitions a layout calls for: every stretch where two
 * different rooms meet. Rooms joined by a doorless opening count as one room,
 * so no wall is drawn between them.
 */
function partitionLines(layout: Layout, input: ApartmentInput, groupOf: Map<string, number>): [Pt, Pt][] {
  const theta = gridAngle(input);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const toLocal = (p: Pt): Pt => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos });
  const toWorld = (p: Pt): Pt => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });

  const rooms = layout.rooms.map((r) => ({
    group: groupOf.get(r.id)!,
    outer: r.polygon.map(toLocal),
    holes: r.holes.map((h) => h.map(toLocal)),
  }));
  const groupAt = (p: Pt): number | null => {
    for (const r of rooms) if (pointInPolygon(p, r.outer, r.holes)) return r.group;
    return null;
  };

  // Room edges by the grid line they lie on. Edges at an angle to the grid can
  // only be the apartment's own outline, so they are of no interest here.
  const byLine = new Map<string, { vertical: boolean; line: number; spans: [number, number][] }>();
  for (const r of rooms) {
    for (const ring of [r.outer, ...r.holes]) {
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const vertical = Math.abs(a.x - b.x) < 1e-6;
        if (!vertical && Math.abs(a.y - b.y) >= 1e-6) return;
        const line = micro(vertical ? a.x : a.y);
        const from = micro(vertical ? a.y : a.x);
        const to = micro(vertical ? b.y : b.x);
        const key = `${vertical ? "v" : "h"}${line}`;
        const entry = byLine.get(key) ?? { vertical, line, spans: [] };
        entry.spans.push([Math.min(from, to), Math.max(from, to)]);
        byLine.set(key, entry);
      });
    }
  }

  const SIDE = 0.02;
  const lines: [Pt, Pt][] = [];
  for (const { vertical, line, spans } of byLine.values()) {
    const at = (t: number, off = 0): Pt => (vertical ? { x: line + off, y: t } : { x: t, y: line + off });
    const stops = [...new Set(spans.flat())].sort((p, q) => p - q);
    let run: [number, number] | null = null;
    const flush = () => {
      if (run) lines.push([toWorld(at(run[0])), toWorld(at(run[1]))]);
      run = null;
    };
    for (let i = 0; i + 1 < stops.length; i++) {
      const s = stops[i];
      const e = stops[i + 1];
      const mid = (s + e) / 2;
      const left = groupAt(at(mid, -SIDE));
      const right = groupAt(at(mid, SIDE));
      const isWall =
        e - s > 1e-6 &&
        spans.some(([from, to]) => from <= s + 1e-9 && to >= e - 1e-9) &&
        left !== null &&
        right !== null &&
        left !== right;
      if (!isWall) flush();
      else if (run) run[1] = e;
      else run = [s, e];
    }
    flush();
  }

  return lines.map(
    ([a, b]) =>
      [
        { x: micro(a.x), y: micro(a.y) },
        { x: micro(b.x), y: micro(b.y) },
      ] as [Pt, Pt],
  );
}

/**
 * Turns one layout into walls, doors and rooms on the emptied storey. Null
 * when the result would not be exactly the rooms the layout describes.
 */
export function applyLayout(
  shell: Storey,
  apartmentId: string,
  input: ApartmentInput,
  layout: Layout,
  options: ApplyOptions,
): Storey | null {
  // Rooms joined by a doorless opening are one room in the plan.
  const group = new Map(layout.rooms.map((r, i) => [r.id, i]));
  for (const door of layout.doors) {
    if (door.kind !== "opening" || door.rooms.length !== 2) continue;
    const [a, b] = door.rooms.map((id) => group.get(id));
    if (a === undefined || b === undefined) return null;
    for (const [id, g] of group) if (g === b) group.set(id, a);
  }
  const groups = [...new Set(group.values())];

  let lines = partitionLines(layout, input, group);
  // On a square-set apartment the partitions go on the drawing grid.
  const square = Math.abs(Math.sin(2 * gridAngle(input))) < 1e-9;
  if (square && options.snap > 0) {
    const s = (p: Pt): Pt => ({ x: roundTo(p.x, options.snap), y: roundTo(p.y, options.snap) });
    lines = lines.map(([a, b]) => [s(a), s(b)] as [Pt, Pt]).filter(([a, b]) => dist(a, b) > 1e-6);
  }

  // A partition that ends at the apartment's edge stops at the inside wall
  // face; carry it on to that wall's centreline so the two walls join.
  const reach = Math.max(...shell.walls.map((w) => w.thickness)) / 2 + 0.15;
  const extended = lines.map(([a, b], index) => {
    const stretch = (end: Pt, other: Pt): Pt => {
      const joined = lines.some(
        ([p, q], j) => j !== index && distToSegment(end, p, q) <= 1e-6,
      );
      if (joined) return end;
      const length = dist(other, end);
      const d = { x: (end.x - other.x) / length, y: (end.y - other.y) / length };
      let best: number | null = null;
      for (const w of shell.walls) {
        const x = lineIntersectionParams(end, { x: end.x + d.x, y: end.y + d.y }, w.a, w.b);
        if (!x) continue;
        const slack = 1e-6 / dist(w.a, w.b);
        if (x.u < -slack || x.u > 1 + slack || x.t < -0.03 || x.t > reach) continue;
        if (best === null || x.t < best) best = x.t;
      }
      return best === null ? end : { x: micro(end.x + d.x * best), y: micro(end.y + d.y * best) };
    };
    return [stretch(a, b), stretch(b, a)] as [Pt, Pt];
  });

  let storey = shell;
  for (const [a, b] of extended) storey = addWall(storey, a, b, options.partitionThickness, "interior");
  const before = new Set(shell.walls.map((w) => w.id));
  const partitions = storey.walls.filter((w) => !before.has(w.id));

  // Each room of the layout must now be a room of the plan, and nothing else
  // may have appeared inside the apartment.
  const linked = linkSpaces(storey);
  const spaceOfGroup = new Map<number, string>();
  const labelOfGroup = new Map<number, RoomType>();
  for (const g of groups) {
    const members = layout.rooms.filter((r) => group.get(r.id) === g);
    const lead = members.slice().sort((p, q) => ROOM_RANK.indexOf(p.type) - ROOM_RANK.indexOf(q.type))[0];
    const spaceId = spaceAt(storey, linked, interiorPoint(lead.polygon, lead.holes));
    if (spaceId === null || [...spaceOfGroup.values()].includes(spaceId)) return null;
    spaceOfGroup.set(g, spaceId);
    labelOfGroup.set(g, lead.type);
  }
  const inApartment = storey.spaces.filter(
    (s) => linked.faceBySpaceId.has(s.id) && pointInPolygon(s.anchor, input.polygon),
  );
  if (inApartment.length !== groups.length) return null;

  // Several rooms of one kind are numbered: Bedroom 1, Bedroom 2.
  const ofKind = new Map<RoomType, number>();
  for (const g of groups) ofKind.set(labelOfGroup.get(g)!, (ofKind.get(labelOfGroup.get(g)!) ?? 0) + 1);
  const numbered = new Map<RoomType, number>();
  for (const g of groups) {
    const kind = labelOfGroup.get(g)!;
    const base = ROOM_LABEL[kind];
    const n = (numbered.get(kind) ?? 0) + 1;
    numbered.set(kind, n);
    const name = (ofKind.get(kind) ?? 0) > 1 ? `${base.name} ${n}` : base.name;
    storey = updateSpace(storey, spaceOfGroup.get(g)!, { ...base, name });
  }
  storey = {
    ...storey,
    apartments: storey.apartments.map((a) => {
      const rest = a.spaceIds.filter((id) => ![...spaceOfGroup.values()].includes(id));
      return a.id === apartmentId ? { ...a, spaceIds: [...spaceOfGroup.values()] } : { ...a, spaceIds: rest };
    }),
  };

  for (const door of layout.doors) {
    if (door.kind !== "door" || door.rooms.length !== 2) continue;
    const hit = locateOnWall({ ...storey, walls: partitions }, door.position, 0.15);
    if (!hit) return null;
    const next = addOpening(storey, hit.wallId, "door", hit.offset, {
      width: door.width,
      height: options.door.height,
      sill: 0,
    });
    if (next === storey) return null;
    storey = next;
    const sides = openingSides(storey, storey.openings[storey.openings.length - 1]);
    const wanted = door.rooms.map((id) => spaceOfGroup.get(group.get(id)!));
    if (!wanted.every((id) => id !== undefined && sides.includes(id)) || sides[0] === sides[1]) {
      return null;
    }
  }

  // The partitions must not have pushed the entrance door out of the apartment.
  const info = describeApartments(storey).find((a) => a.apartmentId === apartmentId);
  if (!info || info.entrances.length === 0 || info.pieces !== 1) return null;
  return storey;
}

export interface LayoutProposal {
  /** The storey as it would be with this layout applied. */
  storey: Storey;
  /** The rooms it creates, as named in the plan. */
  rooms: string[];
  /** 1 when every minimum in the rules was kept; lower when they were scaled by this. */
  relaxation: number;
  /** How the layout fares against each size, adjacency and circulation rule. */
  checks: RuleCheck[];
}

export type LayoutProposals =
  | { ok: true; proposals: LayoutProposal[] }
  | { ok: false; reason: string };

/** Up to `count` layouts for the apartment, best first, each ready to apply. */
export function proposeLayouts(
  storey: Storey,
  apartmentId: string,
  rules: LayoutRules,
  options: ApplyOptions,
  count = 3,
  program?: RoomProgram,
): LayoutProposals {
  const built = buildLayoutInput(storey, apartmentId);
  if (!built.ok) return built;
  const engineOptions = { ...rules, ...(program ? { program } : {}), wallThickness: 0, kitchen: false };
  // The old windows would block or straddle the new partitions.
  const shortfall = facadeShortfall(built.input, engineOptions);
  if (shortfall) return { ok: false, reason: `${shortfall} Try fewer rooms or a wider facade.` };
  const shell = options.windows ? removeRoomWindows(built.shell, [built.spaceId]) : built.shell;
  const proposals: LayoutProposal[] = [];
  let layouts: Layout[] = [];
  // Some layouts cannot be drawn as clean walls (mostly on plans not square
  // to the axes); when none of the first few can, a wider set is tried.
  for (const asked of [count, count * 4]) {
    try {
      // Thickness 0: the engine's rooms then meet on the partition centrelines.
      layouts = generateLayouts(built.input, engineOptions, asked);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    for (const layout of layouts) {
      if (proposals.length >= count) break;
      let applied = applyLayout(shell, apartmentId, built.input, layout, options);
      if (!applied) continue;
      if (options.windows) {
        const spaceIds = applied.apartments.find((a) => a.id === apartmentId)!.spaceIds;
        applied = placeWindows(applied, options.windows, { spaceIds });
      }
      const apartment = applied.apartments.find((a) => a.id === apartmentId)!;
      proposals.push({
        storey: applied,
        rooms: apartment.spaceIds.map((id) => applied.spaces.find((s) => s.id === id)!.name),
        relaxation: layout.relaxation,
        checks: layout.checks,
      });
    }
    if (proposals.length > 0 || layouts.length < asked) break;
  }
  if (proposals.length === 0) {
    return {
      ok: false,
      reason:
        layouts.length === 0
          ? program
            ? "It cannot fit this room programme with daylight in the living room and bedrooms. Try fewer rooms or a larger apartment."
            : "It cannot fit a living room and a bedroom with daylight plus a bathroom."
          : "The generator found layouts, but none could be drawn as clean walls here.",
    };
  }
  return { ok: true, proposals };
}
