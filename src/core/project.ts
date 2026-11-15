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
    dimensions: [],
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
    annotations: { outsideDimensions: true, roomDimensions: true, openingTags: true, levelMarks: true },
    site: {
      id: newId("site"),
      name: "Site",
      boundary: [],
      setbacks: [],
      limits: { maxCoverage: null, maxFloorAreaRatio: null },
      north: 0,
      buildings: [building],
    },
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
 * version n + 1.
 */
const MIGRATIONS: Record<number, (data: any) => any> = {
  // Version 2 stores a setback per plot edge and the plot's planning limits.
  1: (data) => {
    const site = data.site ?? {};
    const boundary = Array.isArray(site.boundary) ? site.boundary : [];
    return {
      ...data,
      schemaVersion: 2,
      site: {
        ...site,
        boundary,
        setbacks: boundary.map(() => 0),
        limits: { maxCoverage: null, maxFloorAreaRatio: null },
      },
    };
  },
  // Version 3 stores hand-placed dimensions per storey and which automatic ones are shown.
  2: (data) => ({
    ...data,
    schemaVersion: 3,
    annotations: { outsideDimensions: true, roomDimensions: true },
    site: {
      ...data.site,
      buildings: (Array.isArray(data.site?.buildings) ? data.site.buildings : []).map((b: any) => ({
        ...b,
        storeys: (Array.isArray(b.storeys) ? b.storeys : []).map((s: any) => ({ ...s, dimensions: [] })),
      })),
    },
  }),
  // Version 4 stores where north is, and whether opening tags and level marks are shown.
  3: (data) => ({
    ...data,
    schemaVersion: 4,
    annotations: { ...data.annotations, openingTags: true, levelMarks: true },
    site: { ...data.site, north: 0 },
  }),
};

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
      // A dimension that cannot be read is left out.
      s.dimensions = (Array.isArray(s.dimensions) ? s.dimensions : []).filter(
        (d: any) =>
          typeof d?.id === "string" && [d.a?.x, d.a?.y, d.b?.x, d.b?.y, d.offset].every(Number.isFinite),
      );
    }
  }
  // A plot that cannot be read is left out; the building is still worth opening.
  const site = data.site;
  const corners = Array.isArray(site.boundary) ? site.boundary : [];
  const plotOk =
    corners.length >= 3 && corners.every((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  site.boundary = plotOk ? corners.map((p: any) => ({ x: p.x, y: p.y })) : [];
  const setbacks = Array.isArray(site.setbacks) ? site.setbacks : [];
  site.setbacks = site.boundary.map((_: unknown, i: number) =>
    Number.isFinite(setbacks[i]) && setbacks[i] >= 0 ? setbacks[i] : 0,
  );
  const limit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  site.limits = {
    maxCoverage: limit(site.limits?.maxCoverage),
    maxFloorAreaRatio: limit(site.limits?.maxFloorAreaRatio),
  };
  if (!(data.grid?.snap > 0)) data.grid = { snap: 0.05 };
  data.annotations = {
    outsideDimensions: data.annotations?.outsideDimensions !== false,
    roomDimensions: data.annotations?.roomDimensions !== false,
    openingTags: data.annotations?.openingTags !== false,
    levelMarks: data.annotations?.levelMarks !== false,
  };
  const north = Number.isFinite(site.north) ? site.north % 360 : 0;
  site.north = north < 0 ? north + 360 : north;
  return data as Project;
}
