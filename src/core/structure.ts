/**
 * The building before its apartments: the outline of the ground floor, the
 * erker (how far the floors above project beyond it), and the hall, stairs and
 * elevator. The outside walls and the core walls of every storey are generated
 * from this, so changing the outline or the erker redraws every floor.
 *
 * Generated walls carry `part` and an id made from their storey, so doors and
 * windows placed in them survive a rebuild. Walls drawn by hand (the
 * apartments) are left alone. Pure functions on the project, no UI imports.
 */
import { sortedStoreys } from "./building.ts";
import { applyWalls } from "./edit.ts";
import {
  type Pt,
  dist,
  distToSegment,
  offsetRingLeft,
  pointInPolygon,
  pointInRing,
  projectParam,
  ringSignedArea,
  samePoint,
} from "./geometry.ts";
import { newId } from "./ids.ts";
import {
  type Balcony,
  type Building,
  type Column,
  type CoreElement,
  type Opening,
  type CoreKind,
  type Project,
  type SpaceType,
  type Stage,
  type Storey,
  type Structure,
  type Wall,
  STAGES,
} from "./model.ts";
import { type OpeningSize, addOpening, locateOnWall, openingSides, reconcileOpenings } from "./openings.ts";
import { boundaryProblem } from "./site.ts";
import { type LinkedSpaces, linkSpaces, syncCirculation } from "./spaces.ts";

const round = (v: number) => Math.round(v * 1e6) / 1e6;
const roundPt = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });

/** A hall, stair or elevator narrower than this is a slip of the hand, not a room. */
export const MIN_CORE_SIZE = 0.5;

// ------------------------------------------------------------------- outlines

/** The ring with its interior on the left of its edges. */
function leftHanded(ring: Pt[]): Pt[] {
  return ringSignedArea(ring) >= 0 ? ring : ring.slice().reverse();
}

/**
 * Outline of the storeys above the ground floor at the outside wall faces:
 * the footprint with every erker side moved outward by the erker depth.
 */
export function upperOutline(structure: Structure): Pt[] {
  const ring = structure.footprint;
  const n = ring.length;
  const { depth, edges } = structure.erker;
  if (n < 3 || !(depth > 0) || !edges.some(Boolean)) return ring;
  // Reversed, the outside is on the left of every edge. Edge j of the reversed
  // ring is edge n - 2 - j of the footprint.
  const reversed = ring.slice().reverse();
  const d = reversed.map((_, j) => (edges[(2 * n - 2 - j) % n] ? depth : 0));
  return offsetRingLeft(reversed, d).reverse().map(roundPt);
}

// ------------------------------------------------------- balconies and loggias

/** A balcony narrower than this is a slip of the hand. */
export const MIN_BALCONY_WIDTH = 0.5;

/**
 * Side `edge` of the outline as it is on the storeys above the ground floor:
 * where the facade line starts (beyond the erker, where that side has one),
 * the unit direction along it, the unit normal pointing outdoors, and the
 * length of the side on the ground floor.
 */
export function facadeLine(structure: Structure, edge: number): { a: Pt; u: Pt; out: Pt; length: number } | null {
  const fp = structure.footprint;
  const n = fp.length;
  if (n < 3 || !(edge >= 0 && edge < n)) return null;
  const a = fp[edge];
  const b = fp[(edge + 1) % n];
  const length = dist(a, b);
  if (length < 1e-9) return null;
  const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  // The footprint has its interior on the left, so outdoors is on the right.
  const out = { x: u.y, y: -u.x };
  const d = structure.erker.depth > 0 && structure.erker.edges[edge] ? structure.erker.depth : 0;
  return { a: { x: a.x + out.x * d, y: a.y + out.y * d }, u, out, length };
}

/** A point `along` a facade line and `outward` from it (negative: into the building). */
function facadePoint(line: { a: Pt; u: Pt; out: Pt }, along: number, outward: number): Pt {
  return roundPt({
    x: line.a.x + line.u.x * along + line.out.x * outward,
    y: line.a.y + line.u.y * along + line.out.y * outward,
  });
}

/**
 * The outline of a balcony to its outer faces (standing out from the facade),
 * or of a loggia (reaching into the building from the facade line). Interior
 * on the left. Empty when its side does not exist.
 */
export function balconyOutline(structure: Structure, b: Balcony): Pt[] {
  const line = facadeLine(structure, b.edge);
  if (!line) return [];
  const h = b.kind === "balcony" ? b.depth : -b.depth;
  return leftHanded([
    facadePoint(line, b.offset, 0),
    facadePoint(line, b.offset + b.width, 0),
    facadePoint(line, b.offset + b.width, h),
    facadePoint(line, b.offset, h),
  ]);
}

/** The edge of a ring both points lie on, or -1. */
function ringEdgeHolding(ring: Pt[], p: Pt, q: Pt): number {
  return ring.findIndex((r, k) => {
    const s = ring[(k + 1) % ring.length];
    return distToSegment(p, r, s) <= 1e-6 && distToSegment(q, r, s) <= 1e-6;
  });
}

/** Why a balcony or loggia cannot be placed like this, or null when it can. */
export function balconyProblem(structure: Structure, b: Balcony, others: Balcony[]): string | null {
  const line = facadeLine(structure, b.edge);
  if (!line) return "That side of the outline does not exist.";
  if (![b.offset, b.width, b.depth, b.railing].every(Number.isFinite)) return "A size is not a number.";
  if (b.width < MIN_BALCONY_WIDTH) return `It must be at least ${MIN_BALCONY_WIDTH.toFixed(2)} m wide.`;
  if (!(b.railing > 0)) return "The railing needs a thickness.";
  if (!(b.depth > b.railing + 0.1)) return "It is too shallow for its railing.";
  if (b.offset < -1e-6 || b.offset + b.width > line.length + 1e-6) {
    return `It runs past the end of side ${b.edge + 1} (${line.length.toFixed(2)} m long).`;
  }
  for (const o of others) {
    if (o.id === b.id || o.edge !== b.edge) continue;
    if (b.offset < o.offset + o.width - 1e-6 && o.offset < b.offset + b.width - 1e-6) {
      return `It overlaps another ${o.kind} on side ${b.edge + 1}.`;
    }
  }
  if (b.kind === "loggia") {
    // The mouth must lie on one straight stretch of the upper facade, and the
    // loggia must stay inside the building, clear of the core.
    const upper = upperOutline(structure);
    const p0 = facadePoint(line, b.offset, 0);
    const p1 = facadePoint(line, b.offset + b.width, 0);
    if (ringEdgeHolding(upper, p0, p1) < 0) return "A loggia must sit on one straight stretch of the facade.";
    const wall = structure.wallThickness;
    const back = [
      facadePoint(line, b.offset + 0.01, -b.depth - wall),
      facadePoint(line, b.offset + b.width - 0.01, -b.depth - wall),
    ];
    if (!back.every((p) => pointInRing(p, upper))) return "It reaches out of the other side of the building.";
    const ring = balconyOutline(structure, b);
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    const gap = structure.coreWallThickness / 2 + wall;
    for (const c of structure.core) {
      const { min, max } = coreRect(c);
      const apart =
        Math.max(...xs) <= min.x - gap ||
        Math.min(...xs) >= max.x + gap ||
        Math.max(...ys) <= min.y - gap ||
        Math.min(...ys) >= max.y + gap;
      if (!apart) return "It runs into the hall, stairs or elevator.";
    }
  }
  return null;
}

/** The balconies and loggias that can be drawn; any others are left out. */
export function placeableBalconies(structure: Structure): Balcony[] {
  const all = structure.balconies ?? [];
  return all.filter((b) => balconyProblem(structure, b, all) === null);
}

/**
 * Outline of the storeys above the ground floor at the outside wall faces,
 * with the loggias cut into it. `origin[i]` is the edge of the plain upper
 * outline that edge i of this one lies on.
 */
function facadeOutline(structure: Structure): { ring: Pt[]; origin: number[] } {
  const upper = upperOutline(structure);
  const notches = new Map<number, { t: number; pts: Pt[] }[]>();
  for (const b of placeableBalconies(structure)) {
    if (b.kind !== "loggia") continue;
    const line = facadeLine(structure, b.edge)!;
    const p0 = facadePoint(line, b.offset, 0);
    const p1 = facadePoint(line, b.offset + b.width, 0);
    const k = ringEdgeHolding(upper, p0, p1);
    if (k < 0) continue;
    const list = notches.get(k) ?? [];
    list.push({
      t: projectParam(p0, upper[k], upper[(k + 1) % upper.length]),
      pts: [p0, facadePoint(line, b.offset, -b.depth), facadePoint(line, b.offset + b.width, -b.depth), p1],
    });
    notches.set(k, list);
  }
  const ring: Pt[] = [];
  const origin: number[] = [];
  upper.forEach((p, k) => {
    ring.push(p);
    origin.push(k);
    for (const notch of (notches.get(k) ?? []).sort((x, y) => x.t - y.t)) {
      for (const q of notch.pts) {
        ring.push(q);
        origin.push(k);
      }
    }
  });
  return { ring, origin };
}

/** True for the lowest storey of the building. */
export function isGroundStorey(building: Building, storeyId: string): boolean {
  return sortedStoreys(building)[0]?.id === storeyId;
}

/** Outline of one storey at the outside wall faces; empty without a footprint. */
export function storeyOutline(building: Building, storeyId: string): Pt[] {
  const { structure } = building;
  if (structure.footprint.length < 3) return [];
  return isGroundStorey(building, storeyId) ? structure.footprint : facadeOutline(structure).ring;
}

export function ringArea(ring: Pt[]): number {
  return Math.abs(ringSignedArea(ring));
}

export function ringPerimeter(ring: Pt[]): number {
  let length = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

// ------------------------------------------------------------ generated walls

const CORE_SPACE: Record<CoreKind, { type: SpaceType; name: string }> = {
  hall: { type: "corridor", name: "Hall" },
  stair: { type: "stair", name: "Stairs" },
  elevator: { type: "elevator", name: "Elevator" },
};

export function coreRect(c: Pick<CoreElement, "a" | "b">): { min: Pt; max: Pt } {
  return {
    min: { x: Math.min(c.a.x, c.b.x), y: Math.min(c.a.y, c.b.y) },
    max: { x: Math.max(c.a.x, c.b.x), y: Math.max(c.a.y, c.b.y) },
  };
}

function generatedWalls(building: Building, storey: Storey): Wall[] {
  const { structure } = building;
  if (structure.footprint.length < 3) return [];
  const ground = isGroundStorey(building, storey.id);
  const { ring: outline, origin } = ground
    ? { ring: structure.footprint, origin: structure.footprint.map((_, i) => i) }
    : facadeOutline(structure);
  const walls: Wall[] = [];
  // The outline is the outside face; the walls are drawn on their centrelines.
  const centre = offsetRingLeft(
    outline,
    outline.map(() => structure.wallThickness / 2),
  ).map(roundPt);
  // Ids follow the side of the plain outline, so a loggia cut into one side
  // leaves the walls of the other sides, and the windows in them, alone.
  const pieces = new Map<number, number>();
  centre.forEach((a, i) => {
    const b = centre[(i + 1) % centre.length];
    if (samePoint(a, b)) return;
    const side = centre.length === outline.length ? origin[i] : i;
    const piece = pieces.get(side) ?? 0;
    pieces.set(side, piece + 1);
    walls.push({
      id: piece === 0 ? `${storey.id}:shell:${side}` : `${storey.id}:shell:${side}:${piece}`,
      a,
      b,
      thickness: structure.wallThickness,
      kind: "exterior",
      part: "shell",
    });
  });
  if (!ground) walls.push(...railingWalls(structure, storey));
  for (const c of structure.core) {
    const { min, max } = coreRect(c);
    const corners = [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }];
    corners.forEach((a, i) => {
      walls.push({
        id: `${storey.id}:core:${c.id}:${i}`,
        a,
        b: corners[(i + 1) % 4],
        thickness: structure.coreWallThickness,
        kind: "interior",
        part: "core",
      });
    });
  }
  return walls;
}

/**
 * The railings of the balconies and loggias of a storey above the ground
 * floor. A balcony's railing runs round its three open sides and meets the
 * outside wall; a loggia's runs across its mouth, in line with the outside wall.
 */
function railingWalls(structure: Structure, storey: Storey): Wall[] {
  const walls: Wall[] = [];
  const half = structure.wallThickness / 2;
  for (const b of placeableBalconies(structure)) {
    const line = facadeLine(structure, b.edge)!;
    const t = b.railing;
    const runs: [Pt, Pt][] = [];
    if (b.kind === "balcony") {
      const s0 = b.offset + t / 2;
      const s1 = b.offset + b.width - t / 2;
      const front = b.depth - t / 2;
      runs.push(
        [facadePoint(line, s0, -half), facadePoint(line, s0, front)],
        [facadePoint(line, s0, front), facadePoint(line, s1, front)],
        [facadePoint(line, s1, front), facadePoint(line, s1, -half)],
      );
    } else {
      runs.push([facadePoint(line, b.offset - half, -half), facadePoint(line, b.offset + b.width + half, -half)]);
    }
    runs.forEach(([a, c], k) =>
      walls.push({ id: `${storey.id}:balcony:${b.id}:${k}`, a, b: c, thickness: t, kind: "interior", part: "balcony" }),
    );
  }
  return walls;
}

/**
 * Gives the rooms the balconies and loggias enclose their type and name where
 * they are still plain rooms, hands each to the apartment of the room behind
 * it when it belongs to none, and gives it a door when it has none.
 */
export function nameBalconySpaces(structure: Structure, storey: Storey): Storey {
  const list = placeableBalconies(structure);
  if (list.length === 0) return storey;
  const { faceBySpaceId } = linkSpaces(storey);
  const spaceAt = (p: Pt) =>
    storey.spaces.find((s) => {
      const face = faceBySpaceId.get(s.id);
      return face !== undefined && pointInPolygon(p, face.outer, face.holes);
    });
  const taken = new Set(storey.spaces.map((s) => s.name));
  const patch = new Map<string, { type: SpaceType; name: string }>();
  const joins = new Map<string, string>();
  for (const b of list) {
    const line = facadeLine(structure, b.edge)!;
    const mid = b.offset + b.width / 2;
    const inside = facadePoint(line, mid, b.kind === "balcony" ? b.depth / 2 : -b.depth / 2);
    const behind = facadePoint(line, mid, (b.kind === "balcony" ? 0 : -b.depth) - structure.wallThickness - 0.3);
    const space = spaceAt(inside);
    if (!space) continue;
    if (space.type === "room" && !patch.has(space.id)) {
      const base = b.kind === "balcony" ? "Balcony" : "Loggia";
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
      taken.add(name);
      patch.set(space.id, { type: "balcony", name });
    }
    const owner = spaceAt(behind);
    const apartment = owner && storey.apartments.find((a) => a.spaceIds.includes(owner.id));
    if (apartment && !storey.apartments.some((a) => a.spaceIds.includes(space.id))) joins.set(space.id, apartment.id);
  }
  const named =
    patch.size === 0 && joins.size === 0
      ? storey
      : {
          ...storey,
          spaces: storey.spaces.map((s) => (patch.has(s.id) ? { ...s, ...patch.get(s.id)! } : s)),
          apartments: storey.apartments.map((a) => {
            const extra = [...joins].filter(([, apt]) => apt === a.id).map(([id]) => id);
            return extra.length ? { ...a, spaceIds: [...a.spaceIds, ...extra] } : a;
          }),
        };
  return addBalconyDoors(structure, named, list);
}

/**
 * Puts a door into every balcony and loggia that asks for one and has no door
 * at all yet: in the outside wall between it and the room behind, in the
 * middle where there is room. One moved elsewhere stays where it was put.
 */
function addBalconyDoors(structure: Structure, storey: Storey, list: Balcony[]): Storey {
  let next = storey;
  for (const b of list) {
    if (!b.door) continue;
    const line = facadeLine(structure, b.edge)!;
    const mid = b.offset + b.width / 2;
    let linked = linkSpaces(next);
    const inside = facadePoint(line, mid, b.kind === "balcony" ? b.depth / 2 : -b.depth / 2);
    const space = next.spaces.find((s) => {
      const face = linked.faceBySpaceId.get(s.id);
      return face !== undefined && pointInPolygon(inside, face.outer, face.holes);
    });
    if (!space) continue;
    const opensOnto = (st: Storey, o: Opening, l: LinkedSpaces) =>
      o.kind === "door" && openingSides(st, o, l).includes(space.id);
    if (next.openings.some((o) => opensOnto(next, o, linked))) continue;
    // The outside wall behind it: the facade for a balcony, the back of the cut for a loggia.
    const back = (b.kind === "balcony" ? 0 : -b.depth) - structure.wallThickness / 2;
    const at = locateOnWall(next, facadePoint(line, mid, back), structure.wallThickness / 2);
    if (!at || next.walls.find((w) => w.id === at.wallId)?.part !== "shell") continue;
    const placed = addOpening(next, at.wallId, "door", at.offset, { width: b.door.width, height: b.door.height, sill: 0 });
    if (placed === next) continue;
    linked = linkSpaces(placed);
    // It must open onto this balcony, not slide off beside it.
    if (!opensOnto(placed, placed.openings.at(-1)!, linked)) continue;
    next = placed;
  }
  return next;
}

/** Names the rooms the core rectangles enclose, where they are still unnamed. */
function nameCoreSpaces(structure: Structure, storey: Storey): Storey {
  if (structure.core.length === 0) return storey;
  const { faceBySpaceId } = linkSpaces(storey);
  const taken = new Set(storey.spaces.map((s) => s.name));
  const patch = new Map<string, { type: SpaceType; name: string }>();
  for (const c of structure.core) {
    const { min, max } = coreRect(c);
    const centre = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 };
    const space = storey.spaces.find((s) => {
      const face = faceBySpaceId.get(s.id);
      return face !== undefined && pointInPolygon(centre, face.outer, face.holes);
    });
    if (!space || space.type !== "room" || patch.has(space.id)) continue;
    const base = CORE_SPACE[c.kind];
    let name = base.name;
    for (let n = 2; taken.has(name); n++) name = `${base.name} ${n}`;
    taken.add(name);
    patch.set(space.id, { type: base.type, name });
  }
  if (patch.size === 0) return storey;
  return syncCirculation({
    ...storey,
    spaces: storey.spaces.map((s) => (patch.has(s.id) ? { ...s, ...patch.get(s.id)! } : s)),
  });
}

function withBuilding(project: Project, building: Building): Project {
  return {
    ...project,
    site: {
      ...project.site,
      buildings: project.site.buildings.map((b) => (b.id === building.id ? building : b)),
    },
  };
}

const sameColumns = (a: Column[] | undefined, b: Column[] | undefined): boolean =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * Gives a storey the columns of the structure. Doors and windows a column now
 * stands in are moved aside along their wall, or dropped where there is no
 * room left for them.
 */
function placeColumns(storey: Storey, columns: Column[] | undefined): Storey {
  if (sameColumns(storey.columns, columns)) return storey;
  const next: Storey = { ...storey };
  if (columns?.length) next.columns = columns.map((c) => ({ ...c, at: { ...c.at } }));
  else delete next.columns;
  return reconcileOpenings(storey, next);
}

/**
 * Draws the structure on every storey again: the outside walls from the
 * outline of that storey, the walls of the hall, stairs and elevator, and the
 * columns. Walls drawn by hand stay; doors and windows stay where they stood.
 */
export function rebuildStructure(project: Project, buildingId: string): Project {
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!building) return project;
  const storeys = building.storeys.map((original) => {
    const storey = placeColumns(original, building.structure.columns);
    const generated = generatedWalls(building, storey);
    const own = storey.walls.filter((w) => !w.part);
    if (generated.length === 0 && own.length === storey.walls.length) return storey;
    const walled = nameCoreSpaces(building.structure, applyWalls(storey, [...generated, ...own]));
    return isGroundStorey(building, storey.id) ? walled : nameBalconySpaces(building.structure, walled);
  });
  return withBuilding(project, { ...building, storeys });
}

function withStructure(project: Project, buildingId: string, patch: Partial<Structure>): Project {
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!building) return project;
  return rebuildStructure(
    withBuilding(project, { ...building, structure: { ...building.structure, ...patch } }),
    buildingId,
  );
}

const structureOf = (project: Project, buildingId: string): Structure | undefined =>
  project.site.buildings.find((b) => b.id === buildingId)?.structure;

// -------------------------------------------------------------------- editing

/**
 * Sets the outline of the ground floor. An outline that crosses itself is not
 * applied. The erker starts on every side; sides are switched off one by one.
 */
export function setFootprint(project: Project, buildingId: string, corners: Pt[]): Project {
  const structure = structureOf(project, buildingId);
  const footprint = leftHanded(corners.map(roundPt));
  if (!structure || boundaryProblem(footprint)) return project;
  // The sides are new, so balconies placed on the old ones go.
  return withStructure(project, buildingId, {
    footprint,
    erker: { depth: structure.erker.depth, edges: footprint.map(() => true) },
    balconies: undefined,
  });
}

/** Moves one corner of the outline. A move that makes it cross itself is not applied. */
export function moveFootprintCorner(project: Project, buildingId: string, index: number, to: Pt): Project {
  const structure = structureOf(project, buildingId);
  if (!structure?.footprint[index] || !Number.isFinite(to.x) || !Number.isFinite(to.y)) return project;
  const footprint = structure.footprint.map((p, i) => (i === index ? roundPt(to) : p));
  // A corner dragged across the outline would turn it inside out.
  if (boundaryProblem(footprint) || ringSignedArea(footprint) <= 0) return project;
  return withStructure(project, buildingId, { footprint });
}

/** Removes the outline, and with it the generated walls; the core is kept for the next outline. */
export function clearFootprint(project: Project, buildingId: string): Project {
  const structure = structureOf(project, buildingId);
  if (!structure || structure.footprint.length === 0) return project;
  return withStructure(project, buildingId, {
    footprint: [],
    erker: { depth: structure.erker.depth, edges: [] },
    balconies: undefined,
  });
}

export function setErkerDepth(project: Project, buildingId: string, depth: number): Project {
  const structure = structureOf(project, buildingId);
  if (!structure || !(depth >= 0) || depth === structure.erker.depth) return project;
  return withStructure(project, buildingId, { erker: { ...structure.erker, depth } });
}

/** Switches the erker of one side of the outline on or off; `on` omitted toggles it. */
export function setErkerEdge(project: Project, buildingId: string, edge: number, on?: boolean): Project {
  const structure = structureOf(project, buildingId);
  if (!structure?.footprint[edge]) return project;
  const edges = structure.footprint.map((_, i) =>
    i === edge ? (on ?? !structure.erker.edges[i]) : structure.erker.edges[i] === true,
  );
  return withStructure(project, buildingId, { erker: { ...structure.erker, edges } });
}

export function setAllErkerEdges(project: Project, buildingId: string, on: boolean): Project {
  const structure = structureOf(project, buildingId);
  if (!structure) return project;
  return withStructure(project, buildingId, {
    erker: { ...structure.erker, edges: structure.footprint.map(() => on) },
  });
}

export function setStructureThickness(
  project: Project,
  buildingId: string,
  patch: Partial<Pick<Structure, "wallThickness" | "coreWallThickness">>,
): Project {
  for (const v of Object.values(patch)) if (!(v > 0)) return project;
  return withStructure(project, buildingId, patch);
}

/** Adds a hall, a staircase or an elevator as a rectangle between two corners. */
export function addCoreElement(
  project: Project,
  buildingId: string,
  kind: CoreKind,
  a: Pt,
  b: Pt,
): { project: Project; id: string | null } {
  const structure = structureOf(project, buildingId);
  const { min, max } = coreRect({ a, b });
  if (!structure || max.x - min.x < MIN_CORE_SIZE || max.y - min.y < MIN_CORE_SIZE) {
    return { project, id: null };
  }
  const element: CoreElement = { id: newId("core"), kind, a: roundPt(min), b: roundPt(max) };
  return {
    project: withStructure(project, buildingId, { core: [...structure.core, element] }),
    id: element.id,
  };
}

/** Moves or resizes a core element by giving its rectangle again. */
export function updateCoreElement(project: Project, buildingId: string, id: string, a: Pt, b: Pt): Project {
  const structure = structureOf(project, buildingId);
  const { min, max } = coreRect({ a, b });
  if (!structure || max.x - min.x < MIN_CORE_SIZE || max.y - min.y < MIN_CORE_SIZE) return project;
  if (![min.x, min.y, max.x, max.y].every(Number.isFinite)) return project;
  return withStructure(project, buildingId, {
    core: structure.core.map((c) => (c.id === id ? { ...c, a: roundPt(min), b: roundPt(max) } : c)),
  });
}

export function removeCoreElement(project: Project, buildingId: string, id: string): Project {
  const structure = structureOf(project, buildingId);
  const element = structure?.core.find((c) => c.id === id);
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!structure || !element || !building) return project;
  // The room it enclosed goes with it; otherwise its name and type would pass
  // to the room around it.
  const { min, max } = coreRect(element);
  const centre = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 };
  const storeys = building.storeys.map((storey) => {
    const { faceBySpaceId } = linkSpaces(storey);
    const gone = storey.spaces.find((s) => {
      const face = faceBySpaceId.get(s.id);
      return face !== undefined && pointInPolygon(centre, face.outer, face.holes);
    });
    return gone ? { ...storey, spaces: storey.spaces.filter((s) => s !== gone) } : storey;
  });
  return withStructure(withBuilding(project, { ...building, storeys }), buildingId, {
    core: structure.core.filter((c) => c.id !== id),
  });
}

/**
 * Gives the building these columns, replacing the ones it had, and places
 * them on every storey. Columns without a positive size are left out.
 */
export function setColumns(
  project: Project,
  buildingId: string,
  columns: { at: Pt; w: number; d: number }[],
): Project {
  if (!structureOf(project, buildingId)) return project;
  const clean: Column[] = columns
    .filter((c) => c.w > 0 && c.d > 0 && Number.isFinite(c.at.x) && Number.isFinite(c.at.y))
    .map((c) => ({ id: newId("column"), at: roundPt(c.at), w: round(c.w), d: round(c.d) }));
  return withStructure(project, buildingId, { columns: clean.length ? clean : undefined });
}

/** Removes one column from every storey. */
export function removeColumn(project: Project, buildingId: string, id: string): Project {
  const structure = structureOf(project, buildingId);
  if (!structure?.columns?.some((c) => c.id === id)) return project;
  const rest = structure.columns.filter((c) => c.id !== id);
  return withStructure(project, buildingId, { columns: rest.length ? rest : undefined });
}

/** Adds a balcony or loggia to every storey above the ground floor; with the reason when it does not fit. */
export function addBalcony(
  project: Project,
  buildingId: string,
  spec: Omit<Balcony, "id">,
): { project: Project; id: string | null; problem: string | null } {
  const structure = structureOf(project, buildingId);
  if (!structure) return { project, id: null, problem: "No such building." };
  const b: Balcony = { ...spec, id: newId("balcony") };
  const list = structure.balconies ?? [];
  const problem = balconyProblem(structure, b, list);
  if (problem) return { project, id: null, problem };
  return { project: withStructure(project, buildingId, { balconies: [...list, b] }), id: b.id, problem: null };
}

/** Changes a balcony or loggia; unchanged, with the reason, when the change does not fit. */
export function updateBalcony(
  project: Project,
  buildingId: string,
  id: string,
  patch: Partial<Omit<Balcony, "id">>,
): { project: Project; problem: string | null } {
  const structure = structureOf(project, buildingId);
  const list = structure?.balconies ?? [];
  const old = list.find((b) => b.id === id);
  if (!structure || !old) return { project, problem: "No such balcony." };
  const next = { ...old, ...patch };
  const problem = balconyProblem(structure, next, list);
  if (problem) return { project, problem };
  return {
    project: withStructure(project, buildingId, { balconies: list.map((b) => (b.id === id ? next : b)) }),
    problem: null,
  };
}

export function removeBalcony(project: Project, buildingId: string, id: string): Project {
  const structure = structureOf(project, buildingId);
  const list = structure?.balconies ?? [];
  if (!list.some((b) => b.id === id)) return project;
  const rest = list.filter((b) => b.id !== id);
  return withStructure(project, buildingId, { balconies: rest.length ? rest : undefined });
}

/** Places an entrance door in a wall; unchanged if it does not fit there. */
export function addEntrance(storey: Storey, wallId: string, offset: number, size: OpeningSize): Storey {
  const next = addOpening(storey, wallId, "door", offset, size);
  if (next === storey) return storey;
  const last = next.openings.length - 1;
  return { ...next, openings: next.openings.map((o, i) => (i === last ? { ...o, entrance: true } : o)) };
}

/**
 * True when an edit left the generated walls as they were. They are changed
 * through the structure, never by dragging or deleting them on a storey.
 */
export function structureIntact(before: Storey, after: Storey): boolean {
  const kept = new Map(after.walls.map((w) => [w.id, w]));
  return before.walls.every((w) => {
    if (!w.part) return true;
    const now = kept.get(w.id);
    return (
      now !== undefined &&
      now.thickness === w.thickness &&
      now.kind === w.kind &&
      samePoint(now.a, w.a, 1e-9) &&
      samePoint(now.b, w.b, 1e-9)
    );
  });
}

/** Which side of a wall with an entrance is outdoors: 1 for its normal, -1 for the other. */
export function outsideSign(outline: Pt[], at: Pt, normal: Pt): 1 | -1 {
  const probe = { x: at.x + normal.x * 0.6, y: at.y + normal.y * 0.6 };
  return pointInRing(probe, outline) ? -1 : 1;
}

// ------------------------------------------------------------------- workflow

export interface StructureStatus {
  hasOutline: boolean;
  entrances: number;
  halls: number;
  stairs: number;
  elevators: number;
  /** A plan drawn freely, before buildings had a structure. */
  legacy: boolean;
}

export function structureStatus(project: Project): StructureStatus {
  const building = project.site.buildings[0];
  const { structure } = building;
  const ground = sortedStoreys(building)[0];
  const count = (kind: CoreKind) => structure.core.filter((c) => c.kind === kind).length;
  const hasOutline = structure.footprint.length >= 3;
  return {
    hasOutline,
    entrances: ground ? ground.openings.filter((o) => o.entrance).length : 0,
    halls: count("hall"),
    stairs: count("stair"),
    elevators: count("elevator"),
    legacy: !hasOutline && project.site.buildings.some((b) => b.storeys.some((s) => s.walls.length > 0)),
  };
}

/** What is still missing before the apartments can be drawn; empty when nothing is. */
export function missingForApartments(status: StructureStatus): string[] {
  if (status.legacy) return [];
  const missing: string[] = [];
  if (!status.hasOutline) missing.push("the building outline");
  if (status.entrances === 0) missing.push("the entrance");
  if (status.halls === 0) missing.push("the hall");
  if (status.stairs === 0) missing.push("the stairs");
  return missing;
}

/** Why a step cannot be opened yet, or null when it can. */
export function stageBlocker(project: Project, stage: Stage): string | null {
  const status = structureStatus(project);
  if (stage === "lot" || stage === "outline") return null;
  if (stage === "apartments") {
    const missing = missingForApartments(status);
    if (missing.length === 0) return null;
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0];
    return `Place ${list} first.`;
  }
  return status.hasOutline ? null : "Draw the building outline first.";
}

export function setStage(project: Project, stage: Stage): Project {
  if (project.stage === stage || !STAGES.includes(stage) || stageBlocker(project, stage)) return project;
  return { ...project, stage };
}
