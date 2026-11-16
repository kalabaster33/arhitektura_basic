import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import balconiesJson from "../config/balconies.json";
import columnsJson from "../config/columns.json";
import splitJson from "../config/storeySplit.json";
import { computeStoreyAreas, parseAreaConfig } from "./areas.ts";
import { balconySiteIssues, parseBalconyConfig } from "./balconies.ts";
import { addStorey, sortedStoreys } from "./building.ts";
import { parseColumnConfig, proposeColumns } from "./columns.ts";
import type { Balcony, Project, Storey } from "./model.ts";
import { addOpening, moveOpening, openingSides } from "./openings.ts";
import { createProject, parseProject, replaceStorey, serializeProject } from "./project.ts";
import { setBoundary } from "./site.ts";
import { linkSpaces } from "./spaces.ts";
import { parseSplitRules, proposeSplits } from "./storeySplit.ts";
import {
  addBalcony,
  addCoreElement,
  rebuildStructure,
  removeBalcony,
  ringArea,
  setAllErkerEdges,
  setFootprint,
  storeyOutline,
  updateBalcony,
} from "./structure.ts";

const config = parseBalconyConfig(balconiesJson);
const areaConfig = parseAreaConfig(areaDefinitions);

/** A 20 x 14 block, ground floor and one storey above, hall and stairs in the middle. */
function block(): Project {
  let p = createProject();
  const id = p.site.buildings[0].id;
  p = setFootprint(p, id, [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 14 },
    { x: 0, y: 14 },
  ]);
  p = setAllErkerEdges(p, id, false);
  p = rebuildStructure(addStorey(p, id).project, id);
  p = addCoreElement(p, id, "hall", { x: 8, y: 5 }, { x: 12, y: 9 }).project;
  p = addCoreElement(p, id, "stair", { x: 8, y: 9 }, { x: 11, y: 13.875 }).project;
  return p;
}

const spec = (patch: Partial<Balcony> = {}): Omit<Balcony, "id"> => ({
  kind: "balcony",
  edge: 0,
  offset: 2,
  width: 3,
  depth: 1.5,
  railing: 0.1,
  ...patch,
});

const storeys = (p: Project) => sortedStoreys(p.site.buildings[0]);
const add = (p: Project, patch: Partial<Balcony> = {}) => {
  const r = addBalcony(p, p.site.buildings[0].id, spec(patch));
  if (!r.id) throw new Error(r.problem ?? "not added");
  return { project: r.project, id: r.id };
};
const spaceNamed = (s: Storey, name: string) => s.spaces.find((x) => x.name === name);
const netOf = (s: Storey, id: string) => computeStoreyAreas(s, areaConfig).spaces.find((x) => x.spaceId === id)!.net;

describe("balcony config", () => {
  it("reads the config and rejects damaged values", () => {
    expect(config.depth).toBeGreaterThan(0);
    expect(() => parseBalconyConfig({ ...balconiesJson, railing: 0 })).toThrow(/railing/);
    expect(() => parseBalconyConfig({ ...balconiesJson, maxIntoSetback: -1 })).toThrow(/maxIntoSetback/);
    expect(() => parseBalconyConfig({ ...balconiesJson, door: { width: 0 } })).toThrow(/door/);
  });
});

describe("balconies", () => {
  it("stand out from the facade of the upper storeys behind a railing, not on the ground floor", () => {
    const { project } = add(block());
    const [ground, upper] = storeys(project);
    expect(ground.walls.some((w) => w.part === "balcony")).toBe(false);
    const railings = upper.walls.filter((w) => w.part === "balcony");
    expect(railings).toHaveLength(3);
    // Side 1 runs along y = 0 with the outside at y < 0.
    expect(Math.min(...railings.flatMap((w) => [w.a.y, w.b.y]))).toBeCloseTo(-1.45, 6);
    const balcony = spaceNamed(upper, "Balcony")!;
    expect(balcony.type).toBe("balcony");
    // To the inner faces: 1.5 deep less the railing, 3 wide less two railings.
    expect(netOf(upper, balcony.id)).toBeCloseTo(1.4 * 2.8, 6);
    // The storey's gross area stays that of the building outline.
    expect(computeStoreyAreas(upper, areaConfig).totals.gross).toBeCloseTo(20 * 14, 6);
  });

  it("take no doors or windows in their railing", () => {
    const { project } = add(block());
    const upper = storeys(project)[1];
    const railing = upper.walls.find((w) => w.part === "balcony")!;
    expect(addOpening(upper, railing.id, "window", 0.7, { width: 0.6, height: 1, sill: 0.9 })).toBe(upper);
  });

  it("are checked when placed or changed", () => {
    const { project, id } = add(block());
    const bid = project.site.buildings[0].id;
    expect(addBalcony(project, bid, spec({ offset: 4 })).problem).toMatch(/overlaps/);
    expect(addBalcony(project, bid, spec({ offset: 18 })).problem).toMatch(/past the end/);
    expect(addBalcony(project, bid, spec({ width: 0.2, offset: 10 })).problem).toMatch(/wide/);
    expect(addBalcony(project, bid, spec({ edge: 9 })).problem).toMatch(/side/);
    expect(updateBalcony(project, bid, id, { depth: 0.1 }).problem).toMatch(/shallow/);
    const moved = updateBalcony(project, bid, id, { edge: 2 });
    expect(moved.problem).toBeNull();
    const railings = storeys(moved.project)[1].walls.filter((w) => w.part === "balcony");
    expect(Math.max(...railings.flatMap((w) => [w.a.y, w.b.y]))).toBeCloseTo(15.45, 6);
  });

  it("go when removed or when the outline is drawn again", () => {
    const { project, id } = add(block());
    const bid = project.site.buildings[0].id;
    const gone = removeBalcony(project, bid, id);
    expect(storeys(gone)[1].walls.some((w) => w.part === "balcony")).toBe(false);
    expect(gone.site.buildings[0].structure.balconies).toBeUndefined();
    const redrawn = setFootprint(project, bid, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(redrawn.site.buildings[0].structure.balconies).toBeUndefined();
  });

  it("join the apartment behind them when the storey is divided", { timeout: 30000 }, () => {
    const { project } = add(block(), { offset: 1 });
    const b = project.site.buildings[0];
    const upper = storeys(project)[1];
    const unit = { name: "One", area: 50, count: 4, program: { bedrooms: 1, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" as const } };
    const result = proposeSplits(b, upper, [unit], "hall", parseSplitRules(splitJson));
    if (!result.ok) throw new Error(result.reason);
    const plan = result.proposals[0].storey;
    const balcony = spaceNamed(plan, "Balcony")!;
    const owner = plan.apartments.find((a) => a.spaceIds.includes(balcony.id));
    expect(owner).toBeDefined();
    // The room right behind it is in the same apartment.
    const { faceBySpaceId } = linkSpaces(plan);
    const behind = plan.spaces.find((s) => {
      const f = faceBySpaceId.get(s.id);
      return f && owner!.spaceIds.includes(s.id) && s.id !== balcony.id;
    });
    expect(behind).toBeDefined();
  });

  it("carry nothing: railings are not in the column grid", { timeout: 30000 }, () => {
    const plain = block();
    const { project } = add(plain);
    const cfg = parseColumnConfig(columnsJson);
    const before = proposeColumns(plain.site.buildings[0], storeys(plain)[1], cfg);
    const after = proposeColumns(project.site.buildings[0], storeys(project)[1], cfg);
    expect(after).toEqual(before);
  });
});

describe("loggias", () => {
  it("are cut into the upper storeys and closed by a railing in the facade line", () => {
    const { project } = add(block(), { kind: "loggia", offset: 2, width: 4, depth: 1.5 });
    const b = project.site.buildings[0];
    const [ground, upper] = storeys(project);
    expect(ringArea(storeyOutline(b, ground.id))).toBeCloseTo(280, 6);
    expect(ringArea(storeyOutline(b, upper.id))).toBeCloseTo(280 - 4 * 1.5, 6);
    expect(upper.walls.filter((w) => w.part === "balcony")).toHaveLength(1);
    const loggia = spaceNamed(upper, "Loggia")!;
    expect(loggia.type).toBe("balcony");
    // 4 wide between the outside walls; deep to the inside face of the railing.
    const wall = b.structure.wallThickness;
    expect(netOf(upper, loggia.id)).toBeCloseTo(4 * (1.5 - wall / 2 - 0.05), 6);
  });

  it("leave the windows on the other sides where they were", () => {
    let p = block();
    const upper = storeys(p)[1];
    const east = upper.walls.find((w) => w.id === `${upper.id}:shell:1`)!;
    p = replaceStorey(p, addOpening(upper, east.id, "window", 5, { width: 1.2, height: 1.4, sill: 0.9 }));
    const window = storeys(p)[1].openings.at(-1)!;
    const after = storeys(add(p, { kind: "loggia", offset: 2, width: 4 }).project)[1];
    expect(after.openings.find((o) => o.id === window.id)).toEqual(window);
  });

  it("may not run into the core or out of the building", () => {
    const p = block();
    const bid = p.site.buildings[0].id;
    expect(addBalcony(p, bid, spec({ kind: "loggia", offset: 8, width: 4, depth: 4.8 })).problem).toMatch(/hall/);
    expect(addBalcony(p, bid, spec({ kind: "loggia", offset: 1, width: 3, depth: 14 })).problem).toMatch(/other side/);
  });
});

describe("balcony doors", () => {
  const door = { width: 0.9, height: 2.2 };
  /** The doors that open onto a room. */
  const doorsInto = (s: Storey, spaceId: string) => {
    const linked = linkSpaces(s);
    return s.openings.filter((o) => o.kind === "door" && openingSides(s, o, linked).includes(spaceId));
  };

  it("give a balcony a door from the room behind, in the middle of the outside wall", () => {
    const { project } = add(block(), { door });
    const upper = storeys(project)[1];
    const balcony = spaceNamed(upper, "Balcony")!;
    const doors = doorsInto(upper, balcony.id);
    expect(doors).toHaveLength(1);
    const wall = upper.walls.find((w) => w.id === doors[0].wallId)!;
    expect(wall.part).toBe("shell");
    // Balcony from x 2 to 5 on the side along y = 0: the door is centred at x 3.5.
    expect(wall.a.x + ((wall.b.x - wall.a.x) / Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y)) * doors[0].offset).toBeCloseTo(3.5, 6);
    expect(doors[0].width).toBe(0.9);
    expect(doors[0].height).toBe(2.2);
    // No other floor and no other balcony gets a second one on the next rebuild.
    const again = storeys(rebuildStructure(project, project.site.buildings[0].id))[1];
    expect(doorsInto(again, balcony.id)).toHaveLength(1);
    expect(storeys(project)[0].openings).toEqual(storeys(block())[0].openings);
  });

  it("give a loggia a door in the back of the cut", () => {
    const { project } = add(block(), { kind: "loggia", offset: 2, width: 4, door });
    const upper = storeys(project)[1];
    const loggia = spaceNamed(upper, "Loggia")!;
    const doors = doorsInto(upper, loggia.id);
    expect(doors).toHaveLength(1);
    const wall = upper.walls.find((w) => w.id === doors[0].wallId)!;
    // The back of the cut lies 1.5 in from the facade, on the wall centreline.
    expect(wall.a.y).toBeCloseTo(1.5 + project.site.buildings[0].structure.wallThickness / 2, 6);
  });

  it("leave a door that was moved where it is, and give none without the setting", () => {
    const { project } = add(block(), { door, width: 4 });
    const bid = project.site.buildings[0].id;
    let upper = storeys(project)[1];
    const placed = upper.openings.at(-1)!;
    upper = moveOpening(upper, placed.id, placed.offset + 1);
    const moved = upper.openings.find((o) => o.id === placed.id)!;
    expect(moved.offset).not.toBe(placed.offset);
    const after = storeys(rebuildStructure(replaceStorey(project, upper), bid))[1];
    expect(after.openings.filter((o) => o.kind === "door" && o.wallId === placed.wallId)).toEqual([moved]);
    const none = storeys(add(block()).project)[1];
    expect(doorsInto(none, spaceNamed(none, "Balcony")!.id)).toHaveLength(0);
  });
});

describe("balconies and the plot", () => {
  /** The block on a plot 3 m clear on every side, with setbacks of `setback`. */
  const onPlot = (p: Project, setback: number) =>
    setBoundary(p, [{ x: -3, y: -3 }, { x: 23, y: -3 }, { x: 23, y: 17 }, { x: -3, y: 17 }], setback);

  it("must keep the setback of the plot edge in front of them", () => {
    const { project } = add(onPlot(block(), 3));
    const b = project.site.buildings[0];
    const issues = balconySiteIssues(project.site, b, config);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/1\.50 m from plot edge 1.*3\.00 m/);
    // Allowed to reach 2 m into the setback: fine.
    expect(balconySiteIssues(project.site, b, { ...config, maxIntoSetback: 2 })).toEqual([]);
    // With a smaller setback: fine.
    const loose = onPlot(project, 1);
    expect(balconySiteIssues(loose.site, loose.site.buildings[0], config)).toEqual([]);
  });

  it("must stay on the plot", () => {
    const { project } = add(onPlot(block(), 0), { depth: 4 });
    const issues = balconySiteIssues(project.site, project.site.buildings[0], config);
    expect(issues[0].message).toMatch(/beyond the plot/);
  });

  it("are saved and read back", () => {
    const { project } = add(block(), { kind: "loggia", offset: 2, width: 4 });
    const raw = JSON.parse(serializeProject(project));
    raw.site.buildings[0].structure.balconies.push({ id: "x", kind: "porch", edge: 0, offset: 1, width: 1, depth: 1, railing: 0.1 });
    const back = parseProject(JSON.stringify(raw));
    expect(back.site.buildings[0].structure.balconies).toEqual(project.site.buildings[0].structure.balconies);
  });
});
