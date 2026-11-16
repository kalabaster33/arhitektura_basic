import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import columnsJson from "../config/columns.json";
import layoutRules from "../config/layoutRules.json";
import splitJson from "../config/storeySplit.json";
import { apartmentInteriorWalls, parseLayoutRules, proposeLayouts } from "./autoLayout.ts";
import { parseAreaConfig } from "./areas.ts";
import { addStorey, sortedStoreys } from "./building.ts";
import { parseColumnConfig, proposeColumns } from "./columns.ts";
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

const near = (cols: { at: { x: number; y: number } }[], x: number, y: number, tol = 0.3) =>
  cols.some((c) => Math.abs(c.at.x - x) <= tol && Math.abs(c.at.y - y) <= tol);

describe("column config", () => {
  it("reads the config and rejects damaged values", () => {
    expect(config.maxSpan).toBeGreaterThan(0);
    expect(() => parseColumnConfig({ ...columnsJson, width: 0 })).toThrow(/width/);
    expect(() => parseColumnConfig({ ...columnsJson, maxSpan: "6" })).toThrow(/maxSpan/);
  });
});

describe("column grid", () => {
  it("puts columns at the corners, the core and where apartment walls meet the facade", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock();
    const building = project.site.buildings[0];
    const cols = proposeColumns(building, storey, config);
    // Outline corners, just inside the outside face.
    for (const [x, y] of [[0, 0], [20, 0], [20, 14], [0, 14]]) expect(near(cols, x, y)).toBe(true);
    // Hall corners.
    for (const [x, y] of [[8, 5], [12, 5]]) expect(near(cols, x, y)).toBe(true);
    // Every wall between two apartments ends in a column at the facade.
    const party = storey.walls.filter((w) => !w.part);
    expect(party.length).toBeGreaterThan(0);
    for (const w of party) {
      const onFacade = [w.a, w.b].find((p) => p.x < 0.2 || p.x > 19.8 || p.y < 0.2 || p.y > 13.8);
      if (onFacade) expect(near(cols, onFacade.x, onFacade.y)).toBe(true);
    }
    // All of them stand inside the ground floor, none overlapping another.
    for (const c of cols) {
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const corner = { x: c.at.x + sx * (c.w / 2 - 1e-4), y: c.at.y + sy * (c.d / 2 - 1e-4) };
        expect(pointInRing(corner, building.structure.footprint)).toBe(true);
      }
    }
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        expect(Math.hypot(cols[i].at.x - cols[j].at.x, cols[i].at.y - cols[j].at.y)).toBeGreaterThanOrEqual(config.mergeDistance);
      }
    }
  });

  it("keeps the span along the facade within the largest span", { timeout: 30000 }, () => {
    const { project, storey } = plannedBlock();
    const cols = proposeColumns(project.site.buildings[0], storey, { ...config, maxSpan: 4 });
    const south = cols.filter((c) => c.at.y < 0.5).map((c) => c.at.x).sort((a, b) => a - b);
    expect(south[0]).toBeLessThan(0.5);
    expect(south.at(-1)).toBeGreaterThan(19.5);
    for (let i = 1; i < south.length; i++) expect(south[i] - south[i - 1]).toBeLessThanOrEqual(4 + 1e-6);
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
    const cols = proposeColumns(building, storey, config);
    expect(cols.length).toBeGreaterThan(4);
    for (const c of cols) expect(pointInRing(c.at, building.structure.footprint)).toBe(true);
  });

  it("is empty without an outline", () => {
    const p = createProject();
    const b = p.site.buildings[0];
    expect(proposeColumns(b, b.storeys[0], config)).toEqual([]);
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
