import { describe, expect, it } from "vitest";
import bearingJson from "../config/bearingCheck.json";
import splitJson from "../config/storeySplit.json";
import { buildLayoutInput } from "./autoLayout.ts";
import { checkBearing, parseBearingConfig } from "./bearing.ts";
import { addStorey, sortedStoreys } from "./building.ts";
import { addWall, moveWall, setWallLoadBearing } from "./edit.ts";
import type { Project, Storey } from "./model.ts";
import { addOpening, fitOffset } from "./openings.ts";
import { createProject, parseProject, replaceStorey, serializeProject } from "./project.ts";
import { parseSplitRules, proposeSplits } from "./storeySplit.ts";
import { addCoreElement, rebuildStructure, setAllErkerEdges, setFootprint } from "./structure.ts";

const config = parseBearingConfig(bearingJson);
const door = { width: 0.9, height: 2.1, sill: 0 };

/** A plain 20 x 14 block with nothing inside. */
function box(): Project {
  let p = createProject();
  const id = p.site.buildings[0].id;
  p = setFootprint(p, id, [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 14 },
    { x: 0, y: 14 },
  ]);
  return setAllErkerEdges(p, id, false);
}

const ground = (p: Project) => sortedStoreys(p.site.buildings[0])[0];
const lastWall = (s: Storey) => s.walls.at(-1)!;

describe("load-bearing walls", () => {
  it("take no doors or windows, and lose the ones they had", () => {
    let s = addWall(ground(box()), { x: 10, y: 0.125 }, { x: 10, y: 13.875 }, 0.2);
    const wall = lastWall(s);
    s = addOpening(s, wall.id, "door", 5, door);
    expect(s.openings.filter((o) => o.wallId === wall.id)).toHaveLength(1);
    s = setWallLoadBearing(s, wall.id, true);
    expect(s.walls.find((w) => w.id === wall.id)!.loadBearing).toBe(true);
    expect(s.openings.filter((o) => o.wallId === wall.id)).toHaveLength(0);
    expect(addOpening(s, wall.id, "door", 5, door)).toBe(s);
    expect(fitOffset(s, wall.id, 5, 0.9)).toBeNull();
    // Off again: doors fit once more.
    s = setWallLoadBearing(s, wall.id, false);
    expect("loadBearing" in s.walls.find((w) => w.id === wall.id)!).toBe(false);
    expect(fitOffset(s, wall.id, 5, 0.9)).not.toBeNull();
  });

  it("keep the flag when moved", () => {
    let s = addWall(ground(box()), { x: 10, y: 0.125 }, { x: 10, y: 13.875 }, 0.2);
    const id = lastWall(s).id;
    s = moveWall(setWallLoadBearing(s, id, true), id, { x: 1, y: 0 });
    expect(s.walls.find((w) => w.id === id)!.loadBearing).toBe(true);
  });

  it("cannot be set on the generated walls", () => {
    const s = ground(box());
    const shell = s.walls.find((w) => w.part === "shell")!;
    expect(setWallLoadBearing(s, shell.id, true)).toBe(s);
  });

  it("are saved and read back; openings in them and stray flags are dropped", () => {
    let p = box();
    let s = addWall(ground(p), { x: 10, y: 0.125 }, { x: 10, y: 13.875 }, 0.2);
    const id = lastWall(s).id;
    s = setWallLoadBearing(s, id, true);
    p = replaceStorey(p, s);
    const raw = JSON.parse(serializeProject(p));
    const storey = raw.site.buildings[0].storeys[0];
    storey.openings.push({ id: "o", wallId: id, kind: "door", offset: 5, width: 0.9, height: 2.1, sill: 0 });
    storey.walls[0].loadBearing = "yes";
    const back = parseProject(JSON.stringify(raw)).site.buildings[0].storeys[0];
    expect(back.walls.find((w) => w.id === id)!.loadBearing).toBe(true);
    expect(back.openings.some((o) => o.wallId === id)).toBe(false);
    expect("loadBearing" in back.walls[0]).toBe(false);
  });

  it("are not removed by the storey generator or the room layout", { timeout: 30000 }, () => {
    let p = box();
    const id = p.site.buildings[0].id;
    p = rebuildStructure(addStorey(p, id).project, id);
    p = addCoreElement(p, id, "hall", { x: 8, y: 5 }, { x: 12, y: 9 }).project;
    p = addCoreElement(p, id, "stair", { x: 8, y: 9 }, { x: 11, y: 13.875 }).project;
    const b = p.site.buildings[0];
    const upper = sortedStoreys(b)[1];
    const rules = parseSplitRules(splitJson);
    const mix = [{ name: "One", area: 50, count: 4, program: { bedrooms: 1, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" as const } }];
    const split = proposeSplits(b, upper, mix, "hall", rules);
    if (!split.ok) throw new Error(split.reason);
    let plan = split.proposals[0].storey;
    // Mark a wall between two apartments load-bearing: the storey cannot be divided again.
    const party = plan.walls.find((w) => !w.part)!;
    plan = setWallLoadBearing(plan, party.id, true);
    const again = proposeSplits(b, plan, mix, "hall", rules);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/load-bearing/);
    // A load-bearing wall inside an apartment stops its room layout.
    const apt = plan.apartments[0];
    const face = plan.spaces.find((sp) => sp.id === apt.spaceIds[0])!;
    let inside = addWall(plan, { x: face.anchor.x, y: face.anchor.y - 1 }, { x: face.anchor.x, y: face.anchor.y + 1 }, 0.1);
    const free = lastWall(inside);
    inside = setWallLoadBearing(inside, free.id, true);
    const input = buildLayoutInput(inside, apt.id);
    expect(input.ok).toBe(false);
    if (!input.ok) expect(input.reason).toMatch(/load-bearing/);
  });
});

describe("bearing check", () => {
  it("reads the config and rejects damaged values", () => {
    expect(() => parseBearingConfig({ ...bearingJson, maxEccentricityRatio: 0 })).toThrow(/maxEccentricityRatio/);
    expect(() => parseBearingConfig({ ...bearingJson, checkGyration: "yes" })).toThrow(/checkGyration/);
  });

  it("finds a box with only its outside walls centred and stiff against twisting", () => {
    const p = box();
    const r = checkBearing(p.site.buildings[0], ground(p), config);
    expect(r.centreOfMass!.x).toBeCloseTo(10, 6);
    expect(r.centreOfMass!.y).toBeCloseTo(7, 6);
    expect(r.centreOfStiffness!.x).toBeCloseTo(10, 6);
    expect(r.centreOfStiffness!.y).toBeCloseTo(7, 6);
    // l_s of a 20 x 14 rectangle: sqrt((20² + 14²) / 12).
    expect(r.gyration).toBeCloseTo(Math.sqrt((400 + 196) / 12), 6);
    expect(r.problems).toEqual([]);
  });

  it("flags a storey whose stiffness is all on one side", () => {
    const p = box();
    let s = ground(p);
    // Windows all along the east wall leave it weak; thick load-bearing walls go in the west.
    const east = s.walls.find((w) => w.part === "shell" && Math.abs(w.a.x - w.b.x) < 1e-6 && w.a.x > 10)!;
    for (let off = 0.8; off < 13; off += 1.4) s = addOpening(s, east.id, "window", off, { width: 1.2, height: 1.4, sill: 0.9 });
    for (const x of [2, 4]) {
      s = addWall(s, { x, y: 0.125 }, { x, y: 13.875 }, 0.3);
      s = setWallLoadBearing(s, lastWall(s).id, true);
    }
    const r = checkBearing(p.site.buildings[0], s, config);
    expect(r.centreOfStiffness!.x).toBeLessThan(r.centreOfMass!.x - 1);
    expect(r.problems.some((m) => m.includes("along x"))).toBe(true);
  });

  it("does not count partitions", () => {
    const p = box();
    const base = checkBearing(p.site.buildings[0], ground(p), config);
    const s = addWall(ground(p), { x: 3, y: 0.125 }, { x: 3, y: 13.875 }, 0.1);
    const r = checkBearing(p.site.buildings[0], s, config);
    expect(r.centreOfStiffness).toEqual(base.centreOfStiffness);
  });

  it("says when nothing carries in a direction", () => {
    const p = createProject();
    const b = p.site.buildings[0];
    let s = b.storeys[0];
    s = addWall(s, { x: 0, y: 0 }, { x: 10, y: 0 }, 0.2);
    s = setWallLoadBearing(s, lastWall(s).id, true);
    s = addWall(s, { x: 0, y: 0.1 }, { x: 0, y: 8 }, 0.1);
    s = addWall(s, { x: 0, y: 8 }, { x: 10, y: 8 }, 0.1);
    s = addWall(s, { x: 10, y: 8 }, { x: 10, y: 0 }, 0.1);
    const r = checkBearing(b, s, config);
    expect(r.centreOfMass).not.toBeNull();
    // One wall along x: across itself it is next to nothing, so y is not carried.
    expect(r.problems.join(" ")).toMatch(/along y|twist/);
  });
});
