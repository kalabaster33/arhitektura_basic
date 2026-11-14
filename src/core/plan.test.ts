import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import editorDefaults from "../config/editorDefaults.json";
import roomChecks from "../config/roomChecks.json";
import {
  apartmentOfSpace,
  assignSpace,
  createApartment,
  deleteApartment,
  describeApartments,
  renameApartment,
} from "./apartments.ts";
import { computeApartmentAreas, computeStoreyAreas, parseAreaConfig } from "./areas.ts";
import { copyStorey } from "./building.ts";
import { checkBuildingPlan, checkStoreyPlan, parseRoomCheckConfig } from "./checks.ts";
import { addWall, deleteWall, moveNode, moveWall, updateSpace } from "./edit.ts";
import { dist } from "./geometry.ts";
import type { Storey, Wall } from "./model.ts";
import {
  addOpening,
  deleteOpening,
  fitOffset,
  locateOnWall,
  moveOpening,
  openingGeometry,
  openingSides,
  updateOpening,
} from "./openings.ts";
import {
  createSampleProject,
  createStorey,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "./project.ts";
import { syncSpaces } from "./spaces.ts";

const areaConfig = parseAreaConfig(areaDefinitions);
const checkConfig = parseRoomCheckConfig(roomChecks);
const DOOR = editorDefaults.openings.door; // 0.9 wide
const WINDOW = editorDefaults.openings.window; // 1.2 wide

/**
 * The sample plan: an 8 x 6 m shell (walls 0.25) with a partition at x = 5 and
 * one from it to the east wall at y = 3.5 (walls 0.1). Three rooms: west,
 * north-east (y below 3.5) and south-east.
 */
function sample() {
  const project = createSampleProject();
  const storey = getActiveStorey(project);
  const wallAt = (x1: number, y1: number, x2: number, y2: number): Wall =>
    storey.walls.find((w) => w.a.x === x1 && w.a.y === y1 && w.b.x === x2 && w.b.y === y2)!;
  const room = (test: (x: number, y: number) => boolean) =>
    storey.spaces.find((s) => test(s.anchor.x, s.anchor.y))!.id;
  return {
    project,
    storey,
    north: wallAt(0, 0, 8, 0),
    east: wallAt(8, 0, 8, 6),
    partition: wallAt(5, 0, 5, 6),
    cross: wallAt(5, 3.5, 8, 3.5),
    west: room((x) => x < 5),
    ne: room((x, y) => x > 5 && y < 3.5),
    se: room((x, y) => x > 5 && y > 3.5),
  };
}

const only = (storey: Storey) => {
  expect(storey.openings).toHaveLength(1);
  return storey.openings[0];
};

describe("openings", () => {
  it("adds a door where it is asked for", () => {
    const { storey, north } = sample();
    const door = only(addOpening(storey, north.id, "door", 2, { ...DOOR, sill: 0.4 }));
    expect(door).toMatchObject({ wallId: north.id, kind: "door", offset: 2, width: 0.9, height: 2.1 });
    expect(door.sill).toBe(0); // a door has no sill
  });

  it("keeps an opening clear of the wall at the corner", () => {
    const { storey, north } = sample();
    // The west wall is 0.25 thick, so the north wall is free from 0.125.
    expect(only(addOpening(storey, north.id, "door", 0.2, DOOR)).offset).toBeCloseTo(0.575, 6);
  });

  it("keeps an opening clear of a wall that joins along the way", () => {
    const { storey, north } = sample();
    // The partition (0.1 thick) meets the north wall at 5.
    expect(only(addOpening(storey, north.id, "door", 5.1, DOOR)).offset).toBeCloseTo(5.5, 6);
  });

  it("keeps an opening clear of the wall its own wall ends on", () => {
    const { storey, cross } = sample();
    expect(only(addOpening(storey, cross.id, "door", 0, DOOR)).offset).toBeCloseTo(0.5, 6);
  });

  it("does not let two openings overlap", () => {
    const { storey, north } = sample();
    const withDoor = addOpening(storey, north.id, "door", 2, DOOR);
    const both = addOpening(withDoor, north.id, "window", 2.2, WINDOW);
    expect(both.openings).toHaveLength(2);
    expect(both.openings[1].offset).toBeCloseTo(3.05, 6); // door ends at 2.45
  });

  it("refuses an opening that fits nowhere on the wall", () => {
    const { storey, cross } = sample();
    expect(fitOffset(storey, cross.id, 1.5, 3)).toBeNull();
    expect(addOpening(storey, cross.id, "window", 1.5, { ...WINDOW, width: 3 })).toBe(storey);
    expect(addOpening(storey, "no-such-wall", "door", 1, DOOR)).toBe(storey);
  });

  it("slides along the wall and stops at what is in the way", () => {
    const { storey, north } = sample();
    const placed = addOpening(storey, north.id, "door", 6, DOOR);
    const id = placed.openings[0].id;
    expect(only(moveOpening(placed, id, 100)).offset).toBeCloseTo(7.425, 6);
    expect(only(moveOpening(placed, id, 6.5)).offset).toBe(6.5);
    expect(moveOpening(placed, id, 6)).toBe(placed);
  });

  it("changes size and kind, and rejects sizes that make no sense", () => {
    const { storey, north } = sample();
    const placed = addOpening(storey, north.id, "window", 0.8, WINDOW);
    const id = placed.openings[0].id;
    expect(placed.openings[0].sill).toBe(0.9);
    // Wider: shifts right to stay clear of the corner.
    const wider = only(updateOpening(placed, id, { width: 2 }));
    expect(wider.width).toBe(2);
    expect(wider.offset).toBeCloseTo(1.125, 6);
    expect(only(updateOpening(placed, id, { kind: "door" })).sill).toBe(0);
    expect(updateOpening(placed, id, { width: 0 })).toBe(placed);
    expect(updateOpening(placed, id, { width: 6 })).toBe(placed);
    expect(updateOpening(placed, id, { height: -1 })).toBe(placed);
  });

  it("deletes an opening, and a deleted wall takes its openings with it", () => {
    const { storey, north, cross } = sample();
    let s = addOpening(storey, north.id, "window", 2, WINDOW);
    s = addOpening(s, cross.id, "door", 1.5, DOOR);
    expect(deleteOpening(s, s.openings[0].id).openings.map((o) => o.wallId)).toEqual([cross.id]);
    expect(deleteWall(s, cross.id).openings.map((o) => o.wallId)).toEqual([north.id]);
  });

  it("stays where it stood in the plan when the start of its wall moves", () => {
    const { storey, north } = sample();
    const placed = addOpening(storey, north.id, "door", 2, DOOR);
    const moved = moveNode(placed, { x: 0, y: 0 }, { x: -1, y: 0 });
    const door = only(moved);
    expect(door.offset).toBeCloseTo(3, 6);
    const wall = moved.walls.find((w) => w.id === north.id)!;
    expect(openingGeometry(wall, door).centre.x).toBeCloseTo(2, 6);
  });

  it("moves with its wall", () => {
    const { storey, partition } = sample();
    const placed = addOpening(storey, partition.id, "door", 1.5, DOOR);
    const moved = moveWall(placed, partition.id, { x: -1, y: 0 });
    const wall = moved.walls.find((w) => w.id === partition.id)!;
    expect(openingGeometry(wall, only(moved)).centre).toEqual({ x: 4, y: 1.5 });
  });

  it("is dropped when its wall becomes too short for it", () => {
    const { storey, north } = sample();
    const placed = addOpening(storey, north.id, "door", 2, DOOR);
    const squeezed = moveNode(placed, { x: 8, y: 0 }, { x: 1, y: 0 });
    expect(squeezed.openings).toEqual([]);
  });

  it("steps aside when a new wall lands on it", () => {
    const { storey, north } = sample();
    const placed = addOpening(storey, north.id, "door", 2, DOOR);
    const door = only(addWall(placed, { x: 2, y: 0 }, { x: 2, y: 6 }, 0.1));
    // The new wall covers 1.95..2.05; the door (0.9 wide) must be wholly to one side.
    expect(Math.abs(door.offset - 2)).toBeCloseTo(0.5, 6);
  });

  it("knows the rooms on its two sides", () => {
    const { storey, north, partition, west, ne } = sample();
    let s = addOpening(storey, partition.id, "door", 1.5, DOOR);
    s = addOpening(s, north.id, "window", 2, WINDOW);
    expect(openingSides(s, s.openings[0]).slice().sort()).toEqual([west, ne].sort());
    const outside = openingSides(s, s.openings[1]);
    expect(outside).toContain(west);
    expect(outside).toContain(null);
  });

  it("finds the wall under a point", () => {
    const { storey, partition } = sample();
    const hit = locateOnWall(storey, { x: 5.2, y: 2 }, 0.3)!;
    expect(hit.wallId).toBe(partition.id);
    expect(hit.offset).toBeCloseTo(2, 6);
    expect(locateOnWall(storey, { x: 2.5, y: 3 }, 0.3)).toBeNull();
  });

  it("is copied with its storey and survives save and load", () => {
    const { project, storey, north } = sample();
    const withDoor = replaceStorey(project, addOpening(storey, north.id, "door", 2, DOOR));
    const copied = copyStorey(withDoor, storey.id);
    const copy = getActiveStorey(copied.project, copied.storeyId);
    const door = only(copy);
    expect(door.id).not.toBe(getActiveStorey(withDoor).openings[0].id);
    expect(copy.walls.some((w) => w.id === door.wallId)).toBe(true);
    expect(parseProject(serializeProject(copied.project))).toEqual(copied.project);
  });

  it("is left out on load when its wall is missing", () => {
    const { project, storey, north } = sample();
    const placed = addOpening(storey, north.id, "door", 2, DOOR);
    const orphan = { ...placed.openings[0], id: "orphan", wallId: "gone" };
    const saved = serializeProject(
      replaceStorey(project, { ...placed, openings: [...placed.openings, orphan] }),
    );
    expect(getActiveStorey(parseProject(saved)).openings.map((o) => o.id)).toEqual([
      placed.openings[0].id,
    ]);
  });
});

describe("apartments", () => {
  it("creates apartments with their own names", () => {
    const { storey, ne, se, west } = sample();
    const a = createApartment(storey, [ne, se]);
    const b = createApartment(a.storey, [west, "no-such-room"]);
    expect(b.storey.apartments.map((x) => x.name)).toEqual(["Apartment 1", "Apartment 2"]);
    expect(b.storey.apartments[0].spaceIds).toEqual([ne, se]);
    expect(b.storey.apartments[1].spaceIds).toEqual([west]);
  });

  it("keeps a room in at most one apartment", () => {
    const { storey, ne, se } = sample();
    const a = createApartment(storey, [ne, se]);
    const b = createApartment(a.storey, [se]);
    expect(b.storey.apartments[0].spaceIds).toEqual([ne]);
    expect(apartmentOfSpace(b.storey, se)?.id).toBe(b.apartmentId);

    const back = assignSpace(b.storey, se, a.apartmentId);
    expect(back.apartments.map((x) => x.spaceIds)).toEqual([[ne, se], []]);
    const none = assignSpace(back, ne, null);
    expect(apartmentOfSpace(none, ne)).toBeUndefined();
    expect(assignSpace(back, "no-such-room", a.apartmentId)).toBe(back);
    expect(assignSpace(back, ne, "no-such-apartment")).toBe(back);
  });

  it("renames and deletes without touching the rooms", () => {
    const { storey, ne } = sample();
    const { storey: s, apartmentId } = createApartment(storey, [ne]);
    expect(renameApartment(s, apartmentId, "A1").apartments[0].name).toBe("A1");
    const gone = deleteApartment(s, apartmentId);
    expect(gone.apartments).toEqual([]);
    expect(gone.spaces).toBe(s.spaces);
  });

  it("derives the outline and its facade edges", () => {
    const { storey, ne, se } = sample();
    const [info] = describeApartments(createApartment(storey, [ne, se]).storey);
    expect(info.pieces).toBe(1);
    // Centreline outline of the two east rooms: 3 x 6 m.
    let area = 0;
    let facade = 0;
    info.outline.forEach((p, i) => {
      const q = info.outline[(i + 1) % info.outline.length];
      area += (p.x * q.y - q.x * p.y) / 2;
      if (info.facadeEdges.includes(i)) facade += dist(p, q);
    });
    expect(area).toBeCloseTo(18, 6); // positive: interior on the left
    expect(facade).toBeCloseTo(12, 6); // north 3 + east 6 + south 3; the partition is not facade
  });

  it("reports rooms that do not touch as separate pieces", () => {
    let n = 0;
    const box = (x: number): Wall[] =>
      [
        [x, 0, x + 3, 0],
        [x + 3, 0, x + 3, 3],
        [x + 3, 3, x, 3],
        [x, 3, x, 0],
      ].map(([x1, y1, x2, y2]) => ({
        id: `b${++n}`,
        a: { x: x1, y: y1 },
        b: { x: x2, y: y2 },
        thickness: 0.2,
        kind: "exterior" as const,
      }));
    const storey = syncSpaces({ ...createStorey(), walls: [...box(0), ...box(10)] });
    const apt = createApartment(storey, storey.spaces.map((s) => s.id));
    expect(describeApartments(apt.storey)[0].pieces).toBe(2);
    expect(describeApartments(createApartment(storey).storey)[0]).toMatchObject({
      pieces: 0,
      outline: [],
      facadeEdges: [],
    });
  });

  it("finds the entrance: a door that leads out of the apartment", () => {
    const { storey, north, partition, cross, west, ne, se } = sample();
    let s = createApartment(storey, [ne, se]).storey;
    s = addOpening(s, cross.id, "door", 1.5, DOOR); // between its own two rooms
    s = addOpening(s, north.id, "window", 6, WINDOW); // a window is not a way in
    expect(describeApartments(s)[0].entrances).toEqual([]);

    s = addOpening(s, partition.id, "door", 1.5, DOOR);
    const entrance = describeApartments(s)[0].entrances;
    expect(entrance).toEqual([
      { openingId: s.openings[2].id, position: { x: 5, y: 1.5 }, outsideSpaceId: west },
    ]);

    s = addOpening(s, north.id, "door", 7.2, DOOR); // straight to the outside
    expect(describeApartments(s)[0].entrances.map((e) => e.outsideSpaceId)).toEqual([west, null]);
  });

  it("totals areas per apartment and leaves the rest as common area", () => {
    const { storey, ne, se, west } = sample();
    const s = createApartment(storey, [ne, se]).storey;
    const areas = computeStoreyAreas(s, areaConfig);
    const split = computeApartmentAreas(s, areaConfig, areas);
    const net = (id: string) => areas.spaces.find((r) => r.spaceId === id)!.net;
    expect(split.apartments).toHaveLength(1);
    expect(split.apartments[0].spaces.map((r) => r.spaceId).sort()).toEqual([ne, se].sort());
    expect(split.apartments[0].totals.net).toBeCloseTo(net(ne) + net(se), 9);
    expect(split.common.spaces.map((r) => r.spaceId)).toEqual([west]);
    expect(split.apartments[0].totals.net + split.common.totals.net).toBeCloseTo(areas.totals.net, 9);
    expect(computeApartmentAreas(storey, areaConfig).common.totals.net).toBeCloseTo(areas.totals.net, 9);
  });
});

describe("plan checks", () => {
  const kinds = (storey: Storey) => checkStoreyPlan(storey, checkConfig).map((i) => i.kind);

  it("reads its config and rejects unknown room types", () => {
    expect(checkConfig.daylightSpaceTypes).toContain("bedroom");
    expect(() => parseRoomCheckConfig({ ...roomChecks, daylightSpaceTypes: ["cellar"] })).toThrow(
      /unknown space type/,
    );
    expect(() => parseRoomCheckConfig({ daylightSpaceTypes: [] })).toThrow(/doorExemptSpaceTypes/);
  });

  it("warns about every room without a door", () => {
    const { storey, partition, cross, west, ne, se } = sample();
    const issues = checkStoreyPlan(storey, checkConfig);
    expect(issues.map((i) => i.kind)).toEqual(["roomNoDoor", "roomNoDoor", "roomNoDoor"]);
    expect(issues.map((i) => i.spaceId).sort()).toEqual([west, ne, se].sort());

    const oneDoor = addOpening(storey, partition.id, "door", 1.5, DOOR); // west <-> north-east
    expect(checkStoreyPlan(oneDoor, checkConfig).map((i) => i.spaceId)).toEqual([se]);
    expect(kinds(addOpening(oneDoor, cross.id, "door", 1.5, DOOR))).toEqual([]);
  });

  it("does not expect a door on a shaft, and a window is not a door", () => {
    const { storey, north, partition, cross, se } = sample();
    let s = addOpening(storey, partition.id, "door", 1.5, DOOR);
    s = addOpening(s, north.id, "window", 2, WINDOW);
    expect(kinds(updateSpace(s, se, { type: "shaft" }))).toEqual([]);
    expect(kinds(addOpening(s, cross.id, "window", 1.5, WINDOW))).toEqual(["roomNoDoor"]);
  });

  it("warns when a living room or bedroom has no window in an exterior wall", () => {
    const { storey, east, partition, cross, ne } = sample();
    let s = addOpening(storey, partition.id, "door", 1.5, DOOR);
    s = addOpening(s, cross.id, "door", 1.5, DOOR);
    s = updateSpace(s, ne, { type: "bedroom", name: "Bedroom" });
    const [issue] = checkStoreyPlan(s, checkConfig);
    expect(issue).toMatchObject({ kind: "roomNoDaylight", spaceId: ne });
    expect(issue.message).toContain("Bedroom");

    // A window to the next room does not count; one in the east facade does.
    expect(kinds(addOpening(s, partition.id, "window", 2.8, { ...WINDOW, width: 0.6 }))).toEqual([
      "roomNoDaylight",
    ]);
    expect(kinds(addOpening(s, east.id, "window", 1.5, WINDOW))).toEqual([]);
  });

  it("warns about an apartment with no entrance door", () => {
    const { storey, partition, cross, ne, se } = sample();
    let s = createApartment(storey, [ne, se]).storey;
    s = createApartment(s).storey; // an empty apartment is not reported
    s = addOpening(s, cross.id, "door", 1.5, DOOR);
    const issues = checkStoreyPlan(s, checkConfig);
    expect(issues.filter((i) => i.kind === "apartmentNoEntrance")).toEqual([
      expect.objectContaining({ apartmentId: s.apartments[0].id }),
    ]);
    const entered = addOpening(s, partition.id, "door", 1.5, DOOR);
    expect(kinds(entered)).toEqual([]);
  });

  it("checks every storey of the building", () => {
    const { project, storey } = sample();
    const two = copyStorey(project, storey.id).project;
    const issues = checkBuildingPlan(two.site.buildings[0], checkConfig);
    expect(issues).toHaveLength(6);
    expect(new Set(issues.map((i) => i.storeyId)).size).toBe(2);
  });
});
