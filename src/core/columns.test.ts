import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import columnsJson from "../config/columns.json";
import layoutRules from "../config/layoutRules.json";
import splitJson from "../config/storeySplit.json";
import { apartmentInteriorWalls, parseLayoutRules, proposeLayouts } from "./autoLayout.ts";
import { parseAreaConfig } from "./areas.ts";
import { addStorey, sortedStoreys } from "./building.ts";
import { axisLetter, parseColumnConfig, proposeColumns } from "./columns.ts";
import { columnRegion, storeyDrawing } from "./drawing.ts";
import { pointInRing } from "./geometry.ts";
import type { Project, Storey } from "./model.ts";
import { addOpening, columnSpansOnWall, wallFreeSpans } from "./openings.ts";
import { createProject, parseProject, serializeProject } from "./project.ts";
import { parseSplitRules, proposeSplits } from "./storeySplit.ts";
import {
  addCoreElement,
  rebuildStructure,
  removeColumn,
  setAllErkerEdges,
  setColumns,
  setErkerDepth,
  setErkerEdge,
  setFootprint,
} from "./structure.ts";

const config = parseColumnConfig(columnsJson);
const rules = parseSplitRules(splitJson);
const door = { width: 0.9, height: 2.1, sill: 0 };

function block(w: number, h: number, erker = 0): Project {
  let p = createProject();
  const id = p.site.buildings[0].id;
  p = setFootprint(p, id, [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]);
  p = setAllErkerEdges(p, id, false);
  if (erker > 0) p = setErkerEdge(setErkerDepth(p, id, erker), id, 0, true);
  p = rebuildStructure(addStorey(p, id).project, id);
  p = addCoreElement(p, id, "hall", { x: 8, y: 5 }, { x: 12, y: 9 }).project;
  p = addCoreElement(p, id, "stair", { x: 8, y: 9 }, { x: 11, y: 13.875 }).project;
  return p;
}

const unit = (name: string, area: number, count: number) => ({
  name,
  area,
  count,
  program: { bedrooms: 1, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" as const },
});

/** The point block with its upper storey divided into four apartments. */
function plannedBlock(erker = 0): { project: Project; storey: Storey } {
  const p = block(20, 14, erker);
  const b = p.site.buildings[0];
  const upper = sortedStoreys(b)[1];
  const result = proposeSplits(b, upper, [unit("Two", 65, 2), unit("One", 50, 2)], "hall", rules);
  if (!result.ok) throw new Error(result.reason);
  const storey = result.proposals[0].storey;
  const project = {
    ...p,
    site: { ...p.site, buildings: [{ ...b, storeys: b.storeys.map((s) => (s.id === storey.id ? storey : s)) }] },
  };
  return { project, storey };
}

/** Checks that the columns form the full grid: a column at every crossing that lies in the building. */
function expectFullGrid(
  proposal: ReturnType<typeof proposeColumns>,
  footprint: { x: number; y: number }[],
  skip: (x: number, y: number) => boolean = () => false,
) {
  const { grid, columns } = proposal;
  for (const c of columns) {
    expect(grid.xs).toContain(c.at.x);
    expect(grid.ys).toContain(c.at.y);
  }
  for (const x of grid.xs) {
    for (const y of grid.ys) {
      const inside = [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) =>
        pointInRing({ x: x + sx * (config.width / 2 - 1e-4), y: y + sy * (config.depth / 2 - 1e-4) }, footprint),
      );
      const has = columns.some((c) => c.at.x === x && c.at.y === y);
      expect(has).toBe(inside && !skip(x, y));
    }
  }
}

const spansOf = (axes: number[]) => axes.slice(1).map((v, i) => v - axes[i]);

describe("column config", () => {
  it("reads the config and rejects damaged values", () => {
    expect(config.maxSpan).toBeGreaterThan(config.minSpan);
    expect(() => parseColumnConfig({ ...columnsJson, width: 0 })).toThrow(/width/);
    expect(() => parseColumnConfig({ ...columnsJson, maxSpan: "6" })).toThrow(/maxSpan/);
    expect(() => parseColumnConfig({ ...columnsJson, minSpan: 9 })).toThrow(/minSpan/);
  });

  it("names the axes", () => {
    expect([0, 1, 25, 26, 27].map(axisLetter)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });
});

describe("column grid", () => {
  it("puts a column at every crossing of the axes, flush with the outside face", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock();
    const building = project.site.buildings[0];
    const proposal = proposeColumns(building, storey, config);
    const { xs, ys } = proposal.grid;
    // The outer axes are half a column in from the outside face.
    expect(xs[0]).toBeCloseTo(0.15, 6);
    expect(xs.at(-1)).toBeCloseTo(19.85, 6);
    expect(ys[0]).toBeCloseTo(0.15, 6);
    expect(ys.at(-1)).toBeCloseTo(13.85, 6);
    // Every span between the shortest and the largest.
    for (const span of [...spansOf(xs), ...spansOf(ys)]) {
      expect(span).toBeGreaterThanOrEqual(config.minSpan - 1e-6);
      expect(span).toBeLessThanOrEqual(config.maxSpan + 1e-6);
    }
    // The hall walls are axes.
    expect(xs).toContain(8);
    expect(xs.includes(11) || xs.includes(12)).toBe(true);
    for (const y of [5, 9]) expect(ys).toContain(y);
    // No column inside the stairs (8..11 x 9..13.875).
    const inStairs = (x: number, y: number) => x > 8.1 && x < 10.9 && y > 9.1 && y < 13.775;
    expectFullGrid(proposal, building.structure.footprint, inStairs);
    // So from every column there is one along x and one along y within the largest span.
    for (const c of proposal.columns) {
      const sameRow = proposal.columns.filter((o) => o !== c && o.at.y === c.at.y).map((o) => Math.abs(o.at.x - c.at.x));
      const sameCol = proposal.columns.filter((o) => o !== c && o.at.x === c.at.x).map((o) => Math.abs(o.at.y - c.at.y));
      expect(Math.min(...sameRow)).toBeLessThanOrEqual(config.maxSpan + 1e-6);
      expect(Math.min(...sameCol)).toBeLessThanOrEqual(config.maxSpan + 1e-6);
    }
  });

  it("divides a long side evenly when the largest span is short", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock();
    const { grid } = proposeColumns(project.site.buildings[0], storey, { ...config, maxSpan: 4, minSpan: 2 });
    for (const span of [...spansOf(grid.xs), ...spansOf(grid.ys)]) expect(span).toBeLessThanOrEqual(4 + 1e-6);
  });

  it("follows the walls between the apartments where they keep the spans", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock();
    const { grid } = proposeColumns(project.site.buildings[0], storey, config);
    const party = storey.walls.filter((w) => !w.part);
    expect(party.length).toBeGreaterThan(0);
    // Each wall between apartments is on an axis, or an axis is within the shortest span of it.
    for (const w of party) {
      if (w.a.x === w.b.x) expect(Math.min(...grid.xs.map((x) => Math.abs(x - w.a.x)))).toBeLessThan(config.minSpan);
      if (w.a.y === w.b.y) expect(Math.min(...grid.ys.map((y) => Math.abs(y - w.a.y)))).toBeLessThan(config.minSpan);
    }
  });

  it("does not put walls inside one apartment into the grid", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock();
    const building = project.site.buildings[0];
    const apt = storey.apartments[0];
    const laid = proposeLayouts(
      storey,
      apt.id,
      parseLayoutRules(layoutRules),
      { partitionThickness: 0.1, door, snap: 0.05 },
      1,
      apt.program,
    );
    if (!laid.ok) throw new Error(laid.reason);
    const inside = laid.proposals[0].storey;
    expect(apartmentInteriorWalls(inside, apt.id).length).toBeGreaterThan(0);
    expect(proposeColumns(building, inside, config)).toEqual(proposeColumns(building, storey, config));
  });

  it("keeps every column on the ground with an erker above", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock(1.2);
    const building = project.site.buildings[0];
    const proposal = proposeColumns(building, storey, config);
    expect(proposal.columns.length).toBeGreaterThan(4);
    expect(proposal.grid.ys[0]).toBeCloseTo(0.15, 6);
    for (const c of proposal.columns) expect(pointInRing(c.at, building.structure.footprint)).toBe(true);
  });

  it("fills an L-shaped outline only where the building is", () => {
    let p = createProject();
    const id = p.site.buildings[0].id;
    p = setFootprint(p, id, [
      { x: 0, y: 0 },
      { x: 18, y: 0 },
      { x: 18, y: 8 },
      { x: 8, y: 8 },
      { x: 8, y: 16 },
      { x: 0, y: 16 },
    ]);
    const b = p.site.buildings[0];
    const proposal = proposeColumns(b, b.storeys[0], config);
    expect(proposal.grid.xs).toContain(7.85);
    expect(proposal.grid.ys).toContain(7.85);
    expectFullGrid(proposal, b.structure.footprint);
    expect(proposal.columns.some((c) => c.at.x > 9 && c.at.y > 9)).toBe(false);
  });

  it("is empty without an outline", () => {
    const p = createProject();
    const b = p.site.buildings[0];
    expect(proposeColumns(b, b.storeys[0], config)).toEqual({ grid: { xs: [], ys: [] }, columns: [] });
  });
});

describe("column axes", () => {
  it("are kept with the columns, saved, and go with the last column", () => {
    let p = block(20, 14);
    const id = p.site.buildings[0].id;
    const grid = { xs: [0.15, 6, 12], ys: [0.15, 6] };
    p = setColumns(p, id, [{ at: { x: 6, y: 6 }, w: 0.3, d: 0.3 }], grid);
    expect(p.site.buildings[0].structure.columnGrid).toEqual(grid);
    const back = parseProject(serializeProject(p));
    expect(back.site.buildings[0].structure.columnGrid).toEqual(grid);
    const only = p.site.buildings[0].structure.columns![0].id;
    expect(removeColumn(p, id, only).site.buildings[0].structure.columnGrid).toBeUndefined();
    expect(setColumns(p, id, []).site.buildings[0].structure.columnGrid).toBeUndefined();
  });
});

describe("columns on the storeys", () => {
  it("stands on every storey and goes again when removed", () => {
    let p = block(20, 14);
    const id = p.site.buildings[0].id;
    p = setColumns(p, id, [{ at: { x: 4, y: 4 }, w: 0.3, d: 0.3 }]);
    const b = p.site.buildings[0];
    expect(b.structure.columns).toHaveLength(1);
    for (const s of b.storeys) expect(s.columns).toEqual(b.structure.columns);
    p = removeColumn(p, id, b.structure.columns![0].id);
    expect(p.site.buildings[0].structure.columns).toBeUndefined();
    for (const s of p.site.buildings[0].storeys) expect(s.columns).toBeUndefined();
  });

  it("leaves a building without columns exactly as it was", () => {
    const p = block(20, 14);
    expect(rebuildStructure(p, p.site.buildings[0].id)).toEqual(p);
  });

  it("keeps doors out of columns", () => {
    let p = block(20, 14);
    const id = p.site.buildings[0].id;
    // The south wall of the hall runs from (8, 5) to (12, 5).
    const hallWall = (s: Storey) => s.walls.find((w) => w.part === "core" && w.a.y === 5 && w.b.y === 5)!;
    let ground = sortedStoreys(p.site.buildings[0])[0];
    const wall = hallWall(ground);
    const centre = 2; // a door in the middle of the wall
    ground = addOpening(ground, wall.id, "door", centre, door);
    p = { ...p, site: { ...p.site, buildings: [{ ...p.site.buildings[0], storeys: p.site.buildings[0].storeys.map((s) => (s.id === ground.id ? ground : s)) }] } };
    const doorId = ground.openings.at(-1)!.id;
    // A column right where the door is: the door moves aside.
    p = setColumns(p, id, [{ at: { x: 10, y: 5 }, w: 0.4, d: 0.4 }]);
    const after = sortedStoreys(p.site.buildings[0])[0];
    const moved = after.openings.find((o) => o.id === doorId)!;
    expect(moved).toBeDefined();
    const [[lo, hi]] = columnSpansOnWall(hallWall(after), after.columns);
    expect(moved.offset + moved.width / 2 <= lo + 1e-6 || moved.offset - moved.width / 2 >= hi - 1e-6).toBe(true);
    // And a new door cannot be put into the column.
    const free = wallFreeSpans(after, hallWall(after));
    for (const [a, b] of free) expect(b <= lo + 1e-6 || a >= hi - 1e-6).toBe(true);
  });

  it("is saved and read back", () => {
    let p = block(20, 14);
    p = setColumns(p, p.site.buildings[0].id, [{ at: { x: 4, y: 4 }, w: 0.3, d: 0.4 }]);
    const back = parseProject(serializeProject(p));
    expect(back.site.buildings[0].structure.columns).toEqual(p.site.buildings[0].structure.columns);
    for (const s of back.site.buildings[0].storeys) expect(s.columns).toEqual(p.site.buildings[0].structure.columns);
    // A damaged column is left out; a file without columns has none.
    const raw = JSON.parse(serializeProject(p));
    raw.site.buildings[0].structure.columns.push({ id: "x", at: { x: 1 }, w: 0.3, d: 0.3 });
    expect(parseProject(JSON.stringify(raw)).site.buildings[0].structure.columns).toHaveLength(1);
    delete raw.site.buildings[0].structure.columns;
    const none = parseProject(JSON.stringify(raw));
    expect(none.site.buildings[0].structure.columns).toBeUndefined();
    for (const s of none.site.buildings[0].storeys) expect(s.columns).toBeUndefined();
  });

  it("is drawn on its own layer", () => {
    let p = block(20, 14);
    p = setColumns(p, p.site.buildings[0].id, [
      { at: { x: 4, y: 4 }, w: 0.3, d: 0.3 },
      { at: { x: 4.2, y: 4 }, w: 0.3, d: 0.3 },
    ]);
    const s = sortedStoreys(p.site.buildings[0])[0];
    // Two touching columns are one shape.
    expect(columnRegion(s)).toHaveLength(1);
    const drawing = storeyDrawing(s, parseAreaConfig(areaDefinitions), 0.25);
    expect(drawing.entities.some((e) => e.layer === "columns" && e.kind === "region")).toBe(true);
  });
});
