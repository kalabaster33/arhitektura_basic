import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import siteRulesJson from "../config/siteRules.json";
import { computeBuildingAreas, parseAreaConfig } from "./areas.ts";
import { copyStorey, moveBuilding } from "./building.ts";
import { moveWall } from "./edit.ts";
import type { Pt } from "./geometry.ts";
import { type Project, SCHEMA_VERSION } from "./model.ts";
import { addOpening, openingGeometry } from "./openings.ts";
import {
  createSampleProject,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "./project.ts";
import {
  type SiteRules,
  analyseSite,
  boundaryProblem,
  buildableArea,
  buildingFootprint,
  clearBoundary,
  deleteBoundaryCorner,
  insertBoundaryCorner,
  moveBoundaryCorner,
  parseSiteRules,
  regionArea,
  setBoundary,
  setSetback,
  setSiteLimits,
} from "./site.ts";

const areaConfig = parseAreaConfig(areaDefinitions);
const rules = parseSiteRules(siteRulesJson);
const pts = (...xy: [number, number][]): Pt[] => xy.map(([x, y]) => ({ x, y }));

/** 30 x 20 m plot around the origin corner (-10, -7), so the 8 x 6 m sample sits well inside. */
const RECT = pts([-10, -7], [20, -7], [20, 13], [-10, 13]);
const L_PLOT = pts([0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]);

/** The sample building (8 x 6 m at the centrelines, 0.25 m exterior walls) on the rectangular plot. */
function onPlot(setback = 3): Project {
  return setBoundary(createSampleProject(), RECT, setback);
}
const analyse = (p: Project, r: SiteRules = rules) => analyseSite(p.site, r, areaConfig);
const kinds = (p: Project) => analyse(p).issues.map((i) => i.kind);

describe("site rules", () => {
  it("reads the config and rejects a bad one", () => {
    expect(rules.defaultSetback).toBeGreaterThanOrEqual(0);
    expect(["allStoreys", "lowestStorey"]).toContain(rules.footprint);
    expect(() => parseSiteRules({ ...siteRulesJson, footprint: "roof" })).toThrow(/footprint/);
    expect(() => parseSiteRules({ ...siteRulesJson, defaultSetback: -1 })).toThrow(/defaultSetback/);
    expect(() => parseSiteRules({ ...siteRulesJson, maxCoverage: 0 })).toThrow(/maxCoverage/);
  });
});

describe("plot outline", () => {
  it("sets the outline with one setback per edge", () => {
    const p = onPlot(3);
    expect(p.site.boundary).toEqual(RECT);
    expect(p.site.setbacks).toEqual([3, 3, 3, 3]);
  });

  it("rejects outlines that cross, fold back or enclose nothing", () => {
    expect(boundaryProblem(RECT)).toBeNull();
    expect(boundaryProblem(L_PLOT)).toBeNull();
    expect(boundaryProblem(pts([0, 0], [10, 0]))).toMatch(/three/);
    expect(boundaryProblem(pts([0, 0], [10, 10], [10, 0], [0, 10]))).toMatch(/crosses/);
    expect(boundaryProblem(pts([0, 0], [10, 0], [5, 0], [5, 5]))).toMatch(/folds/);
    expect(boundaryProblem(pts([0, 0], [10, 0], [10, 0], [0, 10]))).toMatch(/same place/);
    const base = createSampleProject();
    expect(setBoundary(base, pts([0, 0], [10, 10], [10, 0], [0, 10]), 3)).toBe(base);
  });

  it("moves a corner, but not into a self-crossing outline", () => {
    const p = onPlot();
    const moved = moveBoundaryCorner(p, 1, { x: 25, y: -7 });
    expect(moved.site.boundary[1]).toEqual({ x: 25, y: -7 });
    expect(moved.site.setbacks).toEqual(p.site.setbacks);
    // Dragging corner 1 across the opposite edge would make a bow tie.
    expect(moveBoundaryCorner(p, 1, { x: 5, y: 20 })).toBe(p);
  });

  it("inserts and deletes corners, keeping the setbacks with their edges", () => {
    let p = onPlot();
    p = setSetback(p, 0, 5);
    p = setSetback(p, 1, 1);
    expect(p.site.setbacks).toEqual([5, 1, 3, 3]);
    const more = insertBoundaryCorner(p, 0);
    expect(more.site.boundary).toHaveLength(5);
    expect(more.site.boundary[1]).toEqual({ x: 5, y: -7 });
    expect(more.site.setbacks).toEqual([5, 5, 1, 3, 3]);
    const back = deleteBoundaryCorner(more, 1);
    expect(back.site.boundary).toEqual(RECT);
    expect(back.site.setbacks).toEqual([5, 1, 3, 3]);
    // A triangle is the least a plot can be.
    const triangle = deleteBoundaryCorner(p, 3);
    expect(triangle.site.boundary).toHaveLength(3);
    expect(deleteBoundaryCorner(triangle, 0)).toBe(triangle);
  });

  it("ignores a negative setback and clears the plot", () => {
    const p = onPlot();
    expect(setSetback(p, 0, -1)).toBe(p);
    const cleared = clearBoundary(p);
    expect(cleared.site.boundary).toEqual([]);
    expect(cleared.site.setbacks).toEqual([]);
    expect(analyse(cleared).hasPlot).toBe(false);
    expect(analyse(cleared).coverage).toBeNull();
  });
});

describe("buildable area", () => {
  it("insets a rectangle by each edge's own setback", () => {
    let p = onPlot(3);
    p = setSetback(p, 0, 5); // the y = -7 edge
    p = setSetback(p, 1, 1); // the x = 20 edge
    const region = buildableArea(p.site);
    expect(region).toHaveLength(1);
    // x from -10 + 3 to 20 - 1, y from -7 + 5 to 13 - 3.
    expect(regionArea(region)).toBeCloseTo(26 * 12, 6);
    const xs = region[0][0].map((q) => q.x);
    const ys = region[0][0].map((q) => q.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-7, 19, -2, 10]);
  });

  it("does not depend on the direction the outline was drawn in", () => {
    const a = setSetback(setBoundary(createSampleProject(), RECT, 3), 0, 5);
    const reversed = RECT.slice().reverse();
    // Reversed, the y = -7 edge runs from corner 2 to corner 3.
    const b = setSetback(setBoundary(createSampleProject(), reversed, 3), 2, 5);
    expect(regionArea(buildableArea(b.site))).toBeCloseTo(regionArea(buildableArea(a.site)), 6);
  });

  it("keeps a sharp corner where an L-shaped plot turns inward", () => {
    const p = setBoundary(createSampleProject(), L_PLOT, 2);
    const region = buildableArea(p.site);
    expect(region).toHaveLength(1);
    expect(regionArea(region)).toBeCloseTo(16 * 6 + 6 * 10, 6);
    const hasCorner = region[0][0].some((q) => Math.abs(q.x - 8) < 1e-6 && Math.abs(q.y - 8) < 1e-6);
    expect(hasCorner).toBe(true);
  });

  it("is the whole plot with zero setbacks and nothing when they use it up", () => {
    expect(regionArea(buildableArea(onPlot(0).site))).toBeCloseTo(600, 6);
    expect(buildableArea(onPlot(10).site)).toEqual([]);
  });
});

describe("footprint and figures", () => {
  it("measures the footprint to the outside wall faces", () => {
    const p = onPlot();
    expect(regionArea(buildingFootprint(p.site, "allStoreys"))).toBeCloseTo(8.25 * 6.25, 6);
  });

  it("counts an overhanging upper storey, unless only the lowest storey is asked for", () => {
    const base = onPlot();
    const { project: two, storeyId } = copyStorey(base, getActiveStorey(base).id);
    const upper = getActiveStorey(two, storeyId);
    // Push the upper floor's east wall (x = 8) out by 2 m.
    const east = upper.walls.find((w) => w.a.x === 8 && w.b.x === 8)!;
    const p = replaceStorey(two, moveWall(upper, east.id, { x: 2, y: 0 }));
    expect(regionArea(buildingFootprint(p.site, "allStoreys"))).toBeCloseTo(10.25 * 6.25, 6);
    expect(regionArea(buildingFootprint(p.site, "lowestStorey"))).toBeCloseTo(8.25 * 6.25, 6);
    const a = analyse(p);
    expect(a.grossFloorArea).toBeCloseTo(8.25 * 6.25 + 10.25 * 6.25, 6);
    expect(a.grossFloorArea).toBeCloseTo(computeBuildingAreas(p.site.buildings[0], areaConfig).totals.gross, 9);
  });

  it("gives plot area, coverage and floor area ratio", () => {
    const base = onPlot();
    const p = copyStorey(base, getActiveStorey(base).id).project;
    const a = analyse(p);
    const footprint = 8.25 * 6.25;
    expect(a.plotArea).toBeCloseTo(600, 9);
    expect(a.buildableArea).toBeCloseTo(24 * 14, 6);
    expect(a.footprintArea).toBeCloseTo(footprint, 6);
    expect(a.coverage).toBeCloseTo(footprint / 600, 9);
    expect(a.floorAreaRatio).toBeCloseTo((2 * footprint) / 600, 9);
    expect(a.issues).toEqual([]);
  });
});

describe("site warnings", () => {
  it("has none for a building inside the setbacks, even flush with a setback line", () => {
    expect(kinds(onPlot())).toEqual([]);
    // Outside faces at x = -0.125 and y = -0.125; move them onto the lines x = -7, y = -4.
    const p = onPlot();
    const flush = moveBuilding(p, p.site.buildings[0].id, { x: -6.875, y: -3.875 });
    expect(kinds(flush)).toEqual([]);
  });

  it("warns when the building crosses a setback line", () => {
    const p = onPlot();
    const moved = moveBuilding(p, p.site.buildings[0].id, { x: -8, y: 0 });
    const a = analyse(moved);
    expect(a.issues.map((i) => i.kind)).toEqual(["insideSetback"]);
    // Outside face at x = -8.125, setback line at x = -7, 6.25 m deep.
    expect(regionArea(a.insideSetback)).toBeCloseTo(1.125 * 6.25, 6);
    expect(a.outsidePlot).toEqual([]);
  });

  it("warns when the building reaches beyond the plot", () => {
    const p = onPlot();
    const moved = moveBuilding(p, p.site.buildings[0].id, { x: -12, y: 0 });
    const a = analyse(moved);
    expect(a.issues.map((i) => i.kind)).toEqual(["outsidePlot", "insideSetback"]);
    // Outside face at x = -12.125, plot edge at x = -10.
    expect(regionArea(a.outsidePlot)).toBeCloseTo(2.125 * 6.25, 6);
    expect(regionArea(a.insideSetback)).toBeCloseTo(3 * 6.25, 6);
  });

  it("warns about coverage and floor area ratio above their limits only", () => {
    const footprint = 8.25 * 6.25; // 8.59 % of the plot
    const p = onPlot();
    expect(kinds(setSiteLimits(p, { maxCoverage: 0.05 }))).toEqual(["coverage"]);
    expect(kinds(setSiteLimits(p, { maxCoverage: footprint / 600 }))).toEqual([]);
    expect(kinds(setSiteLimits(p, { maxFloorAreaRatio: 0.05 }))).toEqual(["floorAreaRatio"]);
    expect(kinds(setSiteLimits(p, { maxFloorAreaRatio: 0.1 }))).toEqual([]);
    const both = setSiteLimits(p, { maxCoverage: 0.05, maxFloorAreaRatio: 0.05 });
    expect(kinds(both)).toEqual(["coverage", "floorAreaRatio"]);
    // Clearing a limit turns its warning off and leaves the other alone.
    const cleared = setSiteLimits(both, { maxCoverage: null });
    expect(cleared.site.limits).toEqual({ maxCoverage: null, maxFloorAreaRatio: 0.05 });
    expect(kinds(cleared)).toEqual(["floorAreaRatio"]);
  });

  it("starts a new plot from the given limits but keeps limits already set", () => {
    const base = createSampleProject();
    const first = setBoundary(base, RECT, 3, { maxCoverage: 0.4, maxFloorAreaRatio: null });
    expect(first.site.limits).toEqual({ maxCoverage: 0.4, maxFloorAreaRatio: null });
    const edited = setSiteLimits(first, { maxCoverage: 0.6 });
    const redrawn = setBoundary(clearBoundary(edited), L_PLOT, 3, { maxCoverage: 0.4, maxFloorAreaRatio: 2 });
    expect(redrawn.site.limits).toEqual({ maxCoverage: 0.6, maxFloorAreaRatio: 2 });
  });
});

describe("moving a building", () => {
  it("shifts walls and room anchors on every storey and keeps rooms, areas and openings", () => {
    let base = createSampleProject();
    const ground = getActiveStorey(base);
    const withDoor = addOpening(ground, ground.walls[0].id, "door", 2, { width: 0.9, height: 2.1, sill: 0 });
    base = copyStorey(replaceStorey(base, withDoor), ground.id).project;
    const id = base.site.buildings[0].id;
    const moved = moveBuilding(base, id, { x: 4.5, y: -2 });
    const before = base.site.buildings[0];
    const after = moved.site.buildings[0];
    expect(after.storeys).toHaveLength(2);
    after.storeys.forEach((s, i) => {
      const old = before.storeys[i];
      s.walls.forEach((w, k) => {
        expect(w.a).toEqual({ x: old.walls[k].a.x + 4.5, y: old.walls[k].a.y - 2 });
        expect(w.b).toEqual({ x: old.walls[k].b.x + 4.5, y: old.walls[k].b.y - 2 });
      });
      s.spaces.forEach((x, k) => {
        expect(x.id).toBe(old.spaces[k].id);
        expect(x.anchor.x).toBeCloseTo(old.spaces[k].anchor.x + 4.5, 6);
        expect(x.anchor.y).toBeCloseTo(old.spaces[k].anchor.y - 2, 6);
      });
    });
    const was = computeBuildingAreas(before, areaConfig).totals;
    const now = computeBuildingAreas(after, areaConfig).totals;
    expect(now.net).toBeCloseTo(was.net, 6);
    expect(now.gross).toBeCloseTo(was.gross, 6);
    const door = after.storeys[0].openings[0];
    const oldStart = openingGeometry(before.storeys[0].walls[0], before.storeys[0].openings[0]).start;
    const newStart = openingGeometry(after.storeys[0].walls[0], door).start;
    expect(newStart.x).toBeCloseTo(oldStart.x + 4.5, 6);
    expect(newStart.y).toBeCloseTo(oldStart.y - 2, 6);
  });

  it("leaves the project alone for a zero move or an unknown building", () => {
    const p = createSampleProject();
    expect(moveBuilding(p, p.site.buildings[0].id, { x: 0, y: 0 })).toBe(p);
    expect(moveBuilding(p, "building-none", { x: 1, y: 1 })).toBe(p);
  });
});

describe("file format", () => {
  it("saves and reloads the plot, its setbacks and its limits", () => {
    let p = setSetback(onPlot(), 2, 4.5);
    p = setSiteLimits(p, { maxCoverage: 0.4, maxFloorAreaRatio: 1.2 });
    const loaded = parseProject(serializeProject(p));
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.site.boundary).toEqual(RECT);
    expect(loaded.site.setbacks).toEqual([3, 3, 4.5, 3]);
    expect(loaded.site.limits).toEqual({ maxCoverage: 0.4, maxFloorAreaRatio: 1.2 });
  });

  it("upgrades a version 1 file without changing the building", () => {
    const p = createSampleProject();
    const { setbacks: _s, limits: _l, ...oldSite } = p.site;
    const v1 = JSON.stringify({ ...p, schemaVersion: 1, site: oldSite });
    const loaded = parseProject(v1);
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.site.boundary).toEqual([]);
    expect(loaded.site.setbacks).toEqual([]);
    expect(loaded.site.limits).toEqual({ maxCoverage: null, maxFloorAreaRatio: null });
    expect(loaded.site.buildings).toEqual(p.site.buildings);
  });

  it("repairs setbacks that do not match the outline and drops an unreadable plot", () => {
    const p = onPlot();
    const short = parseProject(JSON.stringify({ ...p, site: { ...p.site, setbacks: [2, -1] } }));
    expect(short.site.setbacks).toEqual([2, 0, 0, 0]);
    const broken = parseProject(JSON.stringify({ ...p, site: { ...p.site, boundary: [{ x: 0 }, { x: 1, y: 1 }] } }));
    expect(broken.site.boundary).toEqual([]);
    expect(broken.site.setbacks).toEqual([]);
  });

  it("refuses a file from a newer version", () => {
    const p = createSampleProject();
    expect(() => parseProject(JSON.stringify({ ...p, schemaVersion: SCHEMA_VERSION + 1 }))).toThrow(/newer/);
  });
});
