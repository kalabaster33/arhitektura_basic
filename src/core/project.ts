/** Creating, saving and loading projects as versioned JSON. */
import { newId } from "./ids.ts";
import {
  type Building,
  type Project,
  type Storey,
  type Wall,
  type WallKind,
  SCHEMA_VERSION,
} from "./model.ts";
import { syncSpaces } from "./spaces.ts";

export function createStorey(name = "Ground floor", height = 3): Storey {
  return {
    id: newId("storey"),
    name,
    elevation: 0,
    height,
    walls: [],
    openings: [],
    spaces: [],
    apartments: [],
    circulation: [],
  };
}

export function createProject(name = "Untitled project", snap = 0.05): Project {
  const building: Building = { id: newId("building"), name: "Building A", storeys: [createStorey()] };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId("project"),
    name,
    units: "m",
    grid: { snap },
    site: { id: newId("site"), name: "Site", boundary: [], buildings: [building] },
  };
}

/** A small plan to start from: an 8 x 6 m shell with two partitions. */
export function createSampleProject(
  thickness: Record<WallKind, number> = { exterior: 0.25, interior: 0.1 },
): Project {
  const project = createProject("Sample plan");
  const wall = (x1: number, y1: number, x2: number, y2: number, kind: WallKind): Wall => ({
    id: newId("wall"),
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
    thickness: thickness[kind],
    kind,
  });
  const storey = project.site.buildings[0].storeys[0];
  storey.walls = [
    wall(0, 0, 8, 0, "exterior"),
    wall(8, 0, 8, 6, "exterior"),
    wall(8, 6, 0, 6, "exterior"),
    wall(0, 6, 0, 0, "exterior"),
    wall(5, 0, 5, 6, "interior"),
    wall(5, 3.5, 8, 3.5, "interior"),
  ];
  return replaceStorey(project, syncSpaces(storey));
}

/** The storey with this id, or the first storey of the first building. */
export function getActiveStorey(project: Project, storeyId?: string): Storey {
  for (const b of project.site.buildings) {
    const found = b.storeys.find((s) => s.id === storeyId);
    if (found) return found;
  }
  return project.site.buildings[0].storeys[0];
}

export function replaceStorey(project: Project, storey: Storey): Project {
  return {
    ...project,
    site: {
      ...project.site,
      buildings: project.site.buildings.map((b) => ({
        ...b,
        storeys: b.storeys.map((s) => (s.id === storey.id ? storey : s)),
      })),
    },
  };
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Upgrades older files step by step: MIGRATIONS[n] turns a version n file into
 * version n + 1. Empty while there is only one version.
 */
const MIGRATIONS: Record<number, (data: any) => any> = {};

/** Parses a saved project; throws a readable error when the file cannot be used. */
export function parseProject(json: string): Project {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (!data || typeof data !== "object" || typeof data.schemaVersion !== "number") {
    throw new Error("This file is not a project file (no schemaVersion).");
  }
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `This file was saved by a newer version of the app (file version ${data.schemaVersion}, this app reads up to ${SCHEMA_VERSION}).`,
    );
  }
  while (data.schemaVersion < SCHEMA_VERSION) {
    const migrate = MIGRATIONS[data.schemaVersion];
    if (!migrate) throw new Error(`No upgrade path from file version ${data.schemaVersion}.`);
    data = migrate(data);
  }
  const buildings = data.site?.buildings;
  if (!Array.isArray(buildings) || buildings.length === 0) {
    throw new Error("This project has no building.");
  }
  for (const b of buildings) {
    if (!Array.isArray(b.storeys) || b.storeys.length === 0) {
      throw new Error(`Building "${b.name}" has no storey.`);
    }
    for (const s of b.storeys) {
      for (const key of ["walls", "openings", "spaces", "apartments", "circulation"]) {
        if (!Array.isArray(s[key])) throw new Error(`Storey "${s.name}" has no "${key}" list.`);
      }
      for (const w of s.walls) {
        const ok =
          typeof w.id === "string" &&
          [w.a?.x, w.a?.y, w.b?.x, w.b?.y, w.thickness].every(Number.isFinite);
        if (!ok) throw new Error(`Storey "${s.name}" contains a damaged wall.`);
      }
      // An opening is no use without its wall or its size; leave such ones out.
      const wallIds = new Set(s.walls.map((w: Wall) => w.id));
      s.openings = s.openings.filter(
        (o: any) =>
          typeof o?.id === "string" &&
          wallIds.has(o.wallId) &&
          [o.offset, o.width, o.height, o.sill].every(Number.isFinite),
      );
    }
  }
  if (!(data.grid?.snap > 0)) data.grid = { snap: 0.05 };
  return data as Project;
}
