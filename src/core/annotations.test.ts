import { describe, expect, it } from "vitest";
import annotationStyleJson from "../config/annotationStyle.json";
import areaDefinitions from "../config/areaDefinitions.json";
import exportDefaults from "../config/exportDefaults.json";
import siteRulesJson from "../config/siteRules.json";
import {
  formatLevel,
  levelMark,
  normaliseNorth,
  northArrow,
  openingTag,
  openingTags,
  parseAnnotationStyle,
  storeyAnnotations,
} from "./annotations.ts";
import { parseAreaConfig } from "./areas.ts";
import { copyStorey } from "./building.ts";
import type { Entity } from "./drawing.ts";
import { arrangeForDxf, writeDxf } from "./exportDxf.ts";
import { buildSchedule, cellValue } from "./exportSchedule.ts";
import { type Project, type Storey, SCHEMA_VERSION } from "./model.ts";
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
import { analyseSite, parseSiteRules, setNorth } from "./site.ts";

const style = parseAnnotationStyle(annotationStyleJson);
const areaConfig = parseAreaConfig(areaDefinitions);
const exportConfig = parseExportConfig(exportDefaults);
const siteRules = parseSiteRules(siteRulesJson);
const DOOR = { width: 0.9, height: 2.1, sill: 0 };
const WINDOW = { width: 1.2, height: 1.4, sill: 0.9 };

type Text = Extract<Entity, { kind: "text" }>;
const texts = (entities: Entity[]) => entities.filter((e): e is Text => e.kind === "text");

/**
 * The sample plan (8 x 6 m shell, walls 0.25 thick, large room on the left)
 * with a door in the top wall (y = 0), a window in the right wall (x = 8) and
 * a door in the partition at x = 5.
 */
function plan(): { project: Project; storey: Storey } {
  let project = createSampleProject();
  let storey = getActiveStorey(project);
  storey = addOpening(storey, storey.walls[0].id, "door", 2, DOOR);
  storey = addOpening(storey, storey.walls[1].id, "window", 1.5, WINDOW);
  storey = addOpening(storey, storey.walls[4].id, "door", 1.5, { ...DOOR, width: 0.8 });
  project = replaceStorey(project, storey);
  return { project, storey };
}

describe("annotation style", () => {
  it("accepts the shipped style and names the key that is wrong", () => {
    expect(style).toMatchObject({ tagUnit: "cm", sillPrefix: "p=" });
    expect(() => parseAnnotationStyle({ ...annotationStyleJson, tagUnit: "ft" })).toThrow('"tagUnit"');
    expect(() => parseAnnotationStyle({ ...annotationStyleJson, northArrowMm: -1 })).toThrow('"northArrowMm"');
  });
});

describe("door and window tags", () => {
  it("read width/height, and for a window its sill height too", () => {
    expect(openingTag({ kind: "door", ...DOOR }, style)).toBe("90/210");
    expect(openingTag({ kind: "window", ...WINDOW }, style)).toBe("120/140 p=90");
    expect(openingTag({ kind: "door", ...DOOR, width: 0.825 }, style)).toBe("82.5/210");
    expect(openingTag({ kind: "window", ...WINDOW }, { ...style, tagUnit: "m", tagDecimals: 2, sillPrefix: "sill " })).toBe(
      "1.20/1.40 sill 0.90",
    );
  });

  it("stand at every opening, on the tags layer", () => {
    const tags = texts(openingTags(plan().storey, style, 100));
    expect(tags.map((t) => t.text)).toEqual(["90/210", "120/140 p=90", "80/210"]);
    expect(tags.every((t) => t.layer === "tags" && Math.abs(t.height - 0.18) < 1e-9)).toBe(true);
  });

  it("put a door's tag on the side away from its swing, just off the wall face", () => {
    // The top wall runs from (0,0) to (8,0); its normal, and so the swing, point down into the room.
    const [door] = texts(openingTags(plan().storey, style, 100));
    expect(door.at.x).toBeCloseTo(2);
    // Half the wall (0.125), a 0.8 mm gap and half the 1.8 mm lettering, at 1:100.
    expect(door.at.y).toBeCloseTo(-(0.125 + 0.08 + 0.09));
    expect(door.angle).toBeCloseTo(0);
  });

  it("put a window's tag on the room side, turned to read along an upright wall", () => {
    const [, window] = texts(openingTags(plan().storey, style, 100));
    expect(window.at.x).toBeLessThan(8 - 0.125); // inside, clear of the dimension chains outside
    expect(window.at.y).toBeCloseTo(1.5);
    expect(window.angle).toBeCloseTo(-Math.PI / 2);
  });

  it("keep their size on paper whatever the scale", () => {
    const at = (scale: number) => texts(openingTags(plan().storey, style, scale))[0];
    expect(at(50).height).toBeCloseTo(0.09);
    expect(at(200).height).toBeCloseTo(0.36);
  });
});

describe("floor level mark", () => {
  it("writes levels the way plans do", () => {
    expect(formatLevel(0)).toBe("±0.00");
    expect(formatLevel(3)).toBe("+3.00");
    expect(formatLevel(-1.5)).toBe("-1.50");
    expect(formatLevel(0.004)).toBe("±0.00");
  });

  it("is a triangle and the level, once, in the largest room", () => {
    const { project, storey } = plan();
    const upper = copyStorey(project, storey.id).project.site.buildings[0].storeys[1];
    const mark = levelMark(upper, style, 100);
    expect(mark.map((e) => e.kind)).toEqual(["polyline", "text"]);
    const [triangle, level] = mark as [Extract<Entity, { kind: "polyline" }>, Text];
    expect(level.text).toBe("+3.00");
    expect(triangle.closed).toBe(true);
    expect(triangle.points).toHaveLength(3);
    // In the large room on the left (x from 0.125 to 4.95), above its label.
    const anchor = upper.spaces.find((s) => s.anchor.x < 5)!.anchor;
    expect(level.at.x).toBeGreaterThan(0.125);
    expect(level.at.x).toBeLessThan(4.95);
    expect(level.at.y).toBeLessThan(anchor.y);
    expect(triangle.points[0].y).toBeCloseTo(anchor.y - 1); // its point is 10 mm above the label at 1:100
  });

  it("is left out when there is no room, or no space for it", () => {
    expect(levelMark(getActiveStorey(createProject()), style, 100)).toEqual([]);
    // At 1:1000 the mark would be 10 m above the label: outside the room.
    expect(levelMark(plan().storey, style, 1000)).toEqual([]);
  });

  it("and the tags are shown only when switched on", () => {
    const { storey } = plan();
    const count = (openingTagsOn: boolean, levelMarks: boolean) =>
      storeyAnnotations(storey, { openingTags: openingTagsOn, levelMarks }, style, 100).length;
    expect(count(true, true)).toBe(5);
    expect(count(true, false)).toBe(3);
    expect(count(false, true)).toBe(2);
    expect(count(false, false)).toBe(0);
  });
});

describe("north", () => {
  it("is kept between 0 and 360 degrees", () => {
    expect(normaliseNorth(-90)).toBe(270);
    expect(normaliseNorth(450)).toBe(90);
    expect(normaliseNorth(Number.NaN)).toBe(0);
    const project = createSampleProject();
    expect(setNorth(project, 370).site.north).toBe(10);
    expect(setNorth(project, 0)).toBe(project);
    expect(setNorth(project, Number.NaN)).toBe(project);
  });

  it("points the arrow up the plan at 0 and to the right at 90", () => {
    const tip = (north: number) => {
      const head = northArrow({ x: 10, y: 10 }, 2, north)[1] as Extract<Entity, { kind: "polyline" }>;
      return head.points[0];
    };
    expect(tip(0)).toEqual({ x: 10, y: 9 });
    expect(tip(90)).toEqual({ x: 11, y: 10 });
    expect(tip(180)).toEqual({ x: 10, y: 11 });
    const letter = texts(northArrow({ x: 10, y: 10 }, 2, 0))[0];
    expect(letter.text).toBe("N");
    expect(letter.at.y).toBeLessThan(9); // beyond the tip
  });
});

describe("annotations in files", () => {
  const sheetsOf = (project: Project, withStyle = true) =>
    buildSheets(
      project,
      { storeyIds: project.site.buildings[0].storeys.map((s) => s.id), includeSite: false, scale: 100, siteScale: 200 },
      areaConfig,
      analyseSite(project.site, siteRules, areaConfig),
      exportConfig,
      undefined,
      withStyle ? style : undefined,
    );

  it("are drawn on exported plans, each sheet with its north arrow", () => {
    const project = setNorth(plan().project, 30);
    const [sheet] = sheetsOf(project);
    expect(texts(sheet.drawing.entities).filter((t) => t.layer === "tags").map((t) => t.text)).toEqual([
      "90/210",
      "120/140 p=90",
      "80/210",
      "±0.00",
    ]);
    expect(sheet.north).toEqual({ degrees: 30, sizeMm: style.northArrowMm });
    const [plain] = sheetsOf(project, false);
    expect(plain.north).toBeUndefined();
    expect(plain.drawing.entities.some((e) => e.layer === "tags")).toBe(false);
  });

  it("go into a DXF: tags on their layer, the north arrow beside the drawing", () => {
    const sheets = sheetsOf(plan().project);
    const dxf = writeDxf(sheets, exportConfig);
    expect(dxf).toContain("TEXT\r\n8\r\nA-ANNO-SYMB\r\n");
    expect(dxf).toMatch(/\r\n1\r\n120\/140 p=90\r\n50\r\n90\r\n/); // on the upright wall: turned
    const [placed] = arrangeForDxf(sheets, exportConfig);
    const letter = texts(placed.entities).find((t) => t.text === "N")!;
    expect(letter.at.x).toBeGreaterThan(placed.bounds!.maxX);
  });

  it("list doors and windows by size with a count per storey", () => {
    const { project, storey } = plan();
    const two = copyStorey(project, storey.id).project;
    const upper = two.site.buildings[0].storeys[1];
    // The upper storey gets a second window of the same size.
    const more = replaceStorey(two, addOpening(upper, upper.walls[2].id, "window", 4, WINDOW));
    const schedule = buildSchedule(more, areaConfig, analyseSite(more.site, siteRules, areaConfig), {
      date: "",
      notes: [],
      footprintRule: "",
    });
    const sheet = schedule.sheets.find((s) => s.name === "Doors and windows")!;
    expect(sheet.columns.map((c) => c.header)).toEqual([
      "Type",
      "Width (m)",
      "Height (m)",
      "Sill (m)",
      "Ground floor",
      upper.name,
      "Total",
    ]);
    expect(sheet.rows.map((r) => r.cells.map(cellValue))).toEqual([
      ["Door", 0.8, 2.1, 0, 1, 1, 2],
      ["Door", 0.9, 2.1, 0, 1, 1, 2],
      ["Window", 1.2, 1.4, 0.9, 1, 2, 3],
      ["Total", null, null, null, 3, 4, 7],
    ]);
    expect(sheet.rows[2].cells[6]).toMatchObject({ formula: "SUM(E4:F4)" });
    expect(sheet.rows[3].cells[6]).toMatchObject({ formula: "SUM(G2:G4)" });
  });

  it("are saved, and added to a file from before there were any", () => {
    let project = setNorth(createSampleProject(), 45);
    project = { ...project, annotations: { ...project.annotations, levelMarks: false } };
    const loaded = parseProject(serializeProject(project));
    expect(loaded.site.north).toBe(45);
    expect(loaded.annotations).toMatchObject({ openingTags: true, levelMarks: false });

    const old: any = JSON.parse(serializeProject(createSampleProject()));
    old.schemaVersion = 3;
    delete old.site.north;
    delete old.annotations.openingTags;
    delete old.annotations.levelMarks;
    const upgraded = parseProject(JSON.stringify(old));
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(upgraded.site.north).toBe(0);
    expect(upgraded.annotations).toEqual({
      outsideDimensions: true,
      roomDimensions: true,
      openingTags: true,
      levelMarks: true,
    });
  });

  it("repair a north that cannot be read", () => {
    const data: any = JSON.parse(serializeProject(createSampleProject()));
    data.site.north = "up";
    expect(parseProject(JSON.stringify(data)).site.north).toBe(0);
    data.site.north = -90;
    expect(parseProject(JSON.stringify(data)).site.north).toBe(270);
  });
});
