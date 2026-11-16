import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import annotationStyleJson from "../config/annotationStyle.json";
import areaDefinitions from "../config/areaDefinitions.json";
import dimensionStyleJson from "../config/dimensionStyle.json";
import exportDefaults from "../config/exportDefaults.json";
import siteRulesJson from "../config/siteRules.json";
import { fileBase } from "../export/download.ts";
import { scaleBarLength, writePdf } from "../export/pdf.ts";
import { writeXlsx } from "../export/xlsx.ts";
import { parseAnnotationStyle } from "./annotations.ts";
import { createApartment } from "./apartments.ts";
import { computeBuildingAreas, computeStoreyAreas, parseAreaConfig } from "./areas.ts";
import { copyStorey, sortedStoreys } from "./building.ts";
import { parseDimensionStyle } from "./dimensions.ts";
import { type Entity, arcPoints, siteDrawing, storeyDrawing, translateDrawing, wallRegion } from "./drawing.ts";
import { arrangeForDxf, dxfText, writeDxf } from "./exportDxf.ts";
import { type Cell, buildSchedule, cellValue } from "./exportSchedule.ts";
import type { Project, Storey } from "./model.ts";
import { addOpening } from "./openings.ts";
import { createSampleProject, getActiveStorey, replaceStorey } from "./project.ts";
import { buildSheets, layoutSheet, parseExportConfig, sheetsThatDoNotFit } from "./sheets.ts";
import { analyseSite, parseSiteRules, regionArea, setBoundary, setSetback } from "./site.ts";
import { setColumns } from "./structure.ts";

const areaConfig = parseAreaConfig(areaDefinitions);
const siteRules = parseSiteRules(siteRulesJson);
const config = parseExportConfig(exportDefaults);
const SIZE = {
  door: { width: 0.9, height: 2.1, sill: 0 },
  window: { width: 1.2, height: 1.4, sill: 0.9 },
};
const INFO = { date: "15.11.2026", notes: ["To be verified."], footprintRule: "all storeys seen from above" };

/** The sample plan (8 x 6 m, three rooms) with a door in the bottom wall and a window in the right one. */
function plan(): { project: Project; storey: Storey } {
  let project = createSampleProject();
  let storey = getActiveStorey(project);
  storey = addOpening(storey, storey.walls[0].id, "door", 2, SIZE.door);
  storey = addOpening(storey, storey.walls[1].id, "window", 1.5, SIZE.window);
  project = replaceStorey(project, storey);
  return { project, storey };
}

/** Two storeys on a 24 x 17 m plot with 3 m setbacks. */
function withSite(): Project {
  const { project, storey } = plan();
  const two = copyStorey(project, storey.id).project;
  return setBoundary(two, [{ x: -6, y: -5 }, { x: 18, y: -5 }, { x: 18, y: 12 }, { x: -6, y: 12 }], 3);
}

const analyse = (project: Project) => analyseSite(project.site, siteRules, areaConfig);
const allStoreyIds = (project: Project) => project.site.buildings.flatMap((b) => b.storeys.map((s) => s.id));
const sheetsOf = (project: Project, scale = 100) =>
  buildSheets(
    project,
    { storeyIds: allStoreyIds(project), includeSite: true, scale, siteScale: 200 },
    areaConfig,
    analyse(project),
    config,
  );
const ofKind = <K extends Entity["kind"]>(entities: Entity[], kind: K) =>
  entities.filter((e): e is Extract<Entity, { kind: K }> => e.kind === kind);

/** The entities of a DXF file, each as its list of [group code, value] pairs. */
function dxfEntities(dxf: string): [number, string][][] {
  const lines = dxf.trimEnd().split("\r\n");
  const pairs: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i]), lines[i + 1]]);
  const start = pairs.findIndex(([c, v], i) => c === 2 && v === "ENTITIES" && pairs[i - 1][1] === "SECTION");
  const out: [number, string][][] = [];
  for (const pair of pairs.slice(start + 1)) {
    if (pair[0] === 0) {
      if (pair[1] === "ENDSEC") break;
      out.push([pair]);
    } else out[out.length - 1].push(pair);
  }
  return out;
}
const group = (entity: [number, string][], code: number) => entity.find(([c]) => c === code)?.[1];

describe("export config", () => {
  it("accepts the shipped defaults", () => {
    expect(config.paper.A3).toEqual([297, 420]);
    expect(config.layers.walls.name).toBe("A-WALL");
  });

  it("names the key that is wrong", () => {
    const bad = { ...exportDefaults, layers: { ...exportDefaults.layers, doors: { name: "A DOOR", color: 4 } } };
    expect(() => parseExportConfig(bad)).toThrow('"layers.doors.name"');
    expect(() => parseExportConfig({ ...exportDefaults, defaultScale: 75 })).toThrow('"defaultScale"');
  });
});

describe("drawing of a storey", () => {
  it("merges the walls into one shape with a hole per room", () => {
    const storey = getActiveStorey(createSampleProject());
    const walls = wallRegion(storey);
    expect(walls).toHaveLength(1);
    expect(walls[0]).toHaveLength(1 + storey.spaces.length);
    // What is neither room nor outdoors is wall.
    const areas = computeStoreyAreas(storey, areaConfig);
    expect(regionArea(walls)).toBeCloseTo(areas.totals.gross - areas.totals.net, 6);
  });

  it("cuts a gap in the wall at every door and window", () => {
    const { storey } = plan();
    const solid = regionArea(wallRegion({ walls: storey.walls, openings: [] }));
    const cut = solid - regionArea(wallRegion(storey));
    expect(cut).toBeCloseTo(0.9 * 0.25 + 1.2 * 0.25, 6);
  });

  it("labels every room with its name, its net area and its apartment", () => {
    let { storey } = plan();
    storey = createApartment(storey, [storey.spaces[0].id]).storey;
    const texts = ofKind(storeyDrawing(storey, areaConfig, 0.25).entities, "text");
    expect(texts).toHaveLength(storey.spaces.length * 2 + 1);
    const areas = computeStoreyAreas(storey, areaConfig);
    for (const space of areas.spaces) {
      expect(texts.some((t) => t.text === space.name && t.bold)).toBe(true);
      expect(texts.some((t) => t.text === `${space.net.toFixed(2)} m²`)).toBe(true);
    }
    expect(texts.some((t) => t.text === storey.apartments[0].name)).toBe(true);
    expect(texts.every((t) => t.layer === "rooms" && t.height === 0.25)).toBe(true);
  });

  it("draws a door as a leaf and a quarter circle that ends on the far jamb", () => {
    const { storey } = plan();
    const drawing = storeyDrawing(storey, areaConfig, 0.25);
    const [arc] = ofKind(drawing.entities, "arc");
    expect(arc.layer).toBe("doors");
    expect(arc.radius).toBeCloseTo(0.9);
    expect(Math.abs(arc.sweep)).toBeCloseTo(Math.PI / 2);
    // The door is 0.9 wide, centred 2 m along the wall from (0,0) to (8,0).
    const end = arcPoints(arc).at(-1)!;
    expect(end.x).toBeCloseTo(2.45);
    expect(Math.abs(end.y)).toBeCloseTo(0.125);
    const leaf = ofKind(drawing.entities, "polyline").find((p) => p.layer === "doors")!;
    expect(leaf.points[0]).toEqual(arc.centre);
    expect(Math.abs(leaf.points[1].y - leaf.points[0].y)).toBeCloseTo(0.9);
  });

  it("draws a window as a frame across the wall and a glass line", () => {
    const { storey } = plan();
    const lines = ofKind(storeyDrawing(storey, areaConfig, 0.25).entities, "polyline").filter(
      (p) => p.layer === "windows",
    );
    expect(lines.map((l) => [l.points.length, l.closed])).toEqual([[4, true], [2, false]]);
    const xs = lines[0].points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.25); // the wall is 0.25 thick
  });

  it("moves as a whole", () => {
    const drawing = storeyDrawing(plan().storey, areaConfig, 0.25);
    const moved = translateDrawing(drawing, 10, -2);
    expect(moved.bounds!.minX).toBeCloseTo(drawing.bounds!.minX + 10);
    expect(moved.bounds!.maxY).toBeCloseTo(drawing.bounds!.maxY - 2);
    expect(moved.entities).toHaveLength(drawing.entities.length);
  });
});

describe("drawing of the site", () => {
  it("shows the plot, the buildable area dashed, the footprint and each setback", () => {
    const project = setSetback(withSite(), 1, 0);
    const drawing = siteDrawing(project.site, analyse(project), 0.5);
    const lines = ofKind(drawing.entities, "polyline");
    expect(lines.filter((l) => l.layer === "plot")).toHaveLength(1);
    expect(lines.filter((l) => l.layer === "buildable" && l.dashed)).toHaveLength(1);
    expect(ofKind(drawing.entities, "region").map((r) => r.layer)).toEqual(["footprint"]);
    // Three edges have a setback; the one set to zero gets no label.
    expect(ofKind(drawing.entities, "text").map((t) => t.text)).toEqual(["3.00", "3.00", "3.00"]);
    expect(drawing.bounds).toEqual({ minX: -6, minY: -5, maxX: 18, maxY: 12 });
  });
});

describe("sheets", () => {
  it("puts the site plan first and the storeys from the lowest up", () => {
    const project = withSite();
    const storeys = sortedStoreys(project.site.buildings[0]);
    const sheets = buildSheets(
      project,
      { storeyIds: storeys.map((s) => s.id).reverse(), includeSite: true, scale: 50, siteScale: 500 },
      areaConfig,
      analyse(project),
      config,
    );
    expect(sheets.map((s) => s.title)).toEqual(["Site plan", ...storeys.map((s) => s.name)]);
    expect(sheets.map((s) => s.scale)).toEqual([500, 50, 50]);
    expect(sheets[0].notes[0]).toBe("Plot 408.00 m²");
    // Lettering is 2.5 mm high on paper whatever the scale.
    const height = (i: number) => ofKind(sheets[i].drawing.entities, "text")[0].height;
    expect(height(0)).toBeCloseTo(1.25);
    expect(height(1)).toBeCloseTo(0.125);
  });

  it("leaves the site plan out when no plot is drawn, and storeys that were not chosen", () => {
    const { project, storey } = plan();
    const two = copyStorey(project, storey.id).project;
    const sheets = buildSheets(
      two,
      { storeyIds: [storey.id], includeSite: true, scale: 100, siteScale: 200 },
      areaConfig,
      analyse(two),
      config,
    );
    expect(sheets.map((s) => s.kind)).toEqual(["storey"]);
  });

  it("places a drawing at true scale, centred above the title block", () => {
    const bounds = { minX: 0, minY: 0, maxX: 8, maxY: 6 };
    const layout = layoutSheet(bounds, config.paper.A4, 50, config);
    expect(layout).toMatchObject({ orientation: "landscape", page: [297, 210], fits: true });
    // 8 m at 1:50 is 160 mm.
    const x = (m: number) => layout.offset.x + (m * 1000) / 50;
    expect(x(8) - x(0)).toBeCloseTo(160);
    expect(x(0) - layout.frame.x).toBeCloseTo(layout.frame.x + layout.frame.w - x(8));
    expect(layout.titleBlock.y + layout.titleBlock.h).toBeCloseTo(210 - config.marginMm);
  });

  it("turns the sheet upright for a tall drawing and says when nothing fits", () => {
    const tall = { minX: 0, minY: 0, maxX: 8, maxY: 12 };
    expect(layoutSheet(tall, config.paper.A4, 50, config)).toMatchObject({ orientation: "portrait", fits: true });
    expect(layoutSheet(tall, config.paper.A4, 20, config).fits).toBe(false);
    const sheets = sheetsOf(withSite(), 50);
    expect(sheetsThatDoNotFit(sheets, config.paper.A3, config)).toEqual([]);
    const at20 = sheets.map((s) => ({ ...s, scale: 20 }));
    expect(sheetsThatDoNotFit(at20, config.paper.A4, config)).toHaveLength(3);
  });
});

describe("DXF", () => {
  it("is a complete file with a layer for every kind of line", () => {
    const sited = withSite();
    const project = setColumns(sited, sited.site.buildings[0].id, [{ at: { x: 1, y: 1 }, w: 0.3, d: 0.3 }]);
    const dxf = writeDxf(
      buildSheets(
        project,
        { storeyIds: allStoreyIds(project), includeSite: true, scale: 100, siteScale: 200 },
        areaConfig,
        analyse(project),
        config,
        parseDimensionStyle(dimensionStyleJson),
        parseAnnotationStyle(annotationStyleJson),
      ),
      config,
    );
    expect(dxf.startsWith("0\r\nSECTION\r\n2\r\nHEADER")).toBe(true);
    expect(dxf.endsWith("0\r\nEOF\r\n")).toBe(true);
    expect(dxf.split("\r\n").length % 2).toBe(1); // code/value pairs and a final line break
    for (const layer of Object.values(config.layers)) expect(dxf).toContain(`LAYER\r\n2\r\n${layer.name}\r\n`);
    const used = new Set(dxfEntities(dxf).map((e) => group(e, 8)));
    expect(used).toEqual(new Set(Object.values(config.layers).map((l) => l.name)));
  });

  it("keeps a single drawing at its true coordinates, with y pointing up", () => {
    const { project } = plan();
    const entities = dxfEntities(writeDxf(sheetsOf(project), config));
    const vertices = entities.filter((e) => e[0][1] === "VERTEX" && group(e, 8) === "A-WALL");
    const xs = vertices.map((v) => Number(group(v, 10)));
    const ys = vertices.map((v) => Number(group(v, 20)));
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-0.125, 8.125]);
    // The plan runs from y = -0.125 to 6.125 downward in the model, so upward it is negative.
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([-6.125, 0.125]);
  });

  it("writes a door swing as a quarter-circle arc", () => {
    const [arc] = dxfEntities(writeDxf(sheetsOf(plan().project), config)).filter((e) => e[0][1] === "ARC");
    expect(Number(group(arc, 40))).toBeCloseTo(0.9);
    const span = (Number(group(arc, 51)) - Number(group(arc, 50)) + 360) % 360;
    expect(span).toBeCloseTo(90);
  });

  it("escapes Cyrillic so the file is plain ASCII", () => {
    expect(dxfText("Бања 6.57 m²")).toBe("\\U+0411\\U+0430\\U+045A\\U+0430 6.57 m\\U+00B2");
    let { project, storey } = plan();
    storey = { ...storey, spaces: storey.spaces.map((s, i) => (i === 0 ? { ...s, name: "Дневна соба" } : s)) };
    project = replaceStorey(project, storey);
    const dxf = writeDxf(sheetsOf(project), config);
    expect(/^[\x00-\x7f]*$/.test(dxf)).toBe(true);
    expect(dxf).toContain(dxfText("Дневна соба"));
  });

  it("lays several drawings side by side without overlap, each with its title", () => {
    const sheets = sheetsOf(withSite());
    const placed = arrangeForDxf(sheets, config);
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i].bounds!.minX - placed[i - 1].bounds!.maxX).toBeCloseTo(config.dxfGap);
    }
    const titles = placed.map((d) => ofKind(d.entities, "text").at(-1)!);
    expect(titles.map((t) => t.text)).toEqual(sheets.map((s) => `${s.title} 1:${s.scale}`));
    expect(titles.every((t) => t.layer === "titles")).toBe(true);
  });
});

describe("area schedule", () => {
  const sheet = (project: Project, name: string) =>
    buildSchedule(project, areaConfig, analyse(project), INFO).sheets.find((s) => s.name === name)!;
  const numbers = (cells: Cell[]) => cells.map(cellValue).filter((v): v is number => typeof v === "number");

  it("lists every room and totals them with formulas that match the app", () => {
    const project = withSite();
    const rooms = sheet(project, "Rooms");
    const count = project.site.buildings[0].storeys.reduce((n, s) => n + s.spaces.length, 0);
    expect(rooms.rows).toHaveLength(count + 1);
    const total = rooms.rows.at(-1)!;
    expect(total.style).toBe("total");
    expect(total.cells[4]).toMatchObject({ formula: `SUM(E2:E${count + 1})` });
    const building = computeBuildingAreas(project.site.buildings[0], areaConfig);
    expect(cellValue(total.cells[4])).toBeCloseTo(building.totals.net, 9);
    expect(cellValue(total.cells[5])).toBeCloseTo(building.totals.useful, 9);
  });

  it("splits each storey into its apartments and the common areas", () => {
    let { project, storey } = plan();
    storey = createApartment(storey, storey.spaces.slice(0, 2).map((s) => s.id)).storey;
    project = replaceStorey(project, storey);
    const apartments = sheet(project, "Apartments");
    expect(apartments.rows.map((r) => r.cells[1])).toEqual([storey.apartments[0].name, "Common areas", null]);
    expect(apartments.rows.map((r) => cellValue(r.cells[2]))).toEqual([2, 1, 3]);
    const rooms = sheet(project, "Rooms");
    expect(rooms.rows.slice(0, 3).map((r) => r.cells[1])).toEqual([storey.apartments[0].name, storey.apartments[0].name, ""]);
  });

  it("gives the gross area of each storey as a whole, to the outside wall faces", () => {
    const project = withSite();
    const storeys = sheet(project, "Storeys");
    expect(storeys.rows).toHaveLength(3);
    expect(numbers(storeys.rows[0].cells).at(-1)).toBeCloseTo(8.25 * 6.25, 6);
    expect(storeys.rows[1].cells[1]).toBe(3); // floor level of the upper storey
    expect(cellValue(storeys.rows[2].cells[5])).toBeCloseTo(2 * 8.25 * 6.25, 6);
  });

  it("works out coverage and floor area ratio from the rows above them", () => {
    const project = withSite();
    const site = sheet(project, "Site");
    const row = (label: string) => site.rows.find((r) => r.cells[0] === label)!.cells[1];
    expect(row("Plot area (m²)")).toBe(408);
    expect(row("Site coverage")).toMatchObject({ formula: "B4/B2", kind: "percent" });
    expect(cellValue(row("Site coverage"))).toBeCloseTo((8.25 * 6.25) / 408, 9);
    expect(cellValue(row("Floor area ratio"))).toBeCloseTo((2 * 8.25 * 6.25) / 408, 9);
    expect(row("Maximum site coverage")).toBe("no limit");
    expect(row("Warnings")).toBe("none");
    // Rows 4 and 2 are what the formula says they are.
    expect(site.rows[2].cells[0]).toBe("Building footprint (m²)");
    expect(site.rows[0].cells[0]).toBe("Plot area (m²)");
  });

  it("still exports without a plot", () => {
    const { project } = plan();
    const site = sheet(project, "Site");
    expect(site.rows[0].cells).toEqual(["Plot", "No plot is drawn."]);
    expect(sheet(project, "Notes").rows.some((r) => r.cells[1] === "To be verified.")).toBe(true);
  });
});

describe("files", () => {
  it("writes an XLSX workbook that reads back with its formulas and Cyrillic names", async () => {
    let project = withSite();
    const storey = getActiveStorey(project);
    project = replaceStorey(project, {
      ...storey,
      spaces: storey.spaces.map((s, i) => (i === 0 ? { ...s, name: "Дневна соба" } : s)),
    });
    const schedule = buildSchedule(project, areaConfig, analyse(project), INFO);
    const bytes = await writeXlsx(schedule);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer as ArrayBuffer);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(["Rooms", "Apartments", "Storeys", "Doors and windows", "Site", "Notes"]);
    const rooms = workbook.getWorksheet("Rooms")!;
    expect(rooms.getColumn(3).values).toContain("Дневна соба");
    const total = rooms.getRow(rooms.rowCount).getCell(5);
    expect(total.formula).toBe(`SUM(E2:E${rooms.rowCount - 1})`);
    expect(total.result).toBeCloseTo(computeBuildingAreas(project.site.buildings[0], areaConfig).totals.net, 9);
    expect(total.numFmt).toBe("#,##0.00");
  });

  it("writes a PDF with one page per sheet on the chosen paper", async () => {
    const font = (weight: string) =>
      new Uint8Array(
        readFileSync(join(process.cwd(), `node_modules/@expo-google-fonts/noto-sans/${weight}/NotoSans_${weight}.ttf`)),
      );
    const sheets = sheetsOf(withSite());
    const bytes = await writePdf(
      sheets,
      config,
      { project: "Станбена зграда", date: INFO.date, paper: config.paper.A3 },
      { regular: font("400Regular"), bold: font("700Bold") },
    );
    const pdf = Buffer.from(bytes).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    const boxes = [...pdf.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
    expect(boxes).toHaveLength(sheets.length);
    for (const box of boxes) {
      // A3 landscape, in points (1/72 inch).
      expect(box[2]).toBeCloseTo((420 / 25.4) * 72, 1);
      expect(box[3]).toBeCloseTo((297 / 25.4) * 72, 1);
    }
  }, 20000);

  it("picks a round scale bar and keeps Cyrillic in file names", () => {
    expect(scaleBarLength(100, 40)).toBe(2);
    expect(scaleBarLength(500, 40)).toBe(20);
    expect(fileBase("Станбена зграда А2 / Куманово")).toBe("Станбена_зграда_А2_Куманово");
    expect(fileBase("  ")).toBe("project");
  });
});
