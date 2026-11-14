import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import { generateLayouts } from "../roomSubdivision.ts";
import { type AreaConfig, computeStoreyAreas, parseAreaConfig } from "./areas.ts";
import { addWall, deleteWall, moveNode, moveWall, setWallLength, setWallThickness, updateSpace } from "./edit.ts";
import {
  interiorPoint,
  offsetRingLeft,
  pointInPolygon,
  polygonArea,
  ringSignedArea,
  roundTo,
} from "./geometry.ts";
import { type Storey, type Wall, SCHEMA_VERSION } from "./model.ts";
import {
  createProject,
  createSampleProject,
  createStorey,
  getActiveStorey,
  parseProject,
  serializeProject,
} from "./project.ts";
import { linkSpaces, syncSpaces } from "./spaces.ts";
import { buildTopology } from "./topology.ts";
import { parseLength } from "./units.ts";

let seq = 0;
const wall = (x1: number, y1: number, x2: number, y2: number, thickness = 0.2): Wall => ({
  id: `w${++seq}`,
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
  thickness,
  kind: "interior",
});

/** Four walls around a w x h rectangle with its corner at (x, y). */
const box = (x: number, y: number, w: number, h: number, t = 0.2): Wall[] => [
  wall(x, y, x + w, y, t),
  wall(x + w, y, x + w, y + h, t),
  wall(x + w, y + h, x, y + h, t),
  wall(x, y + h, x, y, t),
];

const storeyOf = (walls: Wall[]): Storey => syncSpaces({ ...createStorey(), walls });
const sorted = (xs: number[]) => xs.slice().sort((a, b) => a - b);
const config = parseAreaConfig(areaDefinitions);

describe("geometry", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const hole = [
    { x: 2, y: 2 },
    { x: 4, y: 2 },
    { x: 4, y: 5 },
    { x: 2, y: 5 },
  ];

  it("shoelace area is signed by winding", () => {
    expect(ringSignedArea(square)).toBeCloseTo(100);
    expect(ringSignedArea(square.slice().reverse())).toBeCloseTo(-100);
  });

  it("shoelace area of an L shape", () => {
    const L = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 5 },
      { x: 0, y: 5 },
    ];
    expect(polygonArea(L)).toBeCloseTo(12 + 6);
  });

  it("shoelace area with holes, whatever the winding of the holes", () => {
    expect(polygonArea(square, [hole])).toBeCloseTo(100 - 6);
    expect(polygonArea(square, [hole.slice().reverse()])).toBeCloseTo(94);
    const hole2 = hole.map((p) => ({ x: p.x + 4, y: p.y }));
    expect(polygonArea(square.slice().reverse(), [hole, hole2])).toBeCloseTo(88);
  });

  it("point in polygon respects holes", () => {
    expect(pointInPolygon({ x: 1, y: 1 }, square, [hole])).toBe(true);
    expect(pointInPolygon({ x: 3, y: 3 }, square, [hole])).toBe(false);
    expect(pointInPolygon({ x: 11, y: 3 }, square, [hole])).toBe(false);
  });

  it("offsets each edge by its own distance", () => {
    const inner = offsetRingLeft(square, [1, 2, 1, 2]);
    expect(ringSignedArea(inner)).toBeCloseTo((10 - 4) * (10 - 2));
    const outer = offsetRingLeft(square.slice().reverse(), [1, 1, 1, 1]);
    expect(Math.abs(ringSignedArea(outer))).toBeCloseTo(144);
  });

  it("interior point avoids holes", () => {
    const big = [
      { x: 3, y: 1 },
      { x: 7, y: 1 },
      { x: 7, y: 9 },
      { x: 3, y: 9 },
    ];
    const p = interiorPoint(square, [big]);
    expect(pointInPolygon(p, square, [big])).toBe(true);
  });

  it("snaps to the grid without binary noise", () => {
    expect(roundTo(3.2249, 0.05)).toBe(3.2);
    expect(roundTo(3.226, 0.05)).toBe(3.25);
    expect(roundTo(0.1 + 0.2, 0.05)).toBe(0.3);
  });
});

describe("wall-to-room linking: topology", () => {
  it("finds the room enclosed by four walls", () => {
    const { faces, outlines } = buildTopology(box(0, 0, 4, 3));
    expect(faces).toHaveLength(1);
    expect(faces[0].centrelineArea).toBeCloseTo(12);
    expect(faces[0].netArea).toBeCloseTo(3.8 * 2.8);
    expect(faces[0].wallIds).toHaveLength(4);
    expect(outlines).toHaveLength(1);
    expect(outlines[0].outerFaceArea).toBeCloseTo(4.2 * 3.2);
  });

  it("does not depend on the order or direction the walls were drawn in", () => {
    const walls = box(0, 0, 4, 3).reverse();
    [walls[1].a, walls[1].b] = [walls[1].b, walls[1].a];
    expect(buildTopology(walls).faces[0].netArea).toBeCloseTo(3.8 * 2.8);
  });

  it("no room until the walls close", () => {
    expect(buildTopology(box(0, 0, 4, 3).slice(0, 3)).faces).toHaveLength(0);
  });

  it("a partition meeting walls mid-span makes two rooms", () => {
    const { faces } = buildTopology([...box(0, 0, 6, 4), wall(2, 0, 2, 4, 0.1)]);
    expect(sorted(faces.map((f) => f.netArea))).toEqual([
      expect.closeTo(1.85 * 3.8, 6),
      expect.closeTo(3.85 * 3.8, 6),
    ]);
    // The partition bounds both rooms.
    const shared = faces[0].wallIds.filter((id) => faces[1].wallIds.includes(id));
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });

  it("walls that cross are cut at the crossing", () => {
    const { faces } = buildTopology([...box(0, 0, 4, 4), wall(2, -1, 2, 5)]);
    expect(faces).toHaveLength(2);
    expect(faces[0].centrelineArea).toBeCloseTo(8);
    expect(faces[1].centrelineArea).toBeCloseTo(8);
  });

  it("a wall stub is cut out of the room it pokes into", () => {
    const { faces } = buildTopology([...box(0, 0, 4, 3), wall(0, 1.5, 1, 1.5, 0.1)]);
    expect(faces).toHaveLength(1);
    // Stub runs from the inner wall face (x = 0.1) to its square end (x = 1.05).
    expect(faces[0].netArea).toBeCloseTo(3.8 * 2.8 - 0.95 * 0.1);
  });

  it("an enclosed core inside a room is a hole in it and a room of its own", () => {
    const { faces, outlines } = buildTopology([...box(0, 0, 6, 6), ...box(2, 2, 1, 1)]);
    expect(faces).toHaveLength(2);
    const [core, room] = faces.slice().sort((a, b) => a.netArea - b.netArea);
    expect(core.netArea).toBeCloseTo(0.8 * 0.8);
    expect(room.holes).toHaveLength(1);
    expect(room.netArea).toBeCloseTo(5.8 * 5.8 - 1.2 * 1.2);
    expect(room.centrelineArea).toBeCloseTo(36 - 1);
    expect(room.wallIds).toHaveLength(8);
    expect(outlines).toHaveLength(1);
    expect(outlines[0].outerFaceArea).toBeCloseTo(6.2 * 6.2);
  });

  it("a free-standing wall inside a room takes its footprint off the net area", () => {
    const { faces } = buildTopology([...box(0, 0, 6, 6), wall(2, 3, 4, 3, 0.2)]);
    expect(faces).toHaveLength(1);
    expect(faces[0].netArea).toBeCloseTo(5.8 * 5.8 - 2.2 * 0.2);
  });

  it("two separate buildings give two outlines", () => {
    const { faces, outlines } = buildTopology([...box(0, 0, 4, 3), ...box(10, 0, 4, 3)]);
    expect(faces).toHaveLength(2);
    expect(outlines).toHaveLength(2);
  });

  it("handles walls that are not axis-aligned", () => {
    const tri = [wall(0, 0, 6, 0, 0), wall(6, 0, 0, 8, 0), wall(0, 8, 0, 0, 0)];
    expect(buildTopology(tri).faces[0].netArea).toBeCloseTo(24);
  });
});

describe("wall-to-room linking: spaces", () => {
  it("creates one space per room, with the walls that bound it", () => {
    const storey = storeyOf([...box(0, 0, 6, 4), wall(2, 0, 2, 4, 0.1)]);
    expect(storey.spaces.map((s) => s.name)).toEqual(["Room 1", "Room 2"]);
    for (const s of storey.spaces) expect(s.wallIds.length).toBeGreaterThanOrEqual(4);
  });

  it("moving a wall recalculates the areas and keeps the rooms' identity", () => {
    const partition = wall(2, 0, 2, 4, 0.1);
    let storey = storeyOf([...box(0, 0, 6, 4), partition]);
    const left = storey.spaces.find((s) => s.anchor.x < 2)!;
    storey = updateSpace(storey, left.id, { name: "Bedroom", type: "bedroom" });
    const before = computeStoreyAreas(storey, config);

    storey = moveWall(storey, partition.id, { x: 1, y: 0 });
    const after = computeStoreyAreas(storey, config);

    const net = (areas: typeof before, id: string) => areas.spaces.find((s) => s.spaceId === id)!.net;
    expect(net(before, left.id)).toBeCloseTo(1.85 * 3.8);
    expect(net(after, left.id)).toBeCloseTo(2.85 * 3.8);
    expect(after.spaces.find((s) => s.spaceId === left.id)!.name).toBe("Bedroom");
    expect(after.totals.net).toBeCloseTo(before.totals.net);
    expect(storey.spaces.map((s) => s.id).sort()).toEqual(before.spaces.map((s) => s.spaceId).sort());
  });

  it("a room keeps its identity when a wall is dragged past its anchor", () => {
    const partition = wall(3, 0, 3, 4, 0.1);
    let storey = storeyOf([...box(0, 0, 6, 4), partition]);
    const right = storey.spaces.find((s) => s.anchor.x > 3)!;
    storey = updateSpace(storey, right.id, { name: "Kitchen" });
    storey = moveWall(storey, partition.id, { x: 2.5, y: 0 }); // now beyond the old anchor
    const kitchen = storey.spaces.find((s) => s.name === "Kitchen")!;
    expect(kitchen.id).toBe(right.id);
    expect(kitchen.anchor.x).toBeGreaterThan(5.5);
  });

  it("a wall that ends on a moved wall follows it (T-junctions stay closed)", () => {
    let storey = getActiveStorey(createSampleProject());
    const [bottom, , , , partition, branch] = storey.walls; // branch runs from the partition to the east wall
    storey = moveWall(storey, partition.id, { x: -0.5, y: 0 });
    expect(storey.spaces).toHaveLength(3);
    expect(storey.walls.find((w) => w.id === branch.id)!.a).toEqual({ x: 4.5, y: 3.5 });

    // Moving the south wall takes the foot of the partition with it.
    storey = moveWall(storey, bottom.id, { x: 0, y: -1 });
    expect(storey.spaces).toHaveLength(3);
    expect(storey.walls.find((w) => w.id === partition.id)!.a).toEqual({ x: 4.5, y: -1 });
  });

  it("a T-junction end can still be dragged off its wall on purpose", () => {
    let storey = getActiveStorey(createSampleProject());
    const branch = storey.walls[5];
    storey = moveNode(storey, branch.a, { x: 6, y: 3.5 });
    expect(storey.walls.find((w) => w.id === branch.id)!.a).toEqual({ x: 6, y: 3.5 });
    expect(storey.spaces).toHaveLength(2);
  });

  it("moving a corner drags every wall joined there", () => {
    let storey = storeyOf(box(0, 0, 4, 3, 0));
    storey = moveNode(storey, { x: 4, y: 3 }, { x: 5, y: 3 });
    expect(storey.spaces).toHaveLength(1);
    expect(computeStoreyAreas(storey, config).totals.net).toBeCloseTo(13.5);
  });

  it("typing a wall length moves the joined walls too", () => {
    const walls = box(0, 0, 4, 3, 0);
    let storey = storeyOf(walls);
    storey = setWallLength(storey, walls[0].id, 5); // bottom wall, moves the corner at (4, 0)
    expect(storey.walls[1].a).toEqual({ x: 5, y: 0 });
    expect(computeStoreyAreas(storey, config).totals.net).toBeCloseTo(13.5);
  });

  it("thicker walls mean less net area", () => {
    const walls = box(0, 0, 4, 3, 0.2);
    let storey = storeyOf(walls);
    storey = setWallThickness(storey, walls[0].id, 0.4);
    expect(computeStoreyAreas(storey, config).totals.net).toBeCloseTo(3.8 * 2.7);
  });

  it("splitting a room adds a space, removing the wall merges them back", () => {
    let storey = storeyOf(box(0, 0, 6, 4));
    const original = storey.spaces[0].id;
    storey = addWall(storey, { x: 3, y: 0 }, { x: 3, y: 4 }, 0.1);
    expect(storey.spaces).toHaveLength(2);
    expect(storey.spaces.some((s) => s.id === original)).toBe(true);
    const added = storey.walls[storey.walls.length - 1].id;
    storey = deleteWall(storey, added);
    expect(storey.spaces.map((s) => s.id)).toEqual([original]);
  });

  it("opening the shell removes the room and its references", () => {
    const walls = box(0, 0, 4, 3);
    let storey = storeyOf(walls);
    storey = {
      ...storey,
      apartments: [{ id: "apt", name: "A1", spaceIds: [storey.spaces[0].id] }],
    };
    storey = deleteWall(storey, walls[0].id);
    expect(storey.spaces).toHaveLength(0);
    expect(storey.apartments[0].spaceIds).toEqual([]);
  });

  it("links every stored space to a room", () => {
    const storey = getActiveStorey(createSampleProject());
    expect(storey.spaces).toHaveLength(3);
    expect(linkSpaces(storey).faceBySpaceId.size).toBe(3);
  });
});

describe("areas", () => {
  const storey = storeyOf([...box(0, 0, 6, 4), wall(2, 0, 2, 4, 0.1)]);

  it("net, useful and gross follow the shipped definitions", () => {
    const areas = computeStoreyAreas(storey, config);
    expect(areas.totals.net).toBeCloseTo((1.85 + 3.85) * 3.8);
    expect(areas.totals.useful).toBeCloseTo(areas.totals.net);
    expect(areas.totals.gross).toBeCloseTo(6.2 * 4.2);
    expect(sorted(areas.spaces.map((s) => s.gross))).toEqual([
      expect.closeTo(8, 6),
      expect.closeTo(16, 6),
    ]);
  });

  it("the definitions come from the config, not from code", () => {
    const custom: AreaConfig = {
      ...config,
      net: { boundary: "wallCentreline" },
      useful: { defaultFactor: 1, factorBySpaceType: { storage: 0.5 } },
      gross: { space: "wallInnerFace", storey: "wallCentreline" },
    };
    const small = storey.spaces.find((s) => s.anchor.x < 2)!;
    const areas = computeStoreyAreas(updateSpace(storey, small.id, { type: "storage" }), custom);
    const row = areas.spaces.find((s) => s.spaceId === small.id)!;
    expect(row.net).toBeCloseTo(8);
    expect(row.useful).toBeCloseTo(4);
    expect(row.gross).toBeCloseTo(1.85 * 3.8);
    expect(areas.totals.net).toBeCloseTo(24);
    expect(areas.totals.useful).toBeCloseTo(20);
    expect(areas.totals.gross).toBeCloseTo(24);
  });

  it("rejects a broken config", () => {
    expect(() => parseAreaConfig({ ...areaDefinitions, net: { boundary: "outside" } })).toThrow(
      /net\.boundary/,
    );
  });
});

describe("project files", () => {
  it("round-trips through versioned JSON", () => {
    const project = createSampleProject();
    const json = serializeProject(project);
    expect(JSON.parse(json).schemaVersion).toBe(SCHEMA_VERSION);
    expect(parseProject(json)).toEqual(project);
  });

  it("has the full hierarchy", () => {
    const storey = createProject().site.buildings[0].storeys[0];
    expect(Object.keys(storey)).toEqual(
      expect.arrayContaining(["walls", "openings", "spaces", "apartments", "circulation"]),
    );
  });

  it("refuses files it cannot read", () => {
    expect(() => parseProject("{")).toThrow(/not valid JSON/);
    expect(() => parseProject("{}")).toThrow(/schemaVersion/);
    const future = { ...createProject(), schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => parseProject(JSON.stringify(future))).toThrow(/newer version/);
  });
});

describe("typed dimensions", () => {
  it("reads metres, centimetres and millimetres", () => {
    expect(parseLength("3.20 m")).toBe(3.2);
    expect(parseLength("3,2")).toBe(3.2);
    expect(parseLength("320 cm")).toBe(3.2);
    expect(parseLength("3200mm")).toBe(3.2);
    expect(parseLength(".5")).toBe(0.5);
  });

  it("rejects anything else", () => {
    expect(parseLength("")).toBeNull();
    expect(parseLength("three")).toBeNull();
    expect(parseLength("3 ft")).toBeNull();
  });
});

describe("layout engine", () => {
  it("roomSubdivision still generates layouts", () => {
    const layouts = generateLayouts(
      {
        polygon: [
          { x: 0, y: 0 },
          { x: 7, y: 0 },
          { x: 7, y: 8 },
          { x: 0, y: 8 },
        ],
        facadeEdges: [2],
        entrance: { x: 1, y: 0 },
      },
      {},
      1,
    );
    expect(layouts).toHaveLength(1);
    expect(layouts[0].rooms.map((r) => r.type)).toEqual(
      expect.arrayContaining(["living", "bedroom", "bathroom"]),
    );
  });
});
