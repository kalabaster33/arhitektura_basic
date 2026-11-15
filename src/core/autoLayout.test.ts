import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import editorDefaults from "../config/editorDefaults.json";
import layoutRules from "../config/layoutRules.json";
import roomChecks from "../config/roomChecks.json";
import { createApartment } from "./apartments.ts";
import { computeStoreyAreas, parseAreaConfig } from "./areas.ts";
import {
  type ApplyOptions,
  apartmentInteriorWalls,
  buildLayoutInput,
  parseLayoutRules,
  proposeLayouts,
} from "./autoLayout.ts";
import { checkStoreyPlan, parseRoomCheckConfig } from "./checks.ts";
import { setWallKind, updateSpace } from "./edit.ts";
import { polygonArea } from "./geometry.ts";
import type { Storey, Wall } from "./model.ts";
import { addOpening } from "./openings.ts";
import {
  createSampleProject,
  createStorey,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "./project.ts";
import { syncSpaces } from "./spaces.ts";

const rules = parseLayoutRules(layoutRules);
const areaConfig = parseAreaConfig(areaDefinitions);
const checkConfig = parseRoomCheckConfig(roomChecks);
const DOOR = editorDefaults.openings.door;
const options: ApplyOptions = { partitionThickness: 0.1, door: DOOR, snap: 0.05 };

/**
 * The sample plan (8 x 6 m shell, rooms west / north-east / south-east) with
 * the chosen rooms as one apartment and, unless told otherwise, a door into it.
 */
function plan(pick: "all" | "west" | "east", door = true) {
  const project = createSampleProject();
  const base = getActiveStorey(project);
  const wallAt = (x1: number, y1: number, x2: number, y2: number): Wall =>
    base.walls.find((w) => w.a.x === x1 && w.a.y === y1 && w.b.x === x2 && w.b.y === y2)!;
  const north = wallAt(0, 0, 8, 0);
  const partition = wallAt(5, 0, 5, 6);
  const cross = wallAt(5, 3.5, 8, 3.5);
  const rooms = base.spaces.filter((s) =>
    pick === "all" ? true : pick === "west" ? s.anchor.x < 5 : s.anchor.x > 5,
  );
  const made = createApartment(base, rooms.map((s) => s.id));
  let storey = made.storey;
  if (door) {
    storey =
      pick === "east"
        ? addOpening(storey, partition.id, "door", 1.5, DOOR) // from the west room
        : addOpening(storey, north.id, "door", 1, DOOR); // from outdoors
  }
  return { project, storey, apartmentId: made.apartmentId, north, partition, cross };
}

/** Four exterior walls, 0.2 thick, around a w x h rectangle; ids prefix1..prefix4. */
const box = (prefix: string, x: number, y: number, w: number, h: number): Wall[] =>
  [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ].map(([x1, y1, x2, y2], i) => ({
    id: `${prefix}${i + 1}`,
    a: { x: x1, y: y1 },
    b: { x: x2, y: y2 },
    thickness: 0.2,
    kind: "exterior" as const,
  }));

const proposalsOf = (storey: Storey, apartmentId: string) => {
  const result = proposeLayouts(storey, apartmentId, rules, options);
  if (!result.ok) throw new Error(result.reason);
  return result.proposals;
};

const reasonOf = (storey: Storey, apartmentId: string) => {
  const built = buildLayoutInput(storey, apartmentId);
  return built.ok ? "ok" : built.reason;
};

describe("layout rules", () => {
  it("reads the config and rejects damaged values", () => {
    expect(rules.roomSizes?.mainBedroom.minArea).toBe(12);
    expect(rules.bedroomAreaRange).toEqual([9, 16]);
    expect(rules.adjacency?.length).toBeGreaterThan(0);
    expect(() => parseLayoutRules({ ...layoutRules, rooms: { ...layoutRules.rooms, corridor: { minArea: 0, minWidth: 0 } } })).toThrow(/corridor/);
    expect(() => parseLayoutRules({ ...layoutRules, rooms: { ...layoutRules.rooms, attic: { minArea: 1, minWidth: 1 } } })).toThrow(/attic/);
    const bad = (rule: object) => parseLayoutRules({ ...layoutRules, adjacency: [rule] });
    expect(() => bad({ a: "garage", b: "living", rule: "near", weight: 1, text: "x" })).toThrow(/unknown room/);
    expect(() => bad({ a: "bedroom", b: "living", rule: "beside", weight: 1, text: "x" })).toThrow(/unknown rule/);
    expect(() => bad({ a: "living", b: "corridor", rule: "opensTo", weight: 1, text: "x" })).toThrow(/door rule/);
    expect(() => bad({ a: "bedroom", b: "living", rule: "near", weight: 1 })).toThrow(/text/);
    expect(() => parseLayoutRules({ ...layoutRules, circulation: { ...layoutRules.circulation, maxWalk: 0 } })).toThrow(/maxWalk/);
    expect(() => parseLayoutRules({ ...layoutRules, bathroomAreaRange: [6, 3] })).toThrow(
      /bathroomAreaRange/,
    );
    expect(() => parseLayoutRules(null)).toThrow();
  });
});

describe("layout input", () => {
  it("finds the partitions that lie wholly inside an apartment", () => {
    const all = plan("all");
    expect(apartmentInteriorWalls(all.storey, all.apartmentId).sort()).toEqual(
      [all.partition.id, all.cross.id].sort(),
    );
    const east = plan("east");
    expect(apartmentInteriorWalls(east.storey, east.apartmentId)).toEqual([east.cross.id]);
    const west = plan("west");
    expect(apartmentInteriorWalls(west.storey, west.apartmentId)).toEqual([]);
  });

  it("describes the emptied apartment to the engine", () => {
    const { storey, apartmentId } = plan("all");
    const untouched = structuredClone(storey);
    const built = buildLayoutInput(storey, apartmentId);
    if (!built.ok) throw new Error(built.reason);
    expect(storey).toEqual(untouched);
    expect(built.shell.walls).toHaveLength(4);
    expect(built.shell.spaces.map((s) => s.id)).toEqual([built.spaceId]);
    // Outline at the inside faces of the 0.25 walls: 7.75 x 5.75 m.
    expect(polygonArea(built.input.polygon)).toBeCloseTo(7.75 * 5.75, 6);
    expect(built.input.facadeEdges).toHaveLength(built.input.polygon.length);
    expect(built.input.entrance).toEqual({ x: 1, y: 0 });
    expect(built.input.plumbingStack).toBeUndefined();
  });

  it("counts only exterior walls as facade", () => {
    const { storey, apartmentId } = plan("east");
    const built = buildLayoutInput(storey, apartmentId);
    if (!built.ok) throw new Error(built.reason);
    const { polygon, facadeEdges } = built.input;
    let facade = 0;
    for (const i of facadeEdges) {
      const p = polygon[i];
      const q = polygon[(i + 1) % polygon.length];
      facade += Math.hypot(p.x - q.x, p.y - q.y);
      expect(Math.max(p.x, q.x)).toBeGreaterThan(5.06); // never the face of the partition
    }
    // North and south 2.825 m each (5.05 to 7.875), east 5.75 m.
    expect(facade).toBeCloseTo(2 * 2.825 + 5.75, 6);
  });

  it("points the engine at a shaft next to the apartment", () => {
    const { storey, apartmentId } = plan("west");
    const shaft = storey.spaces.find((s) => s.anchor.x > 5 && s.anchor.y < 3.5)!;
    const built = buildLayoutInput(updateSpace(storey, shaft.id, { type: "shaft" }), apartmentId);
    if (!built.ok) throw new Error(built.reason);
    expect(built.input.plumbingStack).toEqual(shaft.anchor);
  });

  it("says why an apartment cannot be laid out", () => {
    const noDoor = plan("all", false);
    expect(reasonOf(noDoor.storey, noDoor.apartmentId)).toMatch(/no entrance door/);
    expect(reasonOf(noDoor.storey, "nope")).toMatch(/No such apartment/);

    const empty = createApartment(noDoor.storey);
    expect(reasonOf(empty.storey, empty.apartmentId)).toMatch(/no rooms/);

    // West and south-east only: the partition between them also bounds the north-east room.
    const base = getActiveStorey(createSampleProject());
    const apart = createApartment(
      base,
      base.spaces.filter((s) => s.anchor.x < 5 || s.anchor.y > 3.5).map((s) => s.id),
    );
    expect(reasonOf(apart.storey, apart.apartmentId)).toMatch(/do not adjoin/);

    const all = plan("all");
    const inward = all.storey.walls.reduce((s, w) => setWallKind(s, w.id, "interior"), all.storey);
    expect(reasonOf(inward, all.apartmentId)).toMatch(/no exterior wall/);
  });

  it("refuses an apartment that encloses another room", () => {
    const storey = syncSpaces({
      ...createStorey(),
      walls: [...box("o", 0, 0, 10, 8), ...box("i", 4, 3, 2, 2)],
    });
    const outer = storey.spaces.find((s) => s.wallIds.includes("o1"))!;
    const made = createApartment(storey, [outer.id]);
    const withDoor = addOpening(made.storey, "o1", "door", 1, DOOR);
    expect(reasonOf(withDoor, made.apartmentId)).toMatch(/encloses another room/);
  });
});

describe("layout proposals", () => {
  it("turns a layout into walls, doors and rooms of the apartment", () => {
    const { storey, apartmentId } = plan("all");
    const untouched = structuredClone(storey);
    const proposals = proposalsOf(storey, apartmentId);
    expect(storey).toEqual(untouched);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals.length).toBeLessThanOrEqual(3);

    for (const p of proposals) {
      const apartment = p.storey.apartments.find((a) => a.id === apartmentId)!;
      const rooms = apartment.spaceIds.map((id) => p.storey.spaces.find((s) => s.id === id)!);
      expect(rooms.map((r) => r.type).sort()).toEqual(["bathroom", "bedroom", "living"]);
      expect(p.rooms.slice().sort()).toEqual(["Bathroom", "Bedroom", "Living room"]);
      expect(p.storey.spaces).toHaveLength(3); // nothing else appeared
      expect(p.relaxation).toBe(1);

      // The four shell walls are kept; the rest are new partitions on the grid.
      expect(p.storey.walls.slice(0, 4)).toEqual(untouched.walls.filter((w) => w.kind === "exterior"));
      const partitions = p.storey.walls.slice(4);
      expect(partitions.length).toBeGreaterThanOrEqual(2);
      for (const w of partitions) {
        expect(w).toMatchObject({ kind: "interior", thickness: 0.1 });
        for (const v of [w.a.x, w.a.y, w.b.x, w.b.y]) {
          expect(Math.abs(v / 0.05 - Math.round(v / 0.05))).toBeLessThan(1e-6);
        }
      }

      // The entrance plus a door into the bedroom and into the bathroom.
      expect(p.storey.openings.map((o) => o.kind)).toEqual(["door", "door", "door"]);
      expect(p.storey.openings[0]).toEqual(storey.openings[0]);
      expect(p.storey.openings.slice(1).every((o) => o.width === rules.doorWidth)).toBe(true);
      const issues = checkStoreyPlan(p.storey, checkConfig).map((i) => i.kind);
      expect(issues).not.toContain("roomNoDoor");
      expect(issues).not.toContain("apartmentNoEntrance");
    }
  });

  it("keeps the floor area, less what the new partitions stand on", () => {
    const { storey, apartmentId } = plan("all");
    const built = buildLayoutInput(storey, apartmentId);
    if (!built.ok) throw new Error(built.reason);
    const shellNet = computeStoreyAreas(built.shell, areaConfig).totals.net;
    for (const p of proposalsOf(storey, apartmentId)) {
      const areas = computeStoreyAreas(p.storey, areaConfig);
      expect(areas.totals.net).toBeLessThan(shellNet);
      expect(areas.totals.net).toBeGreaterThan(shellNet - 2);
      const net = (name: string) => areas.spaces.find((s) => s.name === name)!.net;
      expect(net("Bedroom")).toBeGreaterThan(8);
      expect(net("Bathroom")).toBeGreaterThan(2.5);
      expect(net("Living room")).toBeGreaterThan(net("Bedroom"));
    }
  });

  it("leaves the rooms outside the apartment alone", () => {
    const { storey, apartmentId } = plan("west");
    const others = storey.spaces.filter((s) => s.anchor.x > 5);
    const before = computeStoreyAreas(storey, areaConfig);
    for (const p of proposalsOf(storey, apartmentId)) {
      const after = computeStoreyAreas(p.storey, areaConfig);
      for (const room of others) {
        const kept = p.storey.spaces.find((s) => s.id === room.id)!;
        expect(kept).toMatchObject({ name: room.name, type: room.type });
        expect(after.spaces.find((s) => s.spaceId === room.id)!.net).toBeCloseTo(
          before.spaces.find((s) => s.spaceId === room.id)!.net,
          9,
        );
      }
      expect(p.storey.spaces).toHaveLength(5);
      expect(p.storey.apartments.find((a) => a.id === apartmentId)!.spaceIds).toHaveLength(3);
    }
  });

  it("replaces the old partitions of the apartment and reports relaxed minimums", () => {
    const { storey, apartmentId, cross } = plan("east");
    // 18 m2 is below the room minimums of the config; smaller ones for this test.
    const small = {
      ...rules,
      roomSizes: {
        ...rules.roomSizes!,
        living: { minArea: 5, minWidth: 2.5 },
        mainBedroom: { minArea: 7, minWidth: 2.5 },
        bathroom: { minArea: 3, minWidth: 1.5 },
      },
    };
    const result = proposeLayouts(storey, apartmentId, small, options);
    if (!result.ok) throw new Error(result.reason);
    const [first] = result.proposals;
    expect(first.storey.walls.some((w) => w.id === cross.id)).toBe(false);
    // 2.8 m wide: too tight for the default minimums.
    expect(first.relaxation).toBeLessThan(1);
    // The report measures against the full minimums.
    expect(first.checks.some((c) => c.group === "size" && !c.ok)).toBe(true);
    expect(first.rooms).toContain("Bedroom");
  });

  it("gives the same answer every time", () => {
    const { storey, apartmentId } = plan("all");
    const shape = (s: Storey) => s.walls.map((w) => [w.a, w.b, w.thickness]);
    const a = proposalsOf(storey, apartmentId);
    const b = proposalsOf(storey, apartmentId);
    expect(a.map((p) => shape(p.storey))).toEqual(b.map((p) => shape(p.storey)));
  });

  it("works on a plan that is not square to the axes", () => {
    const { project, storey, apartmentId } = plan("all");
    const angle = Math.PI / 6;
    const turn = (p: { x: number; y: number }) => ({
      x: Math.round((p.x * Math.cos(angle) - p.y * Math.sin(angle)) * 1e6) / 1e6,
      y: Math.round((p.x * Math.sin(angle) + p.y * Math.cos(angle)) * 1e6) / 1e6,
    });
    const turned = syncSpaces({
      ...storey,
      walls: storey.walls.map((w) => ({ ...w, a: turn(w.a), b: turn(w.b) })),
      spaces: storey.spaces.map((s) => ({ ...s, anchor: turn(s.anchor) })),
    });
    expect(turned.apartments[0].spaceIds).toHaveLength(3);
    const proposals = proposalsOf(turned, apartmentId);
    for (const p of proposals) {
      expect(p.rooms.slice().sort()).toEqual(["Bathroom", "Bedroom", "Living room"]);
      expect(p.storey.openings).toHaveLength(3);
    }
    const saved = replaceStorey(project, proposals[0].storey);
    expect(parseProject(serializeProject(saved))).toEqual(saved);
  });

  it("says so when the apartment is too small for the programme", () => {
    const storey = syncSpaces({ ...createStorey(), walls: box("s", 0, 0, 3, 3) });
    const made = createApartment(storey, [storey.spaces[0].id]);
    const result = proposeLayouts(
      addOpening(made.storey, "s1", "door", 1, DOOR),
      made.apartmentId,
      rules,
      options,
    );
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/cannot fit/) });
  });

  it("passes on the reason when the apartment cannot be laid out at all", () => {
    const { storey, apartmentId } = plan("all", false);
    expect(proposeLayouts(storey, apartmentId, rules, options)).toEqual({
      ok: false,
      reason: expect.stringMatching(/no entrance door/),
    });
  });
});
