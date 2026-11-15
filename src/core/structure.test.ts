import { describe, expect, it } from "vitest";
import mapSettingsJson from "../config/mapSettings.json";
import { addStorey, copyStorey, moveBuilding, sortedStoreys } from "./building.ts";
import { addWall } from "./edit.ts";
import {
  fromWorldPixel,
  metresPerPixel,
  parseLatLon,
  parseMapSettings,
  planToLocation,
  tileZoomFor,
  tilesForPlan,
  worldPixel,
} from "./geo.ts";
import { type Project, SCHEMA_VERSION } from "./model.ts";
import {
  createProject,
  createSampleProject,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "./project.ts";
import { buildingFootprint, regionArea } from "./site.ts";
import {
  addCoreElement,
  addEntrance,
  clearFootprint,
  moveFootprintCorner,
  rebuildStructure,
  removeCoreElement,
  ringArea,
  setAllErkerEdges,
  setErkerDepth,
  setErkerEdge,
  setFootprint,
  setStage,
  stageBlocker,
  structureIntact,
  structureStatus,
  upperOutline,
} from "./structure.ts";

const RECT = [
  { x: 0, y: 0 },
  { x: 12, y: 0 },
  { x: 12, y: 10 },
  { x: 0, y: 10 },
];
const building = (p: Project) => p.site.buildings[0];
const id = (p: Project) => building(p).id;
const withOutline = () => {
  const p = createProject();
  return setFootprint(p, id(p), RECT);
};
const entranceSize = { width: 1.4, height: 2.2, sill: 0 };

/** Outline, a second storey, hall, stairs and an entrance: everything the apartments step needs. */
function complete(): Project {
  let p = withOutline();
  p = rebuildStructure(addStorey(p, id(p)).project, id(p));
  p = addCoreElement(p, id(p), "hall", { x: 4, y: 0.125 }, { x: 8, y: 4 }).project;
  p = addCoreElement(p, id(p), "stair", { x: 4, y: 4 }, { x: 6.5, y: 9 }).project;
  const ground = sortedStoreys(building(p))[0];
  const south = ground.walls.find((w) => w.part === "shell")!;
  return replaceStorey(p, addEntrance(ground, south.id, 6, entranceSize));
}

describe("building outline", () => {
  it("a new project is an empty lot at the first step", () => {
    const p = createProject();
    expect(p.stage).toBe("lot");
    expect(building(p).structure.footprint).toEqual([]);
    expect(getActiveStorey(p).walls).toEqual([]);
  });

  it("draws the outside walls so that the base area is the drawn outline", () => {
    const p = withOutline();
    const ground = getActiveStorey(p);
    expect(ground.walls).toHaveLength(4);
    expect(ground.walls.every((w) => w.part === "shell" && w.kind === "exterior")).toBe(true);
    expect(ground.spaces).toHaveLength(1);
    expect(ringArea(building(p).structure.footprint)).toBeCloseTo(120, 6);
    // Measured back from the walls, to their outside faces.
    expect(regionArea(buildingFootprint(p.site, "lowestStorey"))).toBeCloseTo(120, 4);
  });

  it("takes an outline drawn either way round and refuses one that crosses itself", () => {
    const p = createProject();
    const reversed = setFootprint(p, id(p), RECT.slice().reverse());
    expect(ringArea(building(reversed).structure.footprint)).toBeCloseTo(120, 6);
    expect(getActiveStorey(reversed).walls).toHaveLength(4);
    const bow = [RECT[0], RECT[2], RECT[1], RECT[3]];
    expect(setFootprint(p, id(p), bow)).toBe(p);
  });

  it("moving a corner redraws the walls and keeps a door where it stood", () => {
    let p = withOutline();
    const ground = getActiveStorey(p);
    const wall = ground.walls[0];
    p = replaceStorey(p, addEntrance(ground, wall.id, 3, entranceSize));
    const moved = moveFootprintCorner(p, id(p), 2, { x: 14, y: 10 });
    const after = getActiveStorey(moved);
    expect(after.walls.map((w) => w.id)).toEqual(ground.walls.map((w) => w.id));
    expect(after.openings).toHaveLength(1);
    expect(after.openings[0].entrance).toBe(true);
    expect(ringArea(building(moved).structure.footprint)).toBeCloseTo(130, 6);
  });

  it("clearing the outline removes the generated walls and keeps hand-drawn ones", () => {
    let p = withOutline();
    p = replaceStorey(p, addWall(getActiveStorey(p), { x: 6, y: 0.125 }, { x: 6, y: 9.875 }, 0.1));
    const cleared = clearFootprint(p, id(p));
    const walls = getActiveStorey(cleared).walls;
    expect(walls).toHaveLength(1);
    expect(walls[0].part).toBeUndefined();
  });

  it("moves with the building", () => {
    const p = moveBuilding(withOutline(), id(withOutline()), { x: 5, y: 0 });
    expect(p).toBeDefined();
    const q = withOutline();
    const moved = moveBuilding(q, id(q), { x: 5, y: -2 });
    expect(building(moved).structure.footprint[0]).toEqual({ x: 5, y: -2 });
    expect(rebuildStructure(moved, id(moved)).site.buildings[0].storeys[0].walls[0].a).toEqual(
      getActiveStorey(moved).walls[0].a,
    );
  });
});

describe("erker", () => {
  it("projects the upper storeys on every side by default", () => {
    let p = withOutline();
    p = rebuildStructure(addStorey(p, id(p)).project, id(p));
    p = setErkerDepth(p, id(p), 1.2);
    const upper = upperOutline(building(p).structure);
    expect(ringArea(upper)).toBeCloseTo(14.4 * 12.4, 6);
    const [ground, first] = sortedStoreys(building(p));
    expect(regionArea(buildingFootprint({ buildings: [{ ...building(p), storeys: [ground] }] }, "allStoreys"))).toBeCloseTo(120, 4);
    expect(regionArea(buildingFootprint({ buildings: [{ ...building(p), storeys: [first] }] }, "allStoreys"))).toBeCloseTo(
      14.4 * 12.4,
      4,
    );
  });

  it("projects only the sides that are switched on", () => {
    let p = setErkerDepth(withOutline(), id(withOutline()), 1);
    p = withOutline();
    p = setErkerDepth(p, id(p), 1);
    p = setAllErkerEdges(p, id(p), false);
    expect(upperOutline(building(p).structure)).toEqual(building(p).structure.footprint);
    // Edge 0 is the side from (0, 0) to (12, 0).
    p = setErkerEdge(p, id(p), 0);
    const upper = upperOutline(building(p).structure);
    expect(ringArea(upper)).toBeCloseTo(12 * 11, 6);
    expect(Math.min(...upper.map((q) => q.y))).toBeCloseTo(-1, 6);
    expect(Math.max(...upper.map((q) => q.y))).toBeCloseTo(10, 6);
    expect(Math.min(...upper.map((q) => q.x))).toBeCloseTo(0, 6);
  });

  it("a storey added later is drawn with the erker and the core", () => {
    let p = complete();
    p = setErkerDepth(p, id(p), 1);
    const added = addStorey(p, id(p));
    p = rebuildStructure(added.project, id(p));
    const top = getActiveStorey(p, added.storeyId);
    expect(top.walls.filter((w) => w.part === "shell")).toHaveLength(4);
    expect(top.walls.filter((w) => w.part === "core")).toHaveLength(8);
    expect(top.spaces.map((s) => s.type).sort()).toEqual(["corridor", "room", "stair"]);
  });
});

describe("hall, stairs and elevator", () => {
  it("are drawn on every storey and named", () => {
    const p = complete();
    for (const storey of building(p).storeys) {
      expect(storey.spaces.find((s) => s.type === "stair")?.name).toBe("Stairs");
      expect(storey.spaces.find((s) => s.type === "corridor")?.name).toBe("Hall");
    }
  });

  it("refuses a rectangle too small to be a room", () => {
    const p = withOutline();
    const r = addCoreElement(p, id(p), "elevator", { x: 1, y: 1 }, { x: 1.2, y: 3 });
    expect(r.id).toBeNull();
    expect(r.project).toBe(p);
  });

  it("removing one takes its walls off every storey", () => {
    let p = complete();
    const stair = building(p).structure.core.find((c) => c.kind === "stair")!;
    p = removeCoreElement(p, id(p), stair.id);
    for (const storey of building(p).storeys) {
      expect(storey.spaces.some((s) => s.type === "stair")).toBe(false);
      expect(storey.walls.filter((w) => w.part === "core")).toHaveLength(4);
    }
  });

  it("a copied storey keeps its generated walls through a rebuild, with their doors", () => {
    let p = complete();
    const ground = sortedStoreys(building(p))[0];
    const copy = copyStorey(p, ground.id);
    p = rebuildStructure(copy.project, id(p));
    const copied = getActiveStorey(p, copy.storeyId);
    expect(copied.walls.filter((w) => w.part).every((w) => w.id.startsWith(`${copied.id}:`))).toBe(true);
    expect(copied.openings).toHaveLength(1);
  });

  it("notices an edit that would move a generated wall", () => {
    const p = complete();
    const ground = sortedStoreys(building(p))[0];
    expect(structureIntact(ground, addWall(ground, { x: 9, y: 0.125 }, { x: 9, y: 9.875 }, 0.1))).toBe(true);
    const moved = { ...ground, walls: ground.walls.map((w, i) => (i === 0 ? { ...w, a: { x: -1, y: -1 } } : w)) };
    expect(structureIntact(ground, moved)).toBe(false);
    expect(structureIntact(ground, { ...ground, walls: ground.walls.slice(1) })).toBe(false);
  });
});

describe("workflow steps", () => {
  it("opens the apartments only when outline, entrance, hall and stairs are placed", () => {
    let p = createProject();
    expect(stageBlocker(p, "outline")).toBeNull();
    expect(stageBlocker(p, "erker")).toMatch(/outline/);
    expect(stageBlocker(p, "apartments")).toMatch(/outline.*entrance.*hall.*stairs/);
    expect(setStage(p, "apartments")).toBe(p);
    p = withOutline();
    expect(stageBlocker(p, "core")).toBeNull();
    expect(stageBlocker(p, "apartments")).toMatch(/entrance/);
    p = complete();
    expect(structureStatus(p)).toMatchObject({ hasOutline: true, entrances: 1, halls: 1, stairs: 1, elevators: 0 });
    expect(stageBlocker(p, "apartments")).toBeNull();
    expect(setStage(p, "apartments").stage).toBe("apartments");
  });

  it("a plan drawn before buildings had a structure stays at the apartments step", () => {
    const old: any = JSON.parse(serializeProject(createSampleProject()));
    old.schemaVersion = 4;
    delete old.stage;
    delete old.site.location;
    for (const b of old.site.buildings) delete b.structure;
    const loaded = parseProject(JSON.stringify(old));
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.stage).toBe("apartments");
    expect(loaded.site.location).toBeNull();
    expect(building(loaded).structure.footprint).toEqual([]);
    expect(stageBlocker(loaded, "apartments")).toBeNull();
  });

  it("survives saving and loading", () => {
    const p = { ...complete(), site: { ...complete().site, location: { lat: 41.99, lon: 21.43 } } };
    const loaded = parseProject(serializeProject(p));
    expect(loaded.site.location).toEqual({ lat: 41.99, lon: 21.43 });
    expect(building(loaded).structure).toEqual(building(p).structure);
    expect(stageBlocker(loaded, "apartments")).toBeNull();
  });
});

describe("map", () => {
  const origin = { lat: 41.9965, lon: 21.4314 };

  it("reads a pasted latitude and longitude", () => {
    expect(parseLatLon("41.9965, 21.4314")).toEqual(origin);
    expect(parseLatLon(" 41.9965 21.4314 ")).toEqual(origin);
    expect(parseLatLon("Skopje")).toBeNull();
    expect(parseLatLon("95, 10")).toBeNull();
  });

  it("goes to map pixels and back", () => {
    const back = fromWorldPixel(worldPixel(origin, 17), 17);
    expect(back.lat).toBeCloseTo(origin.lat, 9);
    expect(back.lon).toBeCloseTo(origin.lon, 9);
  });

  it("puts 100 m on the plan 100 m away on the earth", () => {
    const east = planToLocation(origin, { x: 100, y: 0 });
    const north = planToLocation(origin, { x: 0, y: -100 });
    // One degree of latitude is about 111.2 km; of longitude that times cos(latitude).
    expect((north.lat - origin.lat) * 111_200).toBeCloseTo(100, 0);
    expect((east.lon - origin.lon) * 111_320 * Math.cos((origin.lat * Math.PI) / 180)).toBeCloseTo(100, 0);
    expect(east.lat).toBeCloseTo(origin.lat, 9);
    // With north turned 90° clockwise on the plan, "up the plan" is west.
    const turned = planToLocation(origin, { x: 0, y: -100 }, 90);
    expect(turned.lon).toBeLessThan(origin.lon);
    expect(turned.lat).toBeCloseTo(origin.lat, 6);
  });

  it("covers the view with tiles placed around the origin", () => {
    const settings = parseMapSettings(mapSettingsJson);
    const zoom = tileZoomFor(origin.lat, 8, settings.maxZoom);
    expect(256 * metresPerPixel(origin.lat, zoom) * 8).toBeGreaterThanOrEqual(256);
    const tiles = tilesForPlan(origin, zoom, { minX: -60, minY: -40, maxX: 60, maxY: 40 }, settings.tileUrl);
    expect(tiles.length).toBeGreaterThan(0);
    expect(Math.min(...tiles.map((t) => t.x))).toBeLessThanOrEqual(-60);
    expect(Math.max(...tiles.map((t) => t.x + t.size))).toBeGreaterThanOrEqual(60);
    expect(Math.min(...tiles.map((t) => t.y))).toBeLessThanOrEqual(-40);
    expect(Math.max(...tiles.map((t) => t.y + t.size))).toBeGreaterThanOrEqual(40);
    expect(tiles[0].url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    expect(tilesForPlan(origin, 19, { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }, settings.tileUrl)).toEqual([]);
  });
});
