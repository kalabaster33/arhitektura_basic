/** Creating, saving and loading projects as versioned JSON. */
import type { Pt } from "./geometry.ts";
import { newId } from "./ids.ts";
import {
  type Balcony,
  type Building,
  type Column,
  type Project,
  type Storey,
  type Structure,
  type Wall,
  type WallKind,
  SCHEMA_VERSION,
  STAGES,
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

/** A building structure with nothing drawn yet. */
export function emptyStructure(wallThickness = 0.25, coreWallThickness = 0.2): Structure {
  return {
    footprint: [],
    wallThickness,
    coreWallThickness,
    erker: { depth: 0, edges: [] },
    core: [],
  };
}

/** An empty lot: no plot, no building outline, the workflow at its first step. */
export function createProject(
  name = "Untitled project",
  snap = 0.05,
  thickness: { shell: number; core: number } = { shell: 0.25, core: 0.2 },
): Project {
  const building: Building = {
    id: newId("building"),
    name: "Building A",
    storeys: [createStorey()],
    structure: emptyStructure(thickness.shell, thickness.core),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId("project"),
    name,
    units: "m",
    grid: { snap },
    annotations: { outsideDimensions: true, roomDimensions: true, openingTags: true, levelMarks: true },
    stage: "lot",
    site: {
      id: newId("site"),
      name: "Site",
      boundary: [],
      setbacks: [],
      limits: { maxCoverage: null, maxFloorAreaRatio: null },
      north: 0,
      location: null,
      buildings: [building],
    },
  };
}

/** A small plan to start from: an 8 x 6 m shell with two partitions. */
export function createSampleProject(
  thickness: Record<WallKind, number> = { exterior: 0.25, interior: 0.1 },
): Project {
  // Drawn freely, without a building structure: it opens at the apartments step.
  const project: Project = { ...createProject("Sample plan"), stage: "apartments" };
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
  // Version 5 stores the workflow step, the place of the plot on the earth and
  // the structure of each building. A plan drawn before this has no structure
  // and carries on at the apartments step.
  4: (data) => {
    const buildings = Array.isArray(data.site?.buildings) ? data.site.buildings : [];
    const drawn = buildings.some((b: any) =>
      (Array.isArray(b.storeys) ? b.storeys : []).some((s: any) => Array.isArray(s.walls) && s.walls.length > 0),
    );
    return {
      ...data,
      schemaVersion: 5,
      stage: drawn ? "apartments" : "lot",
      site: {
        ...data.site,
        location: null,
        buildings: buildings.map((b: any) => ({ ...b, structure: emptyStructure() })),
      },
    };
  },
};

const isPt = (p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y);

/** A structure read from a file, with anything unusable left out. */
function cleanStructure(raw: any): Structure {
  const base = emptyStructure();
  const corners = Array.isArray(raw?.footprint) ? raw.footprint : [];
  const footprint: Pt[] =
    corners.length >= 3 && corners.every(isPt) ? corners.map((p: any) => ({ x: p.x, y: p.y })) : [];
  const positive = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  const depth = raw?.erker?.depth;
  const edges = Array.isArray(raw?.erker?.edges) ? raw.erker.edges : [];
  return {
    footprint,
    wallThickness: positive(raw?.wallThickness, base.wallThickness),
    coreWallThickness: positive(raw?.coreWallThickness, base.coreWallThickness),
    erker: {
      depth: typeof depth === "number" && Number.isFinite(depth) && depth > 0 ? depth : 0,
      edges: footprint.map((_, i) => edges[i] !== false),
    },
    core: (Array.isArray(raw?.core) ? raw.core : [])
      .filter(
        (c: any) =>
          typeof c?.id === "string" && ["hall", "stair", "elevator"].includes(c.kind) && isPt(c.a) && isPt(c.b),
      )
      .map((c: any) => ({ id: c.id, kind: c.kind, a: { x: c.a.x, y: c.a.y }, b: { x: c.b.x, y: c.b.y } })),
    ...cleanColumns(raw?.columns),
    ...(Array.isArray(raw?.columns) && raw.columns.length ? cleanColumnGrid(raw?.columnGrid) : {}),
    ...cleanBalconies(raw?.balconies),
  };
}

/** Balconies and loggias read from a file, damaged ones left out; nothing when there are none. */
function cleanBalconies(raw: unknown): { balconies?: Balcony[] } {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const balconies = (Array.isArray(raw) ? raw : [])
    .filter(
      (b: any) =>
        typeof b?.id === "string" &&
        (b.kind === "balcony" || b.kind === "loggia") &&
        Number.isInteger(b.edge) &&
        [b.offset, b.width, b.depth, b.railing].every(num),
    )
    .map((b: any) => ({
      id: b.id,
      kind: b.kind,
      edge: b.edge,
      offset: b.offset,
      width: b.width,
      depth: b.depth,
      railing: b.railing,
      ...(b.door?.width > 0 && b.door?.height > 0 ? { door: { width: b.door.width, height: b.door.height } } : {}),
    }));
  return balconies.length ? { balconies } : {};
}

/** Columns read from a file, damaged ones left out; nothing when there are none. */
function cleanColumns(raw: unknown): { columns?: Column[] } {
  const columns = (Array.isArray(raw) ? raw : [])
    .filter((c: any) => typeof c?.id === "string" && isPt(c.at) && c.w > 0 && c.d > 0 && Number.isFinite(c.w + c.d))
    .map((c: any) => ({ id: c.id, at: { x: c.at.x, y: c.at.y }, w: c.w, d: c.d }));
  return columns.length ? { columns } : {};
}

/** Column axes read from a file; nothing when they cannot be read. */
function cleanColumnGrid(raw: any): { columnGrid?: { xs: number[]; ys: number[] } } {
  const list = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x))
      ? (v as number[]).slice().sort((p, q) => p - q)
      : null;
  const xs = list(raw?.xs);
  const ys = list(raw?.ys);
  return xs && ys ? { columnGrid: { xs, ys } } : {};
}

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
    b.structure = cleanStructure(b.structure);
    for (const s of b.storeys) {
      // Every storey carries the columns of its structure; never a copy of its own.
      if (b.structure.columns) s.columns = b.structure.columns.map((c: Column) => ({ ...c, at: { ...c.at } }));
      else delete s.columns;
      for (const key of ["walls", "openings", "spaces", "apartments", "circulation"]) {
        if (!Array.isArray(s[key])) throw new Error(`Storey "${s.name}" has no "${key}" list.`);
      }
      for (const w of s.walls) {
        const ok =
          typeof w.id === "string" &&
          [w.a?.x, w.a?.y, w.b?.x, w.b?.y, w.thickness].every(Number.isFinite);
        if (!ok) throw new Error(`Storey "${s.name}" contains a damaged wall.`);
        if (w.loadBearing !== true || w.part) delete w.loadBearing;
      }
      // An opening is no use without its wall or its size; leave such ones out.
      // A load-bearing wall takes no openings.
      const wallIds = new Set(s.walls.filter((w: Wall) => !w.loadBearing).map((w: Wall) => w.id));
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
  const { lat, lon } = site.location ?? {};
  site.location =
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180
      ? { lat, lon }
      : null;
  if (!STAGES.includes(data.stage)) data.stage = "lot";
  // Own layout rules that are not even the right shape are dropped; the rest is checked when used.
  const lr = data.layoutRules;
  const shaped =
    lr && typeof lr === "object" && lr.rooms && typeof lr.rooms === "object" && Array.isArray(lr.adjacency) &&
    lr.circulation && typeof lr.circulation === "object";
  if (!shaped) delete data.layoutRules;
  return data as Project;
}
