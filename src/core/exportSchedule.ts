/**
 * The area schedule as plain rows and columns, ready to be written to a
 * spreadsheet. Pure functions, no UI imports and no spreadsheet library.
 *
 * Areas are exported unrounded and shown with the configured number of
 * decimals, so a total in the spreadsheet is the sum of the true values, the
 * same as in the app. Totals are real formulas over the rows above them.
 */
import { type AreaConfig, computeApartmentAreas, computeStoreyAreas } from "./areas.ts";
import { sortedStoreys } from "./building.ts";
import type { Project } from "./model.ts";
import type { SiteAnalysis } from "./site.ts";

export type CellKind = "text" | "area" | "length" | "count" | "ratio" | "percent";

/** A cell that is a formula, or whose number format differs from its column's. */
export interface RichCell {
  value: number;
  /** Spreadsheet formula without the leading "=". `value` is what it works out to. */
  formula?: string;
  kind?: CellKind;
}

export type Cell = string | number | null | RichCell;

export interface ScheduleRow {
  cells: Cell[];
  style?: "total";
}

export interface ScheduleSheet {
  name: string;
  columns: { header: string; kind: CellKind; width: number }[];
  rows: ScheduleRow[];
}

export interface Schedule {
  /** Decimals areas are shown with. */
  decimals: number;
  sheets: ScheduleSheet[];
}

export interface ScheduleInfo {
  /** Date written on the Notes sheet, already formatted. */
  date: string;
  /** Extra lines for the Notes sheet, e.g. the "to be verified" status of the configs. */
  notes: string[];
  /** Which storeys make up the footprint, in words. */
  footprintRule: string;
}

const COLUMN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The value a cell shows, whatever kind of cell it is. */
export const cellValue = (cell: Cell): string | number | null =>
  cell !== null && typeof cell === "object" ? cell.value : cell;

/**
 * A total row: `label` in the first column and, in each of the `sumColumns`,
 * the sum of that column over the data rows (which start in spreadsheet row 2,
 * under the header).
 */
function totalRow(label: string, width: number, sumColumns: number[], rows: ScheduleRow[]): ScheduleRow {
  const cells: Cell[] = Array.from({ length: width }, () => null);
  cells[0] = label;
  for (const c of sumColumns) {
    let value = 0;
    for (const r of rows) {
      const v = cellValue(r.cells[c]);
      if (typeof v === "number") value += v;
    }
    const letter = COLUMN_LETTERS[c];
    cells[c] = rows.length ? { value, formula: `SUM(${letter}2:${letter}${rows.length + 1})` } : value;
  }
  return { cells, style: "total" };
}

const BOUNDARY_WORDS = {
  wallInnerFace: "the inside face of the surrounding walls",
  wallCentreline: "the centreline of the surrounding walls",
  wallOuterFace: "the outside face of the outermost walls",
} as const;

export function buildSchedule(
  project: Project,
  areaConfig: AreaConfig,
  analysis: SiteAnalysis,
  info: ScheduleInfo,
): Schedule {
  const buildings = project.site.buildings;
  const storeyLabel = (buildingName: string, storeyName: string) =>
    buildings.length > 1 ? `${buildingName} · ${storeyName}` : storeyName;

  const rooms: ScheduleRow[] = [];
  const apartments: ScheduleRow[] = [];
  const storeys: ScheduleRow[] = [];
  for (const building of buildings) {
    for (const storey of sortedStoreys(building)) {
      const label = storeyLabel(building.name, storey.name);
      const areas = computeStoreyAreas(storey, areaConfig);
      const split = computeApartmentAreas(storey, areaConfig, areas);
      const groups = [
        ...split.apartments.map((a) => ({ name: a.name, group: a, common: false })),
        { name: "Common areas", group: split.common, common: true },
      ];
      for (const { name, group, common } of groups) {
        for (const r of group.spaces) {
          rooms.push({ cells: [label, common ? "" : name, r.name, r.type, r.net, r.useful, r.gross] });
        }
        if (common && group.spaces.length === 0) continue;
        apartments.push({
          cells: [label, name, group.spaces.length, group.totals.net, group.totals.useful, group.totals.gross],
        });
      }
      storeys.push({
        cells: [label, storey.elevation, storey.height, areas.totals.net, areas.totals.useful, areas.totals.gross],
      });
    }
  }

  const roomsSheet: ScheduleSheet = {
    name: "Rooms",
    columns: [
      { header: "Storey", kind: "text", width: 18 },
      { header: "Apartment", kind: "text", width: 18 },
      { header: "Room", kind: "text", width: 22 },
      { header: "Type", kind: "text", width: 12 },
      { header: "Net area (m²)", kind: "area", width: 15 },
      { header: "Useful area (m²)", kind: "area", width: 16 },
      { header: "Gross area (m²)", kind: "area", width: 15 },
    ],
    rows: [...rooms, totalRow("Total", 7, [4, 5, 6], rooms)],
  };

  const apartmentsSheet: ScheduleSheet = {
    name: "Apartments",
    columns: [
      { header: "Storey", kind: "text", width: 18 },
      { header: "Apartment", kind: "text", width: 20 },
      { header: "Rooms", kind: "count", width: 9 },
      { header: "Net area (m²)", kind: "area", width: 15 },
      { header: "Useful area (m²)", kind: "area", width: 16 },
      { header: "Gross area (m²)", kind: "area", width: 15 },
    ],
    rows: [...apartments, totalRow("Total", 6, [2, 3, 4, 5], apartments)],
  };

  const storeysSheet: ScheduleSheet = {
    name: "Storeys",
    columns: [
      { header: "Storey", kind: "text", width: 18 },
      { header: "Floor level (m)", kind: "length", width: 15 },
      { header: "Height (m)", kind: "length", width: 12 },
      { header: "Net area (m²)", kind: "area", width: 15 },
      { header: "Useful area (m²)", kind: "area", width: 16 },
      { header: "Gross area (m²)", kind: "area", width: 15 },
    ],
    rows: [...storeys, totalRow("Building", 6, [3, 4, 5], storeys)],
  };

  // Site: one figure per row. The two ratios are formulas on the rows above.
  const site: ScheduleRow[] = [];
  const limits = project.site.limits;
  if (analysis.hasPlot) {
    site.push({ cells: ["Plot area (m²)", analysis.plotArea] }); // row 2
    site.push({ cells: ["Buildable area (m²)", analysis.buildableArea] }); // row 3
    site.push({ cells: ["Building footprint (m²)", analysis.footprintArea] }); // row 4
    site.push({ cells: ["Gross floor area (m²)", analysis.grossFloorArea] }); // row 5
    site.push({
      cells: ["Site coverage", { value: analysis.coverage ?? 0, formula: "B4/B2", kind: "percent" }],
    });
    site.push({
      cells: [
        "Maximum site coverage",
        limits.maxCoverage === null ? "no limit" : { value: limits.maxCoverage, kind: "percent" },
      ],
    });
    site.push({
      cells: ["Floor area ratio", { value: analysis.floorAreaRatio ?? 0, formula: "B5/B2", kind: "ratio" }],
    });
    site.push({
      cells: [
        "Maximum floor area ratio",
        limits.maxFloorAreaRatio === null ? "no limit" : { value: limits.maxFloorAreaRatio, kind: "ratio" },
      ],
    });
    site.push({ cells: [null, null] });
    if (analysis.issues.length === 0) {
      site.push({ cells: ["Warnings", "none"] });
    } else {
      analysis.issues.forEach((issue, i) => site.push({ cells: [i === 0 ? "Warnings" : null, issue.message] }));
    }
  } else {
    site.push({ cells: ["Plot", "No plot is drawn."] });
    site.push({ cells: ["Building footprint (m²)", analysis.footprintArea] });
    site.push({ cells: ["Gross floor area (m²)", analysis.grossFloorArea] });
  }
  const siteSheet: ScheduleSheet = {
    name: "Site",
    columns: [
      { header: "Figure", kind: "text", width: 28 },
      { header: "Value", kind: "area", width: 60 },
    ],
    rows: site,
  };

  const factors = Object.entries(areaConfig.useful.factorBySpaceType).filter(([, f]) => f !== 1);
  const notes: ScheduleRow[] = [
    { cells: ["Project", project.name] },
    { cells: ["Exported", info.date] },
    { cells: ["Units", "metres and square metres"] },
    { cells: [null, null] },
    { cells: ["Net area", `Floor area of a room, measured to ${BOUNDARY_WORDS[areaConfig.net.boundary]}.`] },
    {
      cells: [
        "Useful area",
        factors.length === 0 && areaConfig.useful.defaultFactor === 1
          ? "Net area × a factor per room type. Every factor is 1, so useful area equals net area."
          : `Net area × a factor per room type: ${factors.map(([t, f]) => `${t} ${f}`).join(", ") || "none set"}; every other type ${areaConfig.useful.defaultFactor}.`,
      ],
    },
    {
      cells: [
        "Gross area of a room",
        `Measured to ${BOUNDARY_WORDS[areaConfig.gross.space]}. This is the gross area on the Rooms and Apartments sheets.`,
      ],
    },
    {
      cells: [
        "Gross area of a storey",
        `The whole storey, measured to ${BOUNDARY_WORDS[areaConfig.gross.storey]}. This is the gross area on the Storeys and Site sheets, so it is larger than the sum of the rooms.`,
      ],
    },
    { cells: ["Building footprint", `Outside wall faces, ${info.footprintRule}.`] },
    { cells: ["Site coverage", "Building footprint ÷ plot area."] },
    { cells: ["Floor area ratio", "Gross floor area of all storeys ÷ plot area."] },
    { cells: [null, null] },
    ...info.notes.map((note, i): ScheduleRow => ({ cells: [i === 0 ? "Important" : null, note] })),
  ];
  const notesSheet: ScheduleSheet = {
    name: "Notes",
    columns: [
      { header: "Item", kind: "text", width: 24 },
      { header: "Note", kind: "text", width: 110 },
    ],
    rows: notes,
  };

  return {
    decimals: areaConfig.decimals,
    sheets: [roomsSheet, apartmentsSheet, storeysSheet, siteSheet, notesSheet],
  };
}
