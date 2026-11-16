import { useEffect, useMemo, useRef, useState } from "react";
import annotationStyleJson from "../config/annotationStyle.json";
import areaDefinitions from "../config/areaDefinitions.json";
import dimensionStyleJson from "../config/dimensionStyle.json";
import columnsJson from "../config/columns.json";
import coreAlignment from "../config/coreAlignment.json";
import editorDefaults from "../config/editorDefaults.json";
import exportDefaults from "../config/exportDefaults.json";
import layoutRules from "../config/layoutRules.json";
import mapSettingsJson from "../config/mapSettings.json";
import roomChecks from "../config/roomChecks.json";
import siteRulesJson from "../config/siteRules.json";
import storeySplitJson from "../config/storeySplit.json";
import windowRulesJson from "../config/windowRules.json";
import { parseWindowRules, placeWindows } from "../core/windows.ts";
import { parseAnnotationStyle, storeyAnnotations } from "../core/annotations.ts";
import { describeApartments } from "../core/apartments.ts";
import {
  apartmentInteriorWalls,
  buildLayoutInput,
  proposeLayouts,
  resolveLayoutRules,
  rulesDoc,
} from "../core/autoLayout.ts";
import { LayoutRulesPanel } from "./LayoutRulesPanel.tsx";
import {
  computeApartmentAreas,
  computeBuildingAreas,
  computeStoreyAreas,
  formatArea,
  parseAreaConfig,
} from "../core/areas.ts";
import {
  addStorey,
  checkElevations,
  copyStorey,
  deleteStorey,
  findBuilding,
  restackStoreys,
  sortedStoreys,
  updateStoreyInfo,
} from "../core/building.ts";
import { parseColumnConfig } from "../core/columns.ts";
import { checkCoreAlignment, coreOutlines, parseCoreConfig } from "../core/coreAlignment.ts";
import { checkBuildingPlan, parseRoomCheckConfig } from "../core/checks.ts";
import { deleteWall } from "../core/edit.ts";
import { parseMapSettings } from "../core/geo.ts";
import type { Project, Stage, Storey, WallKind } from "../core/model.ts";
import { deleteOpening } from "../core/openings.ts";
import { DEFAULT_SNAP, SHAPES, SNAP_LABEL, SNAP_MODES, type Shape, type SnapSettings } from "../core/osnap.ts";
import {
  createProject,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "../core/project.ts";
import { analyseSite, deleteBoundaryCorner, parseSiteRules, setBoundary } from "../core/site.ts";
import { deleteDimension, parseDimensionStyle, storeyChains } from "../core/dimensions.ts";
import { parseExportConfig } from "../core/sheets.ts";
import { linkSpaces } from "../core/spaces.ts";
import {
  addCoreElement,
  isGroundStorey,
  rebuildStructure,
  setFootprint,
  setStage,
  storeyOutline,
  structureIntact,
  structureStatus,
  upperOutline,
} from "../core/structure.ts";
import {
  type Access,
  type UnitType,
  parseSplitRules,
  proposeSplits,
  usableArea,
} from "../core/storeySplit.ts";
import { download, fileBase } from "../export/download.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { MapPicker } from "./MapPicker.tsx";
import {
  type ApartmentTag,
  type CoreGhost,
  PlanCanvas,
  type Selection,
  type Tool,
} from "./PlanCanvas.tsx";
import {
  ApartmentsPanel,
  AreaTable,
  LengthField,
  PlanChecksPanel,
  PropertiesPanel,
  SitePanel,
  DimensionsPanel,
  StoreysPanel,
  WarningsPanel,
} from "./Sidebar.tsx";
import { useProjectStore } from "./useProjectStore.ts";
import { StoreyPlanPanel } from "./StoreyPlanPanel.tsx";
import { RuleReport } from "./RuleReport.tsx";
import type { RuleCheck } from "../roomSubdivision.ts";
import { ColumnsPanel, CorePanel, ErkerPanel, LocationPanel, OutlinePanel, Stepper } from "./WorkflowPanels.tsx";

const areaConfig = parseAreaConfig(areaDefinitions);
const coreConfig = parseCoreConfig(coreAlignment);
const columnConfig = parseColumnConfig(columnsJson);
const roomCheckConfig = parseRoomCheckConfig(roomChecks);
const defaultRulesDoc = rulesDoc(layoutRules);
const siteRules = parseSiteRules(siteRulesJson);
const exportConfig = parseExportConfig(exportDefaults);
const dimensionStyle = parseDimensionStyle(dimensionStyleJson);
const annotationStyle = parseAnnotationStyle(annotationStyleJson);
const mapSettings = parseMapSettings(mapSettingsJson);
const splitRules = parseSplitRules(storeySplitJson);
const windowRules = parseWindowRules(windowRulesJson);
const WINDOWS_KEY = "arhitektura.autoWindows";
function loadAutoWindows(): boolean {
  try {
    return localStorage.getItem(WINDOWS_KEY) !== "0";
  } catch {
    return true;
  }
}
/** Printed on the Notes sheet of an exported schedule. */
const exportNotes = [areaDefinitions._status, siteRulesJson._status];

/** Generated plans being looked at before one is applied: room layouts of an apartment, or storey plans. */
interface PlanPreview {
  storeyId: string;
  /** "Layout" or "Storey plan". */
  title: string;
  proposals: { storey: Storey; summary: string; note?: string; checks?: RuleCheck[] }[];
  index: number;
  /** A storey plan that is also to be drawn on these storeys, with the same mix. */
  similar?: { units: UnitType[]; access: Access | "auto"; storeyIds: string[] };
}

const MIX_STORAGE_KEY = "arhitektura.unitMix";

/** The apartment mix as last left in this browser, else the one in the config. */
function loadMix(): UnitType[] {
  try {
    const raw = localStorage.getItem(MIX_STORAGE_KEY);
    if (raw) {
      const saved = parseSplitRules({ ...storeySplitJson, unitTypes: JSON.parse(raw) }).unitTypes;
      if (saved.length > 0) return saved;
    }
  } catch {
    // A damaged or missing entry: start from the config.
  }
  return splitRules.unitTypes.map((u) => ({ ...u, program: { ...u.program } }));
}

/** Apartments are told apart on the plan by colour, in the order they were made. */
const APARTMENT_COLORS = [
  "#1f6fb5",
  "#c8641b",
  "#2e8556",
  "#8a4fb0",
  "#b8323a",
  "#11848a",
  "#86622f",
  "#4f5fc4",
];

const SHAPE_LABEL: Record<Shape, { label: string; title: string }> = {
  line: { label: "Line", title: "Click point after point" },
  rectangle: { label: "Rectangle", title: "Click two opposite corners" },
  polygon: { label: "Polygon", title: "Click the centre, then a corner" },
  circle: { label: "Circle", title: "Click the centre, then a point on the rim" },
};

const SNAP_STORAGE_KEY = "arhitektura.snap";

/** Snap settings as last left in this browser, else the defaults. */
function loadSnap(): SnapSettings {
  try {
    const raw = localStorage.getItem(SNAP_STORAGE_KEY);
    if (!raw) return DEFAULT_SNAP;
    const saved = JSON.parse(raw) as Partial<SnapSettings>;
    return { ...DEFAULT_SNAP, ...saved, modes: { ...DEFAULT_SNAP.modes, ...saved.modes } };
  } catch {
    return DEFAULT_SNAP;
  }
}

interface ToolButton {
  tool: Tool;
  label: string;
  title: string;
  /** Keyboard shortcut, a single letter. */
  key?: string;
}

/** The tools of each step; the first is the one the step opens with. */
const STAGE_TOOLS: Record<Stage, ToolButton[]> = {
  lot: [{ tool: "site", label: "Plot", title: "Draw the plot, set setbacks and move the building (S)", key: "s" }],
  outline: [{ tool: "outline", label: "Outline", title: "Draw the outline of the ground floor, then drag its corners" }],
  erker: [{ tool: "erker", label: "Erker sides", title: "Click a side of the outline to switch its erker on or off" }],
  core: [
    { tool: "entrance", label: "Entrance", title: "Place the entrance in an outside wall of the ground floor" },
    { tool: "hall", label: "Hall", title: "Drag a rectangle for the hall" },
    { tool: "stair", label: "Stairs", title: "Drag a rectangle for the stairs" },
    { tool: "elevator", label: "Elevator", title: "Drag a rectangle for the elevator" },
    { tool: "select", label: "Select", title: "Select and move the entrance (V)", key: "v" },
  ],
  apartments: [
    { tool: "select", label: "Select", title: "Select and move (V)", key: "v" },
    { tool: "wall", label: "Wall", title: "Draw walls (W)", key: "w" },
    { tool: "door", label: "Door", title: "Place doors on walls (D)", key: "d" },
    { tool: "window", label: "Window", title: "Place windows on walls (N)", key: "n" },
    { tool: "dimension", label: "Dimension", title: "Place a dimension between two points (M)", key: "m" },
  ],
};

const STATUS: Record<Tool, string> = {
  select:
    "Drag a wall, its end points, a door or a window · drag empty space to pan · wheel to zoom · Delete removes the selection",
  wall: "Click to place wall ends · F8 ortho, Shift flips it · F3 object snap · Esc or right-click ends the run",
  door: "Move over a wall and click to place a door · it snaps to where it fits",
  window: "Move over a wall and click to place a window · it snaps to where it fits",
  dimension:
    "Click the two points to measure, then click where the dimension line goes · it snaps to wall corners and opening edges · Esc starts again",
  site: "Click an edge for its setback · drag a corner to reshape the plot · drag the building to move it · drag empty space to pan",
  outline: "Drag a corner to reshape the outline · drag empty space to pan · wheel to zoom",
  erker: "Click a side of the outline to switch its erker on or off · drag empty space to pan",
  entrance: "Move over an outside wall and click to place the entrance · it snaps to where it fits",
  hall: "Drag a rectangle for the hall · it snaps to wall corners and the grid · it is drawn on every storey",
  stair: "Drag a rectangle for the stairs · it snaps to wall corners and the grid · it is drawn on every storey",
  elevator: "Drag a rectangle for the elevator · it snaps to wall corners and the grid · it is drawn on every storey",
};

export function App() {
  const store = useProjectStore();
  const { project } = store;
  const [activeStoreyId, setActiveStoreyId] = useState<string>();
  const realStorey = getActiveStorey(project, activeStoreyId);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [mix, setMix] = useState<UnitType[]>(loadMix);
  useEffect(() => {
    try {
      localStorage.setItem(MIX_STORAGE_KEY, JSON.stringify(mix));
    } catch {
      // Not kept in a private window.
    }
  }, [mix]);
  const [access, setAccess] = useState<Access | "auto">("auto");
  const [alsoSimilar, setAlsoSimilar] = useState(true);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [generatingAll, setGeneratingAll] = useState<string | null>(null);
  const [autoWindows, setAutoWindows] = useState(loadAutoWindows);
  const [layoutError, setLayoutError] = useState<{ apartmentId: string; reason: string } | null>(null);
  const previewing = preview !== null && preview.storeyId === realStorey.id;
  // While a generated layout is previewed, the whole screen shows the storey
  // as it would become; nothing is changed until it is applied.
  const storey = previewing ? preview.proposals[preview.index].storey : realStorey;
  const building = findBuilding(project, storey.id)!;
  const stage = project.stage;
  const tools = STAGE_TOOLS[stage];
  const [chosenTool, setTool] = useState<Tool>(tools[0].tool);
  // A tool belongs to a step; after a step change (also by undo) the step's first tool takes over.
  const stageTool = tools.some((t) => t.tool === chosenTool) ? chosenTool : tools[0].tool;
  // The entrance is placed on the ground floor only; on another storey the tool steps aside.
  const tool = stageTool === "entrance" && !isGroundStorey(building, storey.id) ? "select" : stageTool;
  const [selection, setSelection] = useState<Selection>(null);
  const [wallKind, setWallKind] = useState<WallKind>("interior");
  const [pickingLocation, setPickingLocation] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const structure = building.structure;
  const hasOutline = structure.footprint.length >= 3;
  const status = useMemo(() => structureStatus(project), [project]);
  const [thickness, setThickness] = useState(editorDefaults.wallThickness);
  const [shape, setShape] = useState<Shape>("line");
  const [polygonSides, setPolygonSides] = useState(editorDefaults.polygonSides);
  const [snapSettings, setSnapSettings] = useState<SnapSettings>(loadSnap);
  useEffect(() => {
    try {
      localStorage.setItem(SNAP_STORAGE_KEY, JSON.stringify(snapSettings));
    } catch {
      // Not kept in a private window: the settings still work for this visit.
    }
  }, [snapSettings]);
  const toggleSnap = (key: "osnap" | "grid" | "ortho") => setSnapSettings((s) => ({ ...s, [key]: !s[key] }));
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const linked = useMemo(() => linkSpaces(storey), [storey]);
  const dimensionChains = useMemo(
    () => storeyChains(storey, project.annotations, dimensionStyle, dimensionStyle.screenScale, linked),
    [storey, project.annotations, linked],
  );
  const annotationEntities = useMemo(
    () => storeyAnnotations(storey, project.annotations, annotationStyle, dimensionStyle.screenScale, linked),
    [storey, project.annotations, linked],
  );
  const areas = useMemo(() => computeStoreyAreas(storey, areaConfig), [storey]);
  const netById = useMemo(() => new Map(areas.spaces.map((s) => [s.spaceId, s.net])), [areas]);
  const byApartment = useMemo(() => computeApartmentAreas(storey, areaConfig, areas), [storey, areas]);
  const apartmentInfos = useMemo(() => describeApartments(storey, linked), [storey, linked]);
  const colorOf = (apartmentId: string) =>
    APARTMENT_COLORS[
      Math.max(0, storey.apartments.findIndex((a) => a.id === apartmentId)) % APARTMENT_COLORS.length
    ];
  const apartmentBySpaceId = useMemo(() => {
    const tags = new Map<string, ApartmentTag>();
    storey.apartments.forEach((a, i) => {
      const tag = { name: a.name, color: APARTMENT_COLORS[i % APARTMENT_COLORS.length] };
      for (const id of a.spaceIds) tags.set(id, tag);
    });
    return tags;
  }, [storey.apartments]);

  // The site is checked against the real project: a previewed layout only adds partitions.
  const siteAnalysis = useMemo(() => analyseSite(project.site, siteRules, areaConfig), [project.site]);
  const hasPlot = project.site.boundary.length >= 3;
  const setProject = (next: Project, record = true) => {
    if (previewing || next === project) return;
    store.set(next, record);
  };
  const openStage = (next: Stage) => {
    const moved = setStage(project, next);
    if (moved === project) return;
    setPreview(null);
    setSelection(null);
    setTool(STAGE_TOOLS[next][0].tool);
    // The entrance and the core are placed on the ground floor.
    if (next === "core") setActiveStoreyId(sortedStoreys(building)[0].id);
    store.set(moved);
  };

  const storeys = useMemo(() => sortedStoreys(building), [building]);
  const buildingAreas = useMemo(() => computeBuildingAreas(building, areaConfig), [building]);
  const coreIssues = useMemo(() => checkCoreAlignment(building, coreConfig), [building]);
  const elevationIssues = useMemo(() => checkElevations(building), [building]);
  const planIssues = useMemo(() => checkBuildingPlan(building, roomCheckConfig), [building]);
  // The project's own layout rules, else the config's.
  const ruleSetup = useMemo(() => resolveLayoutRules(layoutRules, project.layoutRules), [project.layoutRules]);
  const layoutRuleSet = ruleSetup.rules;
  const storeyPlanIssues = useMemo(
    () => planIssues.filter((i) => i.storeyId === storey.id),
    [planIssues, storey.id],
  );
  const hasCore = useMemo(
    () => building.storeys.some((s) => s.spaces.some((x) => coreConfig.coreSpaceTypes.includes(x.type))),
    [building],
  );

  const warningCount = useMemo(() => {
    const count = new Map<string, number>();
    const bump = (id: string) => count.set(id, (count.get(id) ?? 0) + 1);
    for (const i of coreIssues) {
      bump(i.storeyId);
      if (i.kind === "misaligned") bump(i.otherStoreyId);
    }
    for (const i of elevationIssues) bump(i.storeyId);
    for (const i of planIssues) bump(i.storeyId);
    return count;
  }, [coreIssues, elevationIssues, planIssues]);

  // What the neighbouring floors contribute to this plan.
  const index = storeys.findIndex((s) => s.id === storey.id);
  const below = storeys[index - 1];
  const above = storeys[index + 1];
  const { coreGhosts, flaggedSpaceIds } = useMemo(() => {
    const flagged = new Set<string>();
    const badElsewhere = new Set<string>();
    for (const i of coreIssues) {
      if (i.storeyId === storey.id) {
        flagged.add(i.spaceId);
        if (i.otherSpaceId) badElsewhere.add(i.otherSpaceId);
      } else if (i.otherStoreyId === storey.id) {
        badElsewhere.add(i.spaceId);
        if (i.otherSpaceId) flagged.add(i.otherSpaceId);
      }
    }
    const ghosts: CoreGhost[] = [];
    for (const [neighbour, where] of [[below, "below"], [above, "above"]] as const) {
      if (!neighbour) continue;
      for (const o of coreOutlines(neighbour, coreConfig)) {
        ghosts.push({
          key: o.spaceId,
          outline: o.outline,
          label: `${o.type} "${o.name}" on ${neighbour.name} (${where})`,
          bad: badElsewhere.has(o.spaceId),
        });
      }
    }
    return { coreGhosts: ghosts, flaggedSpaceIds: flagged };
  }, [coreIssues, storey.id, below, above]);

  const openStorey = (id: string) => {
    setActiveStoreyId(id);
    setSelection(null);
    // The entrance is placed on the ground floor only.
    if (tool === "entrance" && id !== storeys[0].id) setTool("select");
  };
  const removeStorey = () => {
    if (!window.confirm(`Delete "${storey.name}" and everything drawn on it? Undo brings it back.`)) return;
    const next = below ?? above;
    store.set(rebuildStructure(deleteStorey(project, storey.id), building.id));
    openStorey(next.id);
  };

  const setStorey = (next: Storey, record = true) => {
    if (previewing) return; // a preview is looked at, not edited
    // The walls of the structure are changed in their own steps, not on a storey.
    if (hasOutline && !structureIntact(realStorey, next)) return;
    store.set(replaceStorey(project, next), record);
  };
  const chooseTool = (next: Tool) => {
    setTool(next);
    // The entrance is on the ground floor.
    if (next === "entrance") openStorey(storeys[0].id);
  };

  // Any change to the project, or another storey, ends a preview: it was made for the plan as it was.
  const keptLayoutError = useRef<{ apartmentId: string; reason: string } | null>(null);
  useEffect(() => {
    setPreview(null);
    setLayoutError(keptLayoutError.current);
    keptLayoutError.current = null;
  }, [project, activeStoreyId]);

  /** Why each apartment on this storey cannot be laid out automatically, if it cannot. */
  const layoutBlockers = useMemo(() => {
    const blockers = new Map<string, string>();
    for (const a of realStorey.apartments) {
      const built = buildLayoutInput(realStorey, a.id);
      if (!built.ok) blockers.set(a.id, built.reason);
    }
    return blockers;
  }, [realStorey]);

  const applyOptions = {
    partitionThickness: thickness.interior,
    door: editorDefaults.openings.door,
    snap: project.grid.snap,
    windows: autoWindows ? windowRules : undefined,
  };
  const changeAutoWindows = (on: boolean) => {
    setAutoWindows(on);
    try {
      localStorage.setItem(WINDOWS_KEY, on ? "1" : "0");
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  /** Windows for the rooms of this storey that need daylight and have none. */
  const addMissingWindows = () => {
    const ids = storeyPlanIssues.filter((i) => i.kind === "roomNoDaylight").map((i) => i.spaceId!);
    setStorey(placeWindows(realStorey, windowRules, { spaceIds: ids }));
  };

  const generateLayout = (apartmentId: string) => {
    const apartment = realStorey.apartments.find((a) => a.id === apartmentId);
    if (!apartment) return;
    const own = apartmentInteriorWalls(realStorey, apartmentId).length;
    if (
      own > 0 &&
      !window.confirm(
        `"${apartment.name}" has ${own} partition${own > 1 ? "s" : ""} of its own. A generated layout replaces ${own > 1 ? "them" : "it"}, with the doors in ${own > 1 ? "them" : "it"}. Continue?`,
      )
    ) {
      return;
    }
    const result = proposeLayouts(realStorey, apartmentId, layoutRuleSet, applyOptions, 3, apartment.program);
    if (!result.ok) {
      setLayoutError({ apartmentId, reason: result.reason });
      return;
    }
    setLayoutError(null);
    setSelection(null);
    setTool("select");
    setPreview({
      storeyId: realStorey.id,
      title: "Layout",
      proposals: result.proposals.map((q) => ({
        storey: q.storey,
        summary: `${apartment.name} · ${q.rooms.join(", ")}`,
        note: q.relaxation < 1 ? `tight: minimum sizes scaled to ${Math.round(q.relaxation * 100)} %` : undefined,
        checks: q.checks,
      })),
      index: 0,
    });
  };

  /** Lays out every apartment of the storey that can be, one at a time so the screen keeps up. */
  const generateAll = () => {
    const ids = realStorey.apartments.filter((a) => !layoutBlockers.has(a.id)).map((a) => a.id);
    if (ids.length === 0) return;
    const own = realStorey.apartments.filter((a) => apartmentInteriorWalls(realStorey, a.id).length > 0);
    if (
      own.length > 0 &&
      !window.confirm(
        `${own.map((a) => a.name).join(", ")} already ${own.length > 1 ? "have" : "has"} partitions. New layouts replace them. Continue?`,
      )
    ) {
      return;
    }
    let working = realStorey;
    const failed: string[] = [];
    const step = (k: number) => {
      if (k >= ids.length) {
        setGeneratingAll(null);
        // Reported after the project change, which clears old messages.
        keptLayoutError.current =
          failed.length > 0 ? { apartmentId: "", reason: `No layout found for ${failed.join(", ")}.` } : null;
        if (working !== realStorey) store.set(replaceStorey(project, working));
        else setLayoutError(keptLayoutError.current);
        return;
      }
      const apartment = working.apartments.find((a) => a.id === ids[k]);
      setGeneratingAll(`Laying out ${apartment?.name ?? ""} (${k + 1} of ${ids.length})…`);
      setTimeout(() => {
        if (apartment) {
          const result = proposeLayouts(working, apartment.id, layoutRuleSet, applyOptions, 3, apartment.program);
          if (result.ok) working = result.proposals[0].storey;
          else failed.push(apartment.name);
        }
        step(k + 1);
      }, 20);
    };
    step(0);
  };

  // ------------------------------------------------------------ storey plan
  const usable = useMemo(() => usableArea(building, realStorey.id, splitRules), [building, realStorey.id]);
  const similarStoreyIds = useMemo(() => {
    const mine = JSON.stringify(storeyOutline(building, realStorey.id));
    return storeys
      .filter((s) => s.id !== realStorey.id && JSON.stringify(storeyOutline(building, s.id)) === mine)
      .map((s) => s.id);
  }, [building, realStorey.id, storeys]);
  const hasOwnPlan = realStorey.apartments.length > 0 || realStorey.walls.some((w) => !w.part);

  const generateSplit = () => {
    setSplitBusy(true);
    setSplitError(null);
    // Let the button show that it is working before the search takes the thread.
    setTimeout(() => {
      const result = proposeSplits(building, realStorey, mix, access, splitRules, 3);
      setSplitBusy(false);
      if (!result.ok) {
        setSplitError(result.reason);
        return;
      }
      setSelection(null);
      setTool("select");
      const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
      setPreview({
        storeyId: realStorey.id,
        title: "Storey plan",
        proposals: result.proposals.map((q) => ({
          storey: q.storey,
          summary: q.apartments.map((a) => `${a.name} ${a.unitType} ${fmt(a.area)} m²`).join(" · "),
          note: q.access === "corridor" ? "reached along a corridor" : "reached from the hall",
        })),
        index: 0,
        similar:
          alsoSimilar && similarStoreyIds.length > 0
            ? { units: mix.map((u) => ({ ...u })), access, storeyIds: similarStoreyIds }
            : undefined,
      });
    }, 30);
  };

  const stepPreview = (by: number) =>
    setPreview((p) => p && { ...p, index: (p.index + by + p.proposals.length) % p.proposals.length });
  const applyPreview = () => {
    if (!previewing) return;
    let next = replaceStorey(project, preview.proposals[preview.index].storey);
    // The same plan on the storeys with the same outline: the search gives the same answers there.
    for (const id of preview.similar?.storeyIds ?? []) {
      const b = findBuilding(next, id)!;
      const target = b.storeys.find((s) => s.id === id)!;
      const result = proposeSplits(b, target, preview.similar!.units, preview.similar!.access, splitRules, 3);
      if (result.ok) {
        next = replaceStorey(next, result.proposals[Math.min(preview.index, result.proposals.length - 1)].storey);
      }
    }
    store.set(next);
  };

  // Latest values for the keyboard handler, which is attached once.
  const live = useRef({ store, storey, selection, setStorey, project, setProject, exporting, tools, chooseTool, pickingLocation, toggleSnap });
  live.current = { store, storey, selection, setStorey, project, setProject, exporting, tools, chooseTool, pickingLocation, toggleSnap };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // AutoCAD's keys: F3 object snap, F8 ortho, F9 grid snap.
      const fkey = ({ F3: "osnap", F8: "ortho", F9: "grid" } as const)[e.key as "F3" | "F8" | "F9"];
      if (fkey) {
        e.preventDefault();
        live.current.toggleSnap(fkey);
        return;
      }
      const target = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const { store, storey, selection, setStorey, project, setProject, exporting, tools, chooseTool, pickingLocation } =
        live.current;
      if (exporting || pickingLocation) return; // the dialog has the keyboard
      const shortcut = tools.find((t) => t.key === e.key.toLowerCase());
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        store.redo();
      } else if (!mod && shortcut) chooseTool(shortcut.tool);
      else if ((e.key === "Delete" || e.key === "Backspace") && selection?.kind === "dimension") {
        e.preventDefault();
        setStorey(deleteDimension(storey, selection.id));
        setSelection(null);
      }
      else if ((e.key === "Delete" || e.key === "Backspace") && selection?.kind === "siteCorner") {
        e.preventDefault();
        setProject(deleteBoundaryCorner(project, selection.index));
        setSelection(null);
      }
      else if (e.key === "Escape") {
        setSelection(null);
        setPreview(null);
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        (selection?.kind === "wall" || selection?.kind === "opening")
      ) {
        e.preventDefault();
        setStorey(
          selection.kind === "wall"
            ? deleteWall(storey, selection.id)
            : deleteOpening(storey, selection.id),
        );
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** The tools that draw with the shape buttons: walls, and the plot or outline before it exists. */
  const drawsShapes = tool === "wall" || (tool === "site" && !hasPlot) || (tool === "outline" && !hasOutline);

  const save = () => {
    download(`${fileBase(project.name)}.arh.json`, serializeProject(project), "application/json");
  };

  const open = async (file: File | undefined) => {
    if (!file) return;
    try {
      store.load(parseProject(await file.text()));
      setActiveStoreyId(undefined);
      setSelection(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const newProject = () => {
    if (storey.walls.length > 0 && !window.confirm("Start an empty project? The current plan is replaced (save it first to keep it).")) {
      return;
    }
    store.load(
      createProject("Untitled project", editorDefaults.snapStep, {
        shell: editorDefaults.wallThickness.exterior,
        core: editorDefaults.wallThickness.core,
      }),
    );
    setActiveStoreyId(undefined);
    setSelection(null);
  };

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">Arhitektura</strong>
        <input
          className="project-name"
          value={project.name}
          aria-label="Project name"
          onChange={(e) => store.set({ ...project, name: e.target.value }, false)}
        />
        <div className="group" role="group" aria-label="Tool">
          {tools.map((t) => (
            <button
              key={t.tool}
              className={tool === t.tool ? "is-active" : ""}
              onClick={() => chooseTool(t.tool)}
              title={t.title}
            >
              {t.label}
            </button>
          ))}
        </div>
        {stage === "apartments" && (
          <>
            <label className="inline">
              New walls
              <select value={wallKind} onChange={(e) => setWallKind(e.target.value as WallKind)}>
                <option value="interior">interior</option>
                <option value="exterior">exterior</option>
              </select>
            </label>
            <div className="inline-field">
              <LengthField
                label="Thickness"
                value={thickness[wallKind]}
                min={0.01}
                onCommit={(v) => setThickness({ ...thickness, [wallKind]: v })}
              />
            </div>
          </>
        )}
        {drawsShapes && (
          <div className="group" role="group" aria-label="Shape">
            {SHAPES.map((s) => (
              <button
                key={s}
                className={shape === s ? "is-active" : ""}
                onClick={() => setShape(s)}
                title={SHAPE_LABEL[s].title}
              >
                {SHAPE_LABEL[s].label}
              </button>
            ))}
          </div>
        )}
        {drawsShapes && shape === "polygon" && (
          <label className="inline">
            Sides
            <input
              type="number"
              className="sides-input"
              min={3}
              max={64}
              value={polygonSides}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (v >= 3 && v <= 64) setPolygonSides(v);
              }}
            />
          </label>
        )}
        <div className="inline-field">
          <LengthField
            label="Snap"
            value={project.grid.snap}
            min={0.001}
            onCommit={(v) => store.set({ ...project, grid: { snap: v } }, false)}
          />
        </div>
        <div className="group snap-toggles" role="group" aria-label="Drawing aids">
          <button
            className={snapSettings.osnap ? "is-active" : ""}
            onClick={() => toggleSnap("osnap")}
            title="Object snap: ends, middles, centres, crossings, perpendiculars (F3)"
          >
            OSNAP
          </button>
          <button
            className={snapSettings.ortho ? "is-active" : ""}
            onClick={() => toggleSnap("ortho")}
            title="Ortho: keep new lines horizontal or vertical (F8) · Shift flips it while held"
          >
            ORTHO
          </button>
          <button
            className={snapSettings.grid ? "is-active" : ""}
            onClick={() => toggleSnap("grid")}
            title="Grid snap (F9)"
          >
            GRID
          </button>
        </div>
        <details className="snap-modes">
          <summary title="Choose which object snaps are on">Snaps ▾</summary>
          <div className="snap-modes__menu">
            {SNAP_MODES.map((m) => (
              <label key={m}>
                <input
                  type="checkbox"
                  checked={snapSettings.modes[m]}
                  onChange={(e) =>
                    setSnapSettings((s) => ({ ...s, modes: { ...s.modes, [m]: e.target.checked } }))
                  }
                />
                {SNAP_LABEL[m]}
              </label>
            ))}
          </div>
        </details>
        <span className="spacer" />
        <div className="group">
          <button onClick={store.undo} disabled={!store.canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button onClick={store.redo} disabled={!store.canRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
        </div>
        <div className="group">
          <button onClick={newProject}>New</button>
          <button onClick={() => fileInput.current?.click()}>Open…</button>
          <button onClick={save}>Save JSON</button>
          <button
            onClick={() => setExporting(true)}
            disabled={previewing}
            title="Export plans to PDF or DXF, or the area schedule to XLSX"
          >
            Export…
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            void open(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </header>

      <Stepper project={project} onStage={openStage} />

      {pickingLocation && (
        <MapPicker
          settings={mapSettings}
          current={project.site.location}
          onClose={() => setPickingLocation(false)}
          onPick={(location) => {
            setProject({ ...project, site: { ...project.site, location } });
            setShowMap(true);
            setPickingLocation(false);
          }}
        />
      )}

      {exporting && (
        <ExportDialog
          project={project}
          areaConfig={areaConfig}
          analysis={siteAnalysis}
          config={exportConfig}
          dimensionStyle={dimensionStyle}
          annotationStyle={annotationStyle}
          footprintRule={siteRules.footprint === "allStoreys" ? "all storeys seen from above" : "lowest storey only"}
          notes={exportNotes}
          onClose={() => setExporting(false)}
        />
      )}

      {error && (
        <div className="error" role="alert">
          Could not open the file: {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <main className="workspace">
        <div className={`canvas-wrap${previewing ? " is-previewing" : ""}`}>
          {previewing && (
            <div className="preview-bar" role="region" aria-label="Layout preview">
              <strong>
                {preview.title} {preview.index + 1} of {preview.proposals.length}
              </strong>
              <span>
                {preview.proposals[preview.index].summary}
                {preview.proposals[preview.index].note && ` · ${preview.proposals[preview.index].note}`}
                {preview.similar &&
                  ` · also on ${preview.similar.storeyIds.length} more storey${preview.similar.storeyIds.length > 1 ? "s" : ""}`}
              </span>
              {preview.proposals[preview.index].checks && (
                <RuleReport checks={preview.proposals[preview.index].checks!} />
              )}
              <span className="spacer" />
              {preview.proposals.length > 1 && (
                <div className="group">
                  <button onClick={() => stepPreview(-1)}>Previous</button>
                  <button onClick={() => stepPreview(1)}>Next</button>
                </div>
              )}
              <button className="is-active" onClick={applyPreview}>
                Apply
              </button>
              <button onClick={() => setPreview(null)}>Cancel</button>
            </div>
          )}
          <PlanCanvas
            storey={storey}
            faceBySpaceId={linked.faceBySpaceId}
            areaLabel={(id) => `${formatArea(netById.get(id) ?? 0, areaConfig)} m²`}
            tool={tool}
            selection={selection}
            snapStep={project.grid.snap}
            snapSettings={snapSettings}
            shape={drawsShapes ? shape : "line"}
            shapeSides={{ polygon: polygonSides, circle: editorDefaults.circleSegments }}
            wallThickness={thickness[wallKind]}
            wallKind={wallKind}
            underlay={below?.walls ?? []}
            coreGhosts={coreGhosts}
            flaggedSpaceIds={flaggedSpaceIds}
            openingSize={editorDefaults.openings}
            apartmentBySpaceId={apartmentBySpaceId}
            project={project}
            buildingId={building.id}
            site={siteAnalysis}
            dimensionChains={dimensionChains}
            dimensionStyle={dimensionStyle}
            annotationEntities={annotationEntities}
            north={project.site.north}
            structure={structure}
            outline={storeyOutline(building, storey.id)}
            erkerOutline={
              hasOutline && isGroundStorey(building, storey.id) && upperOutline(structure) !== structure.footprint
                ? upperOutline(structure)
                : null
            }
            map={showMap && project.site.location ? { origin: project.site.location, settings: mapSettings } : null}
            entranceSize={editorDefaults.entranceDoor}
            onFootprintDrawn={(corners) => setProject(setFootprint(project, building.id, corners))}
            onCoreDrawn={(kind, a, b) => setProject(addCoreElement(project, building.id, kind, a, b).project)}
            onPlotDrawn={(corners) => {
              setProject(
                setBoundary(project, corners, siteRules.defaultSetback, {
                  maxCoverage: siteRules.maxCoverage,
                  maxFloorAreaRatio: siteRules.maxFloorAreaRatio,
                }),
              );
              setSelection(null);
            }}
            onProjectChange={setProject}
            onChange={setStorey}
            onSelect={setSelection}
          />
          <p className="status">
            <strong>{storey.name}</strong> ·{" "}
            {previewing
              ? "Previewing a generated layout · nothing is changed until you press Apply · Esc cancels"
              : tool === "site" && !hasPlot
                ? "Click the corners of the plot · click the first corner again or press Enter to close it · Esc starts again"
                : tool === "outline" && !hasOutline
                  ? "Click the corners of the ground floor · Shift keeps an edge straight · click the first corner again or press Enter to close it · Esc starts again"
                  : STATUS[tool]}
          </p>
        </div>
        <aside className="sidebar">
          {stage === "lot" && (
            <LocationPanel
              project={project}
              showMap={showMap}
              onPickOnMap={() => setPickingLocation(true)}
              onShowMap={setShowMap}
              onChange={(p) => setProject(p)}
            />
          )}
          {stage === "outline" && (
            <OutlinePanel project={project} buildingId={building.id} config={areaConfig} onChange={(p) => setProject(p)} />
          )}
          {stage === "erker" && (
            <ErkerPanel project={project} buildingId={building.id} config={areaConfig} onChange={(p) => setProject(p)} />
          )}
          {stage === "core" && (
            <CorePanel project={project} buildingId={building.id} status={status} onChange={(p) => setProject(p)} />
          )}
          {stage !== "lot" && stage !== "outline" && (
            <>
              <StoreysPanel
                storeys={storeys}
                activeId={storey.id}
                warningCount={warningCount}
                canRestack={elevationIssues.length > 0}
                onSelect={openStorey}
                onAdd={() => {
                  const r = addStorey(project, building.id);
                  // The new storey gets the outline, the erker and the core of the building.
                  store.set(rebuildStructure(r.project, building.id));
                  openStorey(r.storeyId);
                }}
                onCopy={() => {
                  const r = copyStorey(project, storey.id);
                  store.set(rebuildStructure(r.project, building.id));
                  openStorey(r.storeyId);
                }}
                onDelete={removeStorey}
                onRestack={() => store.set(rebuildStructure(restackStoreys(project, building.id), building.id))}
                onUpdate={(patch) =>
                  store.set(
                    patch.elevation === undefined
                      ? updateStoreyInfo(project, storey.id, patch)
                      : rebuildStructure(updateStoreyInfo(project, storey.id, patch), building.id),
                    patch.name === undefined,
                  )
                }
              />
              <WarningsPanel
                coreIssues={coreIssues}
                elevationIssues={elevationIssues}
                storeyCount={storeys.length}
                hasCore={hasCore}
                tolerance={coreConfig.tolerance}
                onOpenCore={(issue) => {
                  setActiveStoreyId(issue.storeyId);
                  setSelection({ kind: "space", id: issue.spaceId });
                }}
                onOpenStorey={openStorey}
              />
            </>
          )}
          {(stage === "lot" || stage === "outline" || stage === "apartments") && (
            <SitePanel
              project={project}
              buildingId={building.id}
              analysis={siteAnalysis}
              rules={siteRules}
              config={areaConfig}
              siteToolActive={tool === "site"}
              selection={selection}
              onChange={(p) => setProject(p)}
              onSelect={setSelection}
              onUseSiteTool={() => openStage("lot")}
            />
          )}
          {(stage === "core" || stage === "apartments") && (
            <PropertiesPanel
              storey={storey}
              selection={selection}
              dimensionStyle={dimensionStyle}
              onChange={(s) => setStorey(s)}
              onSelect={setSelection}
            />
          )}
          {stage === "apartments" && (
            <>
              <StoreyPlanPanel
                storeyName={realStorey.name}
                usable={usable}
                mix={mix}
                onMix={setMix}
                access={access}
                onAccess={setAccess}
                similarCount={similarStoreyIds.length}
                alsoSimilar={alsoSimilar}
                onAlsoSimilar={setAlsoSimilar}
                hasOwnPlan={hasOwnPlan}
                busy={splitBusy}
                error={splitError}
                disabled={previewing || usable === null}
                onGenerate={generateSplit}
              />
              <ColumnsPanel
                project={project}
                buildingId={building.id}
                storey={realStorey}
                config={columnConfig}
                disabled={previewing}
                onChange={(p) => setProject(p)}
              />
              <PlanChecksPanel
                storey={storey}
                issues={storeyPlanIssues}
                onAddWindows={previewing ? undefined : addMissingWindows}
                onOpen={(issue) => issue.spaceId && setSelection({ kind: "space", id: issue.spaceId })}
              />
              <DimensionsPanel
                annotations={project.annotations}
                style={dimensionStyle}
                ownCount={storey.dimensions.length}
                onChange={(annotations) => setProject({ ...project, annotations })}
                onUseTool={() => setTool("dimension")}
              />
              <ApartmentsPanel
                storey={storey}
                infos={apartmentInfos}
                byApartment={byApartment}
                config={areaConfig}
                colorOf={colorOf}
                layoutBlockers={layoutBlockers}
                layoutError={layoutError}
                previewing={previewing}
                onGenerate={generateLayout}
                onGenerateAll={generateAll}
                generatingAll={generatingAll}
                autoWindows={autoWindows}
                onAutoWindows={changeAutoWindows}
                selection={selection}
                onChange={(s, record) => setStorey(s, record)}
                onSelect={setSelection}
              />
              <LayoutRulesPanel
                doc={project.layoutRules && !ruleSetup.error ? project.layoutRules : defaultRulesDoc}
                own={project.layoutRules !== undefined}
                error={ruleSetup.error}
                config={layoutRules}
                onChange={(doc) => {
                  const { layoutRules: _old, ...rest } = project;
                  setProject(doc ? { ...rest, layoutRules: doc } : rest);
                }}
              />
              <AreaTable
                storey={storey}
                areas={areas}
                byApartment={byApartment}
                buildingAreas={buildingAreas}
                config={areaConfig}
                onSelectStorey={openStorey}
                selection={selection}
                onSelect={setSelection}
              />
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
