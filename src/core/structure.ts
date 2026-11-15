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
import { type Pt, offsetRingLeft, pointInPolygon, pointInRing, ringSignedArea, samePoint } from "./geometry.ts";
import { newId } from "./ids.ts";
import {
  type Building,
  type CoreElement,
  type CoreKind,
  type Project,
  type SpaceType,
  type Stage,
  type Storey,
  type Structure,
  type Wall,
  STAGES,
} from "./model.ts";
import { type OpeningSize, addOpening } from "./openings.ts";
import { boundaryProblem } from "./site.ts";
import { linkSpaces, syncCirculation } from "./spaces.ts";

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

/** True for the lowest storey of the building. */
export function isGroundStorey(building: Building, storeyId: string): boolean {
  return sortedStoreys(building)[0]?.id === storeyId;
}

/** Outline of one storey at the outside wall faces; empty without a footprint. */
export function storeyOutline(building: Building, storeyId: string): Pt[] {
  const { structure } = building;
  if (structure.footprint.length < 3) return [];
  return isGroundStorey(building, storeyId) ? structure.footprint : upperOutline(structure);
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
  const outline = storeyOutline(building, storey.id);
  if (outline.length < 3) return [];
  const walls: Wall[] = [];
  // The outline is the outside face; the walls are drawn on their centrelines.
  const centre = offsetRingLeft(
    outline,
    outline.map(() => structure.wallThickness / 2),
  ).map(roundPt);
  centre.forEach((a, i) => {
    const b = centre[(i + 1) % centre.length];
    if (samePoint(a, b)) return;
    walls.push({
      id: `${storey.id}:shell:${i}`,
      a,
      b,
      thickness: structure.wallThickness,
      kind: "exterior",
      part: "shell",
    });
  });
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

/**
 * Draws the structure on every storey again: the outside walls from the
 * outline of that storey and the walls of the hall, stairs and elevator.
 * Walls drawn by hand stay; doors and windows stay where they stood.
 */
export function rebuildStructure(project: Project, buildingId: string): Project {
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!building) return project;
  const storeys = building.storeys.map((storey) => {
    const generated = generatedWalls(building, storey);
    const own = storey.walls.filter((w) => !w.part);
    if (generated.length === 0 && own.length === storey.walls.length) return storey;
    return nameCoreSpaces(building.structure, applyWalls(storey, [...generated, ...own]));
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
  return withStructure(project, buildingId, {
    footprint,
    erker: { depth: structure.erker.depth, edges: footprint.map(() => true) },
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
