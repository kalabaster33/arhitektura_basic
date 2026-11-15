/**
 * Which drawings an export contains and how each sits on its sheet of paper.
 * Pure functions, no UI imports. Sizes and layer names come from a config
 * (src/config/exportDefaults.json).
 */
import { type AnnotationStyle, storeyAnnotations } from "./annotations.ts";
import { type AreaConfig, formatArea } from "./areas.ts";
import { sortedStoreys } from "./building.ts";
import { type DimensionStyle, storeyDimensions } from "./dimensions.ts";
import {
  type Bounds,
  type Drawing,
  type LayerKey,
  LAYER_KEYS,
  addEntities,
  siteDrawing,
  storeyDrawing,
} from "./drawing.ts";
import type { Project } from "./model.ts";
import type { SiteAnalysis } from "./site.ts";

export interface ExportConfig {
  /** Sheet sizes in millimetres, short side first. */
  paper: Record<string, [number, number]>;
  defaultPaper: string;
  scales: number[];
  defaultScale: number;
  siteScales: number[];
  defaultSiteScale: number;
  marginMm: number;
  titleBlockMm: number;
  textHeightMm: number;
  lineWeightMm: Record<LayerKey, number>;
  layers: Record<LayerKey, { name: string; color: number }>;
  /** Metres between drawings laid side by side in one DXF file. */
  dxfGap: number;
}

/** Checks a config loaded from JSON; throws with the offending key. */
export function parseExportConfig(raw: unknown): ExportConfig {
  const c = raw as ExportConfig;
  const fail = (key: string): never => {
    throw new Error(`Export defaults: invalid or missing "${key}".`);
  };
  const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!c || typeof c !== "object") fail("(root)");
  if (!c.paper || typeof c.paper !== "object" || Object.keys(c.paper).length === 0) fail("paper");
  for (const [name, size] of Object.entries(c.paper)) {
    if (!Array.isArray(size) || size.length !== 2 || !size.every(positive)) fail(`paper.${name}`);
  }
  if (!(c.defaultPaper in c.paper)) fail("defaultPaper");
  for (const key of ["scales", "siteScales"] as const) {
    if (!Array.isArray(c[key]) || c[key].length === 0 || !c[key].every(positive)) fail(key);
  }
  if (!c.scales.includes(c.defaultScale)) fail("defaultScale");
  if (!c.siteScales.includes(c.defaultSiteScale)) fail("defaultSiteScale");
  for (const key of ["marginMm", "titleBlockMm", "textHeightMm", "dxfGap"] as const) {
    if (!positive(c[key])) fail(key);
  }
  const lineWeightMm = {} as ExportConfig["lineWeightMm"];
  const layers = {} as ExportConfig["layers"];
  for (const key of LAYER_KEYS) {
    if (!positive(c.lineWeightMm?.[key])) fail(`lineWeightMm.${key}`);
    lineWeightMm[key] = c.lineWeightMm[key];
    const layer = c.layers?.[key];
    // DXF layer names may not contain these characters.
    if (!layer || typeof layer.name !== "string" || !/^[^<>/\\":;?*|=`\s]+$/.test(layer.name)) {
      fail(`layers.${key}.name`);
    }
    if (!Number.isInteger(layer.color) || layer.color < 1 || layer.color > 255) fail(`layers.${key}.color`);
    layers[key] = { name: layer.name, color: layer.color };
  }
  return {
    paper: Object.fromEntries(Object.entries(c.paper).map(([k, v]) => [k, [v[0], v[1]]])),
    defaultPaper: c.defaultPaper,
    scales: c.scales.slice(),
    defaultScale: c.defaultScale,
    siteScales: c.siteScales.slice(),
    defaultSiteScale: c.defaultSiteScale,
    marginMm: c.marginMm,
    titleBlockMm: c.titleBlockMm,
    textHeightMm: c.textHeightMm,
    lineWeightMm,
    layers,
    dxfGap: c.dxfGap,
  };
}

// --------------------------------------------------------------------- sheets

export interface SheetSelection {
  /** Storeys to export; the sheets come out lowest storey first whatever the order here. */
  storeyIds: string[];
  /** The site plan is left out anyway when no plot is drawn. */
  includeSite: boolean;
  /** 100 = 1:100. */
  scale: number;
  siteScale: number;
}

export interface Sheet {
  kind: "site" | "storey";
  title: string;
  scale: number;
  drawing: Drawing;
  /** Short lines printed in the title block. */
  notes: string[];
  /** The north arrow to draw: its direction in degrees clockwise from the top, and its length on paper. */
  north?: { degrees: number; sizeMm: number };
}

/**
 * The drawings of an export: the site plan first (when asked for and a plot is
 * drawn), then one sheet per chosen storey from the lowest up. Lettering is
 * sized to be `textHeightMm` high on paper at each sheet's scale. With a
 * dimension style the storey plans carry their dimensions: the hand-placed
 * ones, and the automatic ones the project has switched on.
 */
export function buildSheets(
  project: Project,
  selection: SheetSelection,
  areaConfig: AreaConfig,
  analysis: SiteAnalysis,
  config: ExportConfig,
  dimensionStyle?: DimensionStyle,
  annotationStyle?: AnnotationStyle,
): Sheet[] {
  const sheets: Sheet[] = [];
  const north = annotationStyle
    ? { degrees: project.site.north, sizeMm: annotationStyle.northArrowMm }
    : undefined;
  const textHeight = (scale: number) => (config.textHeightMm * scale) / 1000;
  const site = project.site;
  if (selection.includeSite && analysis.hasPlot) {
    const f = (v: number) => `${formatArea(v, areaConfig)} m²`;
    const notes = [`Plot ${f(analysis.plotArea)}`, `Footprint ${f(analysis.footprintArea)}`];
    if (analysis.coverage !== null) notes.push(`Coverage ${(analysis.coverage * 100).toFixed(1)} %`);
    if (analysis.floorAreaRatio !== null) notes.push(`Floor area ratio ${analysis.floorAreaRatio.toFixed(2)}`);
    sheets.push({
      kind: "site",
      title: "Site plan",
      scale: selection.siteScale,
      drawing: siteDrawing(site, analysis, textHeight(selection.siteScale)),
      notes,
      north,
    });
  }
  const many = site.buildings.length > 1;
  for (const building of site.buildings) {
    for (const storey of sortedStoreys(building)) {
      if (!selection.storeyIds.includes(storey.id)) continue;
      sheets.push({
        kind: "storey",
        title: many ? `${building.name} · ${storey.name}` : storey.name,
        scale: selection.scale,
        drawing: addEntities(
          storeyDrawing(storey, areaConfig, textHeight(selection.scale)),
          [
            ...(dimensionStyle
              ? storeyDimensions(storey, project.annotations, dimensionStyle, selection.scale)
              : []),
            ...(annotationStyle
              ? storeyAnnotations(storey, project.annotations, annotationStyle, selection.scale)
              : []),
          ],
        ),
        notes: [`Floor level ${storey.elevation >= 0 ? "+" : ""}${storey.elevation.toFixed(2)} m`],
        north,
      });
    }
  }
  return sheets;
}

// --------------------------------------------------------------------- layout

export interface SheetLayout {
  orientation: "portrait" | "landscape";
  /** Page width and height in millimetres. */
  page: [number, number];
  /** False when the drawing is larger than the space the sheet has for it. */
  fits: boolean;
  /** The part of the page the drawing may use, in millimetres from the top left. */
  frame: { x: number; y: number; w: number; h: number };
  /** The title strip under the frame. */
  titleBlock: { x: number; y: number; w: number; h: number };
  /** Paper position of a model point: mm = offset + metres * 1000 / scale. */
  offset: { x: number; y: number };
}

/**
 * Places a drawing on a sheet at a true scale, centred in the space above the
 * title block. Landscape is used unless only portrait is large enough. Nothing
 * is ever shrunk to fit: a drawing that is too large is reported as not fitting.
 */
export function layoutSheet(
  bounds: Bounds | null,
  paper: [number, number],
  scale: number,
  config: Pick<ExportConfig, "marginMm" | "titleBlockMm">,
): SheetLayout {
  const k = 1000 / scale;
  const w = bounds ? (bounds.maxX - bounds.minX) * k : 0;
  const h = bounds ? (bounds.maxY - bounds.minY) * k : 0;
  const short = Math.min(paper[0], paper[1]);
  const long = Math.max(paper[0], paper[1]);
  const lay = (orientation: "portrait" | "landscape"): SheetLayout => {
    const page: [number, number] = orientation === "landscape" ? [long, short] : [short, long];
    const m = config.marginMm;
    const frame = { x: m, y: m, w: page[0] - 2 * m, h: page[1] - 2 * m - config.titleBlockMm };
    const titleBlock = { x: m, y: m + frame.h, w: frame.w, h: config.titleBlockMm };
    // A hair of play so a drawing exactly as large as the frame still fits.
    const fits = w <= frame.w + 1e-6 && h <= frame.h + 1e-6;
    const offset = {
      x: frame.x + (frame.w - w) / 2 - (bounds ? bounds.minX * k : 0),
      y: frame.y + (frame.h - h) / 2 - (bounds ? bounds.minY * k : 0),
    };
    return { orientation, page, fits, frame, titleBlock, offset };
  };
  const landscape = lay("landscape");
  if (landscape.fits) return landscape;
  const portrait = lay("portrait");
  return portrait.fits ? portrait : landscape;
}

/** The sheets that are too large for the paper at their scale. */
export function sheetsThatDoNotFit(
  sheets: Sheet[],
  paper: [number, number],
  config: Pick<ExportConfig, "marginMm" | "titleBlockMm">,
): Sheet[] {
  return sheets.filter((s) => !layoutSheet(s.drawing.bounds, paper, s.scale, config).fits);
}
