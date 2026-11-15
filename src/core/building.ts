/**
 * Storeys of a building: adding, copying, deleting, and keeping their
 * elevations consistent. Pure functions on the project, no UI imports.
 */
import type { Pt } from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Building, Project, Storey } from "./model.ts";

/** Level differences smaller than this are drawing noise (1 mm). */
const LEVEL_TOL = 1e-3;

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Lowest storey first. */
export function sortedStoreys(building: Building): Storey[] {
  return building.storeys.slice().sort((a, b) => a.elevation - b.elevation);
}

export function findBuilding(project: Project, storeyId: string): Building | undefined {
  return project.site.buildings.find((b) => b.storeys.some((s) => s.id === storeyId));
}

function replaceBuilding(project: Project, building: Building): Project {
  return {
    ...project,
    site: {
      ...project.site,
      buildings: project.site.buildings.map((b) => (b.id === building.id ? building : b)),
    },
  };
}

function nextStoreyName(building: Building): string {
  const taken = new Set(building.storeys.map((s) => s.name));
  for (let n = building.storeys.length; ; n++) {
    const name = `Floor ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Level of the top of the highest storey: where the next one starts. */
function topLevel(building: Building): number {
  return round(Math.max(...building.storeys.map((s) => s.elevation + s.height)));
}

/** Adds an empty storey on top of the building. */
export function addStorey(
  project: Project,
  buildingId: string,
): { project: Project; storeyId: string } {
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!building) throw new Error(`No building "${buildingId}".`);
  const top = sortedStoreys(building).at(-1)!;
  const storey: Storey = {
    id: newId("storey"),
    name: nextStoreyName(building),
    elevation: topLevel(building),
    height: top.height,
    walls: [],
    openings: [],
    spaces: [],
    apartments: [],
    circulation: [],
    dimensions: [],
  };
  return {
    project: replaceBuilding(project, { ...building, storeys: [...building.storeys, storey] }),
    storeyId: storey.id,
  };
}

/**
 * Copies a storey, with everything on it, to the top of its building. The copy
 * gets fresh ids throughout, so editing it never touches the original.
 */
export function copyStorey(
  project: Project,
  storeyId: string,
): { project: Project; storeyId: string } {
  const building = findBuilding(project, storeyId);
  if (!building) throw new Error(`No storey "${storeyId}".`);
  const source = building.storeys.find((s) => s.id === storeyId)!;
  const copyId = newId("storey");
  // Generated walls are named after their storey, so that rebuilding the
  // structure finds them again; the copy's are named after the copy.
  const wallIds = new Map(
    source.walls.map((w) => [
      w.id,
      w.part && w.id.startsWith(`${source.id}:`) ? copyId + w.id.slice(source.id.length) : newId("wall"),
    ]),
  );
  const spaceIds = new Map(source.spaces.map((s) => [s.id, newId("space")]));
  const copy: Storey = {
    id: copyId,
    name: nextStoreyName(building),
    elevation: topLevel(building),
    height: source.height,
    walls: source.walls.map((w) => ({ ...w, id: wallIds.get(w.id)!, a: { ...w.a }, b: { ...w.b } })),
    openings: source.openings.map((o) => ({
      ...o,
      id: newId("opening"),
      wallId: wallIds.get(o.wallId)!,
    })),
    spaces: source.spaces.map((s) => ({
      ...s,
      id: spaceIds.get(s.id)!,
      anchor: { ...s.anchor },
      wallIds: s.wallIds.map((id) => wallIds.get(id)!).sort(),
    })),
    apartments: source.apartments.map((a) => ({
      ...a,
      id: newId("apartment"),
      spaceIds: a.spaceIds.map((id) => spaceIds.get(id)!),
    })),
    circulation: source.circulation.map((c) => ({
      ...c,
      id: newId("circulation"),
      spaceId: c.spaceId ? spaceIds.get(c.spaceId) : undefined,
    })),
    dimensions: source.dimensions.map((d) => ({ ...d, id: newId("dimension"), a: { ...d.a }, b: { ...d.b } })),
  };
  return {
    project: replaceBuilding(project, { ...building, storeys: [...building.storeys, copy] }),
    storeyId: copy.id,
  };
}

/** Removes a storey. A building keeps at least one, so the last is never removed. */
export function deleteStorey(project: Project, storeyId: string): Project {
  const building = findBuilding(project, storeyId);
  if (!building || building.storeys.length <= 1) return project;
  return replaceBuilding(project, {
    ...building,
    storeys: building.storeys.filter((s) => s.id !== storeyId),
  });
}

export function updateStoreyInfo(
  project: Project,
  storeyId: string,
  patch: Partial<Pick<Storey, "name" | "elevation" | "height">>,
): Project {
  const building = findBuilding(project, storeyId);
  if (!building) return project;
  if (patch.height !== undefined && !(patch.height > 0)) return project;
  return replaceBuilding(project, {
    ...building,
    storeys: building.storeys.map((s) => (s.id === storeyId ? { ...s, ...patch } : s)),
  });
}

/**
 * Stacks the storeys without gaps or overlaps: the lowest keeps its elevation
 * and each one above starts where the one below ends.
 */
export function restackStoreys(project: Project, buildingId: string): Project {
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!building) return project;
  const elevation = new Map<string, number>();
  let level: number | null = null;
  for (const s of sortedStoreys(building)) {
    level = level === null ? s.elevation : level;
    elevation.set(s.id, round(level));
    level += s.height;
  }
  return replaceBuilding(project, {
    ...building,
    storeys: building.storeys.map((s) => ({ ...s, elevation: elevation.get(s.id)! })),
  });
}

/**
 * Shifts a whole building, every storey together, by a distance in plan.
 * Openings follow because they are positioned along their walls.
 */
export function moveBuilding(project: Project, buildingId: string, delta: Pt): Project {
  const building = project.site.buildings.find((b) => b.id === buildingId);
  if (!building || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return project;
  if (delta.x === 0 && delta.y === 0) return project;
  const shift = (p: Pt): Pt => ({ x: round(p.x + delta.x), y: round(p.y + delta.y) });
  return replaceBuilding(project, {
    ...building,
    structure: {
      ...building.structure,
      footprint: building.structure.footprint.map(shift),
      core: building.structure.core.map((c) => ({ ...c, a: shift(c.a), b: shift(c.b) })),
    },
    storeys: building.storeys.map((s) => ({
      ...s,
      walls: s.walls.map((w) => ({ ...w, a: shift(w.a), b: shift(w.b) })),
      spaces: s.spaces.map((x) => ({ ...x, anchor: shift(x.anchor) })),
      dimensions: s.dimensions.map((d) => ({ ...d, a: shift(d.a), b: shift(d.b) })),
    })),
  });
}

export interface ElevationIssue {
  kind: "gap" | "overlap";
  /** The upper storey of the pair. */
  storeyId: string;
  belowStoreyId: string;
  /** Size of the gap or overlap in metres. */
  amount: number;
  message: string;
}

/** Each storey should start exactly where the one below it ends. */
export function checkElevations(building: Building): ElevationIssue[] {
  const issues: ElevationIssue[] = [];
  const storeys = sortedStoreys(building);
  for (let i = 1; i < storeys.length; i++) {
    const below = storeys[i - 1];
    const above = storeys[i];
    const diff = above.elevation - (below.elevation + below.height);
    if (Math.abs(diff) <= LEVEL_TOL) continue;
    const kind = diff > 0 ? "gap" : "overlap";
    const amount = round(Math.abs(diff));
    issues.push({
      kind,
      storeyId: above.id,
      belowStoreyId: below.id,
      amount,
      message:
        kind === "gap"
          ? `${above.name} starts ${amount.toFixed(2)} m above the top of ${below.name}.`
          : `${above.name} starts ${amount.toFixed(2)} m below the top of ${below.name}.`,
    });
  }
  return issues;
}
