import { describe, expect, it } from "vitest";
import areaDefinitions from "../config/areaDefinitions.json";
import dimensionStyleJson from "../config/dimensionStyle.json";
import exportDefaults from "../config/exportDefaults.json";
import siteRulesJson from "../config/siteRules.json";
import { parseAreaConfig } from "./areas.ts";
import { copyStorey, moveBuilding } from "./building.ts";
import {
  type DimChain,
  addDimension,
  chainEntities,
  deleteDimension,
  dimensionSnapPoints,
  formatDimension,
  offsetFromLine,
  outsideChains,
  ownChain,
  parseDimensionStyle,
  roomChains,
  storeyChains,
} from "./dimensions.ts";
import { addWall } from "./edit.ts";
import { writeDxf } from "./exportDxf.ts";
import { type Storey, SCHEMA_VERSION } from "./model.ts";
import { addOpening } from "./openings.ts";
import {
  createProject,
  createSampleProject,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "./project.ts";
import { buildSheets, parseExportConfig } from "./sheets.ts";
import { analyseSite, parseSiteRules } from "./site.ts";

const style = parseDimensionStyle(dimensionStyleJson);
const areaConfig = parseAreaConfig(areaDefinitions);
const exportConfig = parseExportConfig(exportDefaults);
const DOOR = { width: 0.9, height: 2.1, sill: 0 };
const WINDOW = { width: 1.2, height: 1.4, sill: 0.9 };

/**
 * The sample plan: an 8 x 6 m shell (walls 0.25 thick) with a partition at
 * x = 5 and another from it to the right wall at y = 3.5 (both 0.1 thick).
 * So: one large room on the left, two smaller ones on the right.
 */
const sample = (): Storey => getActiveStorey(createSampleProject());

const values = (chains: DimChain[], side: string, kind: string) =>
  chains.find((c) => c.side === side && c.kind === kind)?.spans.map((s) => s.value);

describe("dimension style", () => {
  it("accepts the shipped style and names the key that is wrong", () => {
    expect(style).toMatchObject({ unit: "cm", decimals: 0, measureTo: "faces" });
    expect(() => parseDimensionStyle({ ...dimensionStyleJson, unit: "inch" })).toThrow('"unit"');
    expect(() => parseDimensionStyle({ ...dimensionStyleJson, tickMm: 0 })).toThrow('"tickMm"');
  });

  it("writes lengths in the chosen unit, with one more decimal only when needed", () => {
    expect(formatDimension(3.65, style)).toBe("365");
    expect(formatDimension(0.125, style)).toBe("12.5");
    expect(formatDimension(3.65, { unit: "m", decimals: 2 })).toBe("3.65");
    expect(formatDimension(0.9, { unit: "mm", decimals: 0 })).toBe("900");
  });
});

describe("chains around the building", () => {
  it("gives every side its rooms chain and its overall length", () => {
    const chains = outsideChains(sample(), style, 100);
    expect(chains.map((c) => `${c.side} ${c.kind}`)).toEqual([
      "top rooms",
      "top overall",
      "bottom rooms",
      "bottom overall",
      "left rooms",
      "left overall",
      "right rooms",
      "right overall",
    ]);
    expect(values(chains, "top", "overall")).toEqual([8.25]);
    expect(values(chains, "left", "overall")).toEqual([6.25]);
  });

  it("measures rooms and wall thicknesses between the wall faces", () => {
    const chains = outsideChains(sample(), style, 100);
    const top = values(chains, "top", "rooms")!;
    expect(top).toEqual([0.25, 4.825, 0.1, 2.825, 0.25]);
    expect(top.reduce((a, b) => a + b, 0)).toBeCloseTo(8.25, 9);
    expect(values(chains, "left", "rooms")).toEqual([0.25, 5.75, 0.25]);
  });

  it("measures the rooms seen from each side, not the ones behind them", () => {
    // From the right only the two small rooms are seen; the large one is behind them.
    const chains = outsideChains(sample(), style, 100);
    expect(values(chains, "right", "rooms")).toEqual([0.25, 3.325, 0.1, 2.325, 0.25]);
  });

  it("can measure from wall axis to wall axis instead", () => {
    const chains = outsideChains(sample(), { ...style, measureTo: "centrelines" }, 100);
    expect(values(chains, "top", "rooms")).toEqual([5, 3]);
    expect(values(chains, "right", "rooms")).toEqual([3.5, 2.5]);
    expect(values(chains, "top", "overall")).toEqual([8.25]); // the overall length stays face to face
  });

  it("adds an openings chain, nearest the wall, on the side an opening faces", () => {
    let storey = sample();
    storey = addOpening(storey, storey.walls[0].id, "door", 2, DOOR); // the wall along y = 0, the top
    storey = addOpening(storey, storey.walls[1].id, "window", 1.5, WINDOW); // the wall along x = 8
    const chains = outsideChains(storey, style, 100);
    expect(values(chains, "top", "openings")).toEqual([1.675, 0.9, 5.675]);
    expect(values(chains, "right", "openings")).toEqual([1.025, 1.2, 4.025]);
    expect(values(chains, "bottom", "openings")).toBeUndefined();
    expect(values(chains, "left", "openings")).toBeUndefined();
    // 10 mm, 17 mm and 24 mm from the wall at 1:100.
    const y = (kind: string) => chains.find((c) => c.side === "top" && c.kind === kind)!.spans[0].from.y;
    expect([y("openings"), y("rooms"), y("overall")].map((v) => +(-0.125 - v).toFixed(6))).toEqual([1, 1.7, 2.4]);
  });

  it("leaves a door between two rooms out of the chains", () => {
    let storey = sample();
    storey = addOpening(storey, storey.walls[4].id, "door", 1.5, DOOR); // the partition at x = 5
    expect(storey.openings).toHaveLength(1);
    expect(outsideChains(storey, style, 100).some((c) => c.kind === "openings")).toBe(false);
  });

  it("spaces the chains by the scale of the drawing", () => {
    const at = (scale: number) => outsideChains(sample(), style, scale)[0].spans[0].from.y;
    expect(-0.125 - at(50)).toBeCloseTo(0.5);
    expect(-0.125 - at(200)).toBeCloseTo(2);
  });

  it("measures a slanted wall as seen from the side and skips its openings", () => {
    let storey = getActiveStorey(createProject());
    const corners = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 8, y: 4 }, { x: 0, y: 4 }];
    corners.forEach((p, i) => (storey = addWall(storey, p, corners[(i + 1) % 4], 0.25, "exterior")));
    const slanted = storey.walls.find((w) => w.a.x !== w.b.x && w.a.y !== w.b.y)!;
    storey = addOpening(storey, slanted.id, "window", 2, WINDOW);
    expect(storey.openings).toHaveLength(1);
    const chains = outsideChains(storey, style, 100);
    expect(chains.some((c) => c.kind === "openings")).toBe(false);
    const overall = values(chains, "right", "overall")!;
    expect(overall[0]).toBeGreaterThan(4);
    expect(overall[0]).toBeLessThan(4.4); // about the 4 m it is tall, not the 4.47 m the wall is long
  });

  it("has nothing to say about an empty storey", () => {
    expect(outsideChains(getActiveStorey(createProject()), style, 100)).toEqual([]);
  });
});

describe("room dimensions", () => {
  it("gives every room its clear width and length", () => {
    const storey = sample();
    const chains = roomChains(storey, style, 100);
    expect(chains).toHaveLength(storey.spaces.length * 2);
    const sizes = storey.spaces.map((s) =>
      chains.filter((c) => c.id === s.id).map((c) => c.spans[0].value),
    );
    expect(sizes).toContainEqual([4.825, 5.75]);
    expect(sizes).toContainEqual([2.825, 3.325]);
    expect(sizes).toContainEqual([2.825, 2.325]);
  });

  it("draws the width across the room and the length down it, inside the walls", () => {
    const [across, down] = roomChains(sample(), style, 100).filter((c) => c.spans[0].value === 4.825 || c.spans[0].value === 5.75);
    expect(across.spans[0].from.y).toBe(across.spans[0].to.y);
    expect([across.spans[0].from.x, across.spans[0].to.x]).toEqual([0.125, 4.95]);
    expect(down.spans[0].from.x).toBe(down.spans[0].to.x);
    expect([down.spans[0].from.y, down.spans[0].to.y]).toEqual([0.125, 5.875]);
  });
});

describe("dimensions placed by hand", () => {
  it("measures the true distance on a line beside the two points", () => {
    const chain = ownChain({ id: "d1", a: { x: 0, y: 0 }, b: { x: 3, y: 4 }, offset: 1 })!;
    expect(chain.spans[0].value).toBe(5);
    // One metre to the left of a -> b.
    expect(chain.spans[0].from.x).toBeCloseTo(-0.8);
    expect(chain.spans[0].from.y).toBeCloseTo(0.6);
    expect(chain.witness).toHaveLength(2);
    expect(offsetFromLine({ x: 0, y: 0 }, { x: 3, y: 4 }, chain.spans[0].to)).toBeCloseTo(1);
    expect(offsetFromLine({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: -1.5 })).toBeCloseTo(-1.5);
  });

  it("is added to and deleted from a storey, and refused between a point and itself", () => {
    const storey = sample();
    const one = addDimension(storey, { x: 0.125, y: 0.125 }, { x: 4.95, y: 5.875 }, 0.5);
    expect(one.dimensions).toHaveLength(1);
    expect(addDimension(one, { x: 1, y: 1 }, { x: 1, y: 1 }, 0.5)).toBe(one);
    expect(deleteDimension(one, one.dimensions[0].id).dimensions).toEqual([]);
    expect(deleteDimension(one, "nothing")).toBe(one);
  });

  it("snaps to wall corners and to the edges of openings", () => {
    let storey = sample();
    storey = addOpening(storey, storey.walls[0].id, "door", 2, DOOR);
    const has = (x: number, y: number) =>
      dimensionSnapPoints(storey).some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6);
    expect(has(0.125, 0.125)).toBe(true); // inside corner of the large room
    expect(has(-0.125, -0.125)).toBe(true); // outside corner of the building
    expect(has(1.55, 0.125)).toBe(true); // door jamb on the inside face
    expect(has(2.45, -0.125)).toBe(true); // door jamb on the outside face
    expect(has(5, 3.5)).toBe(true); // end of a partition
  });

  it("moves with the building and is copied with its storey", () => {
    let project = createSampleProject();
    const storey = addDimension(getActiveStorey(project), { x: 0, y: 0 }, { x: 8, y: 0 }, -1);
    project = replaceStorey(project, storey);
    const moved = moveBuilding(project, project.site.buildings[0].id, { x: 2, y: -1 });
    expect(getActiveStorey(moved).dimensions[0]).toMatchObject({ a: { x: 2, y: -1 }, b: { x: 10, y: -1 }, offset: -1 });
    const copied = copyStorey(project, storey.id).project.site.buildings[0].storeys[1];
    expect(copied.dimensions).toHaveLength(1);
    expect(copied.dimensions[0].id).not.toBe(storey.dimensions[0].id);
    expect(copied.dimensions[0].a).toEqual({ x: 0, y: 0 });
  });
});

describe("drawing dimensions", () => {
  it("writes the figures in centimetres on the dimensions layer", () => {
    const entities = chainEntities(outsideChains(sample(), style, 100), style, 100);
    expect(entities.every((e) => e.layer === "dimensions")).toBe(true);
    const texts = entities.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    expect(texts.slice(0, 6)).toEqual(["25", "482.5", "10", "282.5", "25", "825"]);
  });

  it("turns the figures of an upright chain to read from the bottom up", () => {
    const chains = outsideChains(sample(), style, 100);
    const text = (side: string) => {
      const e = chainEntities(chains.filter((c) => c.side === side && c.kind === "overall"), style, 100);
      return e.find((x) => x.kind === "text") as Extract<(typeof e)[number], { kind: "text" }>;
    };
    expect(text("top").angle).toBeCloseTo(0);
    expect(text("left").angle).toBeCloseTo(-Math.PI / 2);
    // Figures stand above a level line and to the left of an upright one.
    // The overall chain is the second one here: 17 mm from the wall at 1:100.
    expect(text("top").at.y).toBeLessThan(-0.125 - 1.7);
    expect(text("left").at.x).toBeLessThan(-0.125 - 1.7);
  });

  it("puts a figure too wide for its stretch under the line", () => {
    const chain = outsideChains(sample(), style, 100).find((c) => c.side === "top" && c.kind === "rooms")!;
    const lineY = chain.spans[0].from.y;
    const texts = chainEntities([chain], style, 100).flatMap((e) => (e.kind === "text" ? [e] : []));
    const wall = texts.find((t) => t.text === "10")!; // 1 mm of paper for two figures
    const room = texts.find((t) => t.text === "482.5")!;
    expect(room.at.y).toBeLessThan(lineY);
    expect(wall.at.y).toBeGreaterThan(lineY);
  });

  it("shows only what is switched on, and hand-placed dimensions always", () => {
    const storey = addDimension(sample(), { x: 0, y: 0 }, { x: 8, y: 0 }, -1);
    const kinds = (outside: boolean, rooms: boolean) => [
      ...new Set(
        storeyChains(storey, { outsideDimensions: outside, roomDimensions: rooms }, style, 100).map((c) => c.kind),
      ),
    ];
    expect(kinds(true, true)).toEqual(["rooms", "overall", "room", "own"]);
    expect(kinds(true, false)).toEqual(["rooms", "overall", "own"]);
    expect(kinds(false, false)).toEqual(["own"]);
  });
});

describe("dimensions in files", () => {
  const sheetsOf = (withStyle: boolean) => {
    const project = createSampleProject();
    const analysis = analyseSite(project.site, parseSiteRules(siteRulesJson), areaConfig);
    return buildSheets(
      project,
      { storeyIds: [getActiveStorey(project).id], includeSite: false, scale: 100, siteScale: 200 },
      areaConfig,
      analysis,
      exportConfig,
      withStyle ? style : undefined,
    );
  };

  it("are drawn on exported plans, which need more room for them", () => {
    const [plain] = sheetsOf(false);
    const [dimensioned] = sheetsOf(true);
    expect(plain.drawing.entities.some((e) => e.layer === "dimensions")).toBe(false);
    expect(dimensioned.drawing.entities.some((e) => e.layer === "dimensions")).toBe(true);
    // Two chains on each side: 17 mm of paper plus the figures, so more than 1.7 m at 1:100.
    expect(plain.drawing.bounds!.minX - dimensioned.drawing.bounds!.minX).toBeGreaterThan(1.7);
    expect(plain.drawing.bounds!.minX - dimensioned.drawing.bounds!.minX).toBeLessThan(2.5);
  });

  it("go into a DXF on their own layer, upright figures turned", () => {
    const dxf = writeDxf(sheetsOf(true), exportConfig);
    expect(dxf).toContain("TEXT\r\n8\r\nA-ANNO-DIMS\r\n");
    // The overall height, 625, reads from the bottom up: turned 90 degrees.
    expect(dxf).toMatch(/\r\n1\r\n625\r\n50\r\n90\r\n/);
    expect(dxf).toMatch(/\r\n1\r\n825\r\n72\r\n/); // level figures are not turned
  });

  it("are saved and loaded with the project", () => {
    let project = createSampleProject();
    project = replaceStorey(project, addDimension(getActiveStorey(project), { x: 0, y: 0 }, { x: 8, y: 0 }, -1));
    project = { ...project, annotations: { outsideDimensions: false, roomDimensions: true } };
    const loaded = parseProject(serializeProject(project));
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(loaded.annotations).toEqual({ outsideDimensions: false, roomDimensions: true });
    expect(getActiveStorey(loaded).dimensions).toEqual(getActiveStorey(project).dimensions);
  });

  it("are added, switched on, to a file saved before there were dimensions", () => {
    const project = createSampleProject();
    const old: any = JSON.parse(serializeProject(project));
    old.schemaVersion = 2;
    delete old.annotations;
    for (const s of old.site.buildings[0].storeys) delete s.dimensions;
    const loaded = parseProject(JSON.stringify(old));
    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.annotations).toEqual({ outsideDimensions: true, roomDimensions: true });
    expect(getActiveStorey(loaded).dimensions).toEqual([]);
    expect(getActiveStorey(loaded).walls).toHaveLength(6);
  });

  it("drop a dimension that cannot be read and keep the rest", () => {
    let project = createSampleProject();
    project = replaceStorey(project, addDimension(getActiveStorey(project), { x: 0, y: 0 }, { x: 8, y: 0 }, -1));
    const data: any = JSON.parse(serializeProject(project));
    data.site.buildings[0].storeys[0].dimensions.push({ id: "broken", a: { x: 0 }, b: null, offset: "far" });
    expect(getActiveStorey(parseProject(JSON.stringify(data))).dimensions).toHaveLength(1);
  });
});
