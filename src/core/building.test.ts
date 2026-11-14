import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import coreAlignment from "../config/coreAlignment.json";
import { computeBuildingAreas, computeStoreyAreas, parseAreaConfig } from "./areas.ts";
import {
  addStorey,
  checkElevations,
  copyStorey,
  deleteStorey,
  restackStoreys,
  sortedStoreys,
  updateStoreyInfo,
} from "./building.ts";
import {
  type CoreConfig,
  checkCoreAlignment,
  coreOutlines,
  outlineDeviation,
  parseCoreConfig,
} from "./coreAlignment.ts";
import { moveWall, updateSpace } from "./edit.ts";
import type { Project, SpaceType, Storey } from "./model.ts";
import {
  createSampleProject,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "./project.ts";

const areaConfig = parseAreaConfig(areaDefinitions);
const coreConfig = parseCoreConfig(coreAlignment);
const building = (p: Project) => p.site.buildings[0];

/** Sample plan (8 x 6 m, three rooms) with the small north-east room typed as a core space. */
function withCore(type: SpaceType = "stair"): { project: Project; ground: Storey; coreId: string } {
  const project = createSampleProject();
  const storey = getActiveStorey(project);
  // Rooms east of the partition at x = 5; the northern one spans y 0..3.5.
  const core = storey.spaces.find((s) => s.anchor.x > 5 && s.anchor.y < 3.5)!;
  const ground = updateSpace(storey, core.id, { type, name: "Core" });
  return { project: replaceStorey(project, ground), ground, coreId: core.id };
}

describe("storeys", () => {
  it("adds an empty storey on top, starting where the one below ends", () => {
    const base = createSampleProject();
    const { project, storeyId } = addStorey(base, building(base).id);
    const added = getActiveStorey(project, storeyId);
    expect(building(project).storeys).toHaveLength(2);
    expect(added.elevation).toBe(3);
    expect(added.height).toBe(3);
    expect(added.walls).toEqual([]);
    expect(added.name).toBe("Floor 1");
    expect(checkElevations(building(project))).toEqual([]);
  });

  it("copies a storey with everything on it, under fresh ids", () => {
    const { project: base, ground } = withCore();
    const { project, storeyId } = copyStorey(base, ground.id);
    const copy = getActiveStorey(project, storeyId);

    expect(copy.elevation).toBe(3);
    expect(copy.walls.map((w) => [w.a, w.b, w.thickness])).toEqual(
      ground.walls.map((w) => [w.a, w.b, w.thickness]),
    );
    expect(copy.spaces.map((s) => [s.name, s.type])).toEqual(ground.spaces.map((s) => [s.name, s.type]));
    expect(computeStoreyAreas(copy, areaConfig).totals).toEqual(
      computeStoreyAreas(ground, areaConfig).totals,
    );

    // No id is shared, and internal references point at the copy's own objects.
    const ids = (s: Storey) => [s.id, ...s.walls, ...s.spaces, ...s.circulation].map((x) =>
      typeof x === "string" ? x : x.id,
    );
    expect(ids(copy).filter((id) => ids(ground).includes(id))).toEqual([]);
    const wallIds = new Set(copy.walls.map((w) => w.id));
    for (const s of copy.spaces) for (const id of s.wallIds) expect(wallIds.has(id)).toBe(true);
    expect(copy.circulation).toHaveLength(1);
    expect(copy.spaces.some((s) => s.id === copy.circulation[0].spaceId)).toBe(true);
  });

  it("editing the copy leaves the original alone", () => {
    const { project: base, ground } = withCore();
    const { project, storeyId } = copyStorey(base, ground.id);
    const copy = getActiveStorey(project, storeyId);
    const edited = replaceStorey(project, moveWall(copy, copy.walls[4].id, { x: -1, y: 0 }));
    expect(getActiveStorey(edited, ground.id)).toEqual(ground);
  });

  it("keeps at least one storey", () => {
    const base = createSampleProject();
    const only = getActiveStorey(base);
    expect(deleteStorey(base, only.id)).toBe(base);
    const { project, storeyId } = addStorey(base, building(base).id);
    const after = deleteStorey(project, storeyId);
    expect(building(after).storeys.map((s) => s.id)).toEqual([only.id]);
  });

  it("warns about gaps and overlaps between storeys, and restacking fixes them", () => {
    const base = createSampleProject();
    const ground = getActiveStorey(base);
    let { project, storeyId: first } = addStorey(base, building(base).id);
    const second = addStorey(project, building(project).id);
    project = second.project;
    expect(getActiveStorey(project, second.storeyId).elevation).toBe(6);

    project = updateStoreyInfo(project, ground.id, { height: 3.5 });
    project = updateStoreyInfo(project, second.storeyId, { elevation: 5.8 });
    const issues = checkElevations(building(project));
    expect(issues.map((i) => [i.kind, i.storeyId, i.amount])).toEqual([
      ["overlap", first, 0.5],
      ["overlap", second.storeyId, 0.2],
    ]);
    expect(issues[0].message).toContain("0.50 m below the top of Ground floor");

    project = updateStoreyInfo(project, first, { elevation: 4 });
    expect(checkElevations(building(project))[0].kind).toBe("gap");

    project = restackStoreys(project, building(project).id);
    expect(sortedStoreys(building(project)).map((s) => s.elevation)).toEqual([0, 3.5, 6.5]);
    expect(checkElevations(building(project))).toEqual([]);
  });

  it("rejects a storey height that is not positive", () => {
    const base = createSampleProject();
    expect(updateStoreyInfo(base, getActiveStorey(base).id, { height: 0 })).toBe(base);
  });

  it("sums the storeys into building areas", () => {
    const { project: base, ground } = withCore();
    const { project } = copyStorey(base, ground.id);
    const one = computeStoreyAreas(ground, areaConfig).totals;
    const all = computeBuildingAreas(building(project), areaConfig);
    expect(all.storeys.map((s) => s.elevation)).toEqual([0, 3]);
    expect(all.totals.net).toBeCloseTo(2 * one.net);
    expect(all.totals.gross).toBeCloseTo(2 * one.gross);
  });

  it("a multi-storey project round-trips through JSON", () => {
    const { project: base, ground } = withCore();
    const { project } = copyStorey(base, ground.id);
    expect(parseProject(serializeProject(project))).toEqual(project);
  });
});

describe("circulation list", () => {
  it("follows the space types", () => {
    const { ground, coreId } = withCore("elevator");
    expect(ground.circulation).toEqual([
      { id: expect.any(String), kind: "elevator", spaceId: coreId },
    ]);
    const kept = updateSpace(ground, coreId, { type: "shaft" });
    expect(kept.circulation[0].id).toBe(ground.circulation[0].id);
    expect(kept.circulation[0].kind).toBe("shaft");
    expect(updateSpace(ground, coreId, { type: "bedroom" }).circulation).toEqual([]);
  });
});

describe("core alignment across floors", () => {
  it("measures how far apart two outlines are", () => {
    const sq = (x: number, y: number, s = 2) => [
      { x, y },
      { x: x + s, y },
      { x: x + s, y: y + s },
      { x, y: y + s },
    ];
    expect(outlineDeviation(sq(0, 0), sq(0, 0))).toBe(0);
    expect(outlineDeviation(sq(0, 0), sq(0.3, 0))).toBeCloseTo(0.3);
    expect(outlineDeviation(sq(0, 0), sq(0, 0).reverse())).toBe(0);
    expect(outlineDeviation(sq(0, 0), sq(0, 0, 2.5))).toBeCloseTo(Math.hypot(0.5, 0.5));
  });

  it("lists only the configured core spaces", () => {
    const { ground, coreId } = withCore("stair");
    expect(coreOutlines(ground, coreConfig).map((c) => c.spaceId)).toEqual([coreId]);
    const onlyShafts: CoreConfig = { coreSpaceTypes: ["shaft"], tolerance: 0.01 };
    expect(coreOutlines(ground, onlyShafts)).toEqual([]);
  });

  it("a copied storey is aligned", () => {
    const { project: base, ground } = withCore();
    const { project } = copyStorey(base, ground.id);
    expect(checkCoreAlignment(building(project), coreConfig)).toEqual([]);
  });

  it("a single storey has nothing to compare", () => {
    expect(checkCoreAlignment(building(withCore().project), coreConfig)).toEqual([]);
  });

  it("warns when the core is moved on one floor", () => {
    const { project: base, ground, coreId } = withCore();
    const { project, storeyId } = copyStorey(base, ground.id);
    const upper = getActiveStorey(project, storeyId);
    // The partition at x = 5 is the west wall of the core.
    const moved = replaceStorey(project, moveWall(upper, upper.walls[4].id, { x: 0.3, y: 0 }));
    const issues = checkCoreAlignment(building(moved), coreConfig);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "misaligned",
      type: "stair",
      storeyId,
      otherStoreyId: ground.id,
      otherSpaceId: coreId,
    });
    expect(issues[0].deviation).toBeCloseTo(0.3);
    expect(issues[0].message).toBe('stair "Core" on Floor 1 is 0.30 m off the stair "Core" on Ground floor.');
  });

  it("the tolerance comes from the config", () => {
    const { project: base, ground } = withCore();
    const { project, storeyId } = copyStorey(base, ground.id);
    const upper = getActiveStorey(project, storeyId);
    const moved = replaceStorey(project, moveWall(upper, upper.walls[4].id, { x: 0.3, y: 0 }));
    const loose: CoreConfig = { ...coreConfig, tolerance: 0.5 };
    expect(checkCoreAlignment(building(moved), loose)).toEqual([]);
  });

  it("warns when a floor has no counterpart, in both directions", () => {
    const { project: base, ground, coreId } = withCore("shaft");
    const { project, storeyId } = copyStorey(base, ground.id);
    const upper = getActiveStorey(project, storeyId);
    const upperCore = upper.spaces.find((s) => s.type === "shaft")!;

    const noneAbove = replaceStorey(project, updateSpace(upper, upperCore.id, { type: "storage" }));
    expect(checkCoreAlignment(building(noneAbove), coreConfig)).toMatchObject([
      { kind: "missing", storeyId: ground.id, spaceId: coreId, otherStoreyId: storeyId },
    ]);

    const noneBelow = replaceStorey(project, updateSpace(ground, coreId, { type: "storage" }));
    const issues = checkCoreAlignment(building(noneBelow), coreConfig);
    expect(issues).toMatchObject([
      { kind: "missing", storeyId, spaceId: upperCore.id, otherStoreyId: ground.id },
    ]);
    expect(issues[0].message).toContain("has no shaft below it on Ground floor");
  });

  it("a stair over an elevator is not a match", () => {
    const { project: base, ground } = withCore("stair");
    const { project, storeyId } = copyStorey(base, ground.id);
    const upper = getActiveStorey(project, storeyId);
    const upperCore = upper.spaces.find((s) => s.type === "stair")!;
    const mixed = replaceStorey(project, updateSpace(upper, upperCore.id, { type: "elevator" }));
    expect(checkCoreAlignment(building(mixed), coreConfig).map((i) => i.kind)).toEqual([
      "missing",
      "missing",
    ]);
  });

  it("compares neighbouring floors only, by elevation rather than list order", () => {
    const { project: base, ground } = withCore();
    let { project, storeyId: first } = copyStorey(base, ground.id);
    const second = copyStorey(project, ground.id);
    project = second.project;
    const middle = getActiveStorey(project, first);
    project = replaceStorey(project, moveWall(middle, middle.walls[4].id, { x: 0.3, y: 0 }));
    // The middle floor disagrees with both neighbours; ground and top agree but are not adjacent.
    expect(checkCoreAlignment(building(project), coreConfig)).toHaveLength(2);
    // Swap the middle floor to the top: now only one adjacent pair disagrees.
    project = updateStoreyInfo(project, first, { elevation: 6 });
    project = updateStoreyInfo(project, second.storeyId, { elevation: 3 });
    expect(checkCoreAlignment(building(project), coreConfig)).toHaveLength(1);
  });

  it("rejects a broken config", () => {
    expect(() => parseCoreConfig({ coreSpaceTypes: ["lift"], tolerance: 0.01 })).toThrow(/lift/);
    expect(() => parseCoreConfig({ coreSpaceTypes: ["stair"], tolerance: -1 })).toThrow(/tolerance/);
  });
});
