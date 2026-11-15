import { useEffect, useMemo, useRef, useState } from "react";
import annotationStyleJson from "../config/annotationStyle.json";
import areaDefinitions from "../config/areaDefinitions.json";
import dimensionStyleJson from "../config/dimensionStyle.json";
import coreAlignment from "../config/coreAlignment.json";
import editorDefaults from "../config/editorDefaults.json";
import exportDefaults from "../config/exportDefaults.json";
import layoutRules from "../config/layoutRules.json";
import roomChecks from "../config/roomChecks.json";
import siteRulesJson from "../config/siteRules.json";
import { parseAnnotationStyle, storeyAnnotations } from "../core/annotations.ts";
import { describeApartments } from "../core/apartments.ts";
import {
  type LayoutProposal,
  apartmentInteriorWalls,
  buildLayoutInput,
  parseLayoutRules,
  proposeLayouts,
} from "../core/autoLayout.ts";
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
import { checkCoreAlignment, coreOutlines, parseCoreConfig } from "../core/coreAlignment.ts";
import { checkBuildingPlan, parseRoomCheckConfig } from "../core/checks.ts";
import { deleteWall } from "../core/edit.ts";
import type { Project, Storey, WallKind } from "../core/model.ts";
import { deleteOpening } from "../core/openings.ts";
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
import { download, fileBase } from "../export/download.ts";
import { ExportDialog } from "./ExportDialog.tsx";
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

const areaConfig = parseAreaConfig(areaDefinitions);
const coreConfig = parseCoreConfig(coreAlignment);
const roomCheckConfig = parseRoomCheckConfig(roomChecks);
const layoutRuleSet = parseLayoutRules(layoutRules);
const siteRules = parseSiteRules(siteRulesJson);
const exportConfig = parseExportConfig(exportDefaults);
const dimensionStyle = parseDimensionStyle(dimensionStyleJson);
const annotationStyle = parseAnnotationStyle(annotationStyleJson);
/** Printed on the Notes sheet of an exported schedule. */
const exportNotes = [areaDefinitions._status, siteRulesJson._status];

/** Generated layouts being looked at before one is applied. */
interface LayoutPreview {
  storeyId: string;
  apartmentId: string;
  proposals: LayoutProposal[];
  index: number;
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

const TOOLS: { tool: Tool; label: string; title: string }[] = [
  { tool: "select", label: "Select", title: "Select and move (V)" },
  { tool: "wall", label: "Wall", title: "Draw walls (W)" },
  { tool: "door", label: "Door", title: "Place doors on walls (D)" },
  { tool: "window", label: "Window", title: "Place windows on walls (N)" },
  { tool: "dimension", label: "Dimension", title: "Place a dimension between two points (M)" },
  { tool: "site", label: "Site", title: "Draw the plot, set setbacks and move the building (S)" },
];

const STATUS: Record<Tool, string> = {
  select:
    "Drag a wall, its end points, a door or a window · drag empty space to pan · wheel to zoom · Delete removes the selection",
  wall: "Click to place wall ends · Shift keeps it straight · Esc or right-click ends the run",
  door: "Move over a wall and click to place a door · it snaps to where it fits",
  window: "Move over a wall and click to place a window · it snaps to where it fits",
  dimension:
    "Click the two points to measure, then click where the dimension line goes · it snaps to wall corners and opening edges · Esc starts again",
  site: "Click an edge for its setback · drag a corner to reshape the plot · drag the building to move it · drag empty space to pan",
};

export function App() {
  const store = useProjectStore();
  const { project } = store;
  const [activeStoreyId, setActiveStoreyId] = useState<string>();
  const realStorey = getActiveStorey(project, activeStoreyId);
  const [preview, setPreview] = useState<LayoutPreview | null>(null);
  const [layoutError, setLayoutError] = useState<{ apartmentId: string; reason: string } | null>(null);
  const previewing = preview !== null && preview.storeyId === realStorey.id;
  // While a generated layout is previewed, the whole screen shows the storey
  // as it would become; nothing is changed until it is applied.
  const storey = previewing ? preview.proposals[preview.index].storey : realStorey;
  const building = findBuilding(project, storey.id)!;
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [wallKind, setWallKind] = useState<WallKind>("exterior");
  const [thickness, setThickness] = useState(editorDefaults.wallThickness);
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

  const storeys = useMemo(() => sortedStoreys(building), [building]);
  const buildingAreas = useMemo(() => computeBuildingAreas(building, areaConfig), [building]);
  const coreIssues = useMemo(() => checkCoreAlignment(building, coreConfig), [building]);
  const elevationIssues = useMemo(() => checkElevations(building), [building]);
  const planIssues = useMemo(() => checkBuildingPlan(building, roomCheckConfig), [building]);
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
  };
  const removeStorey = () => {
    if (!window.confirm(`Delete "${storey.name}" and everything drawn on it? Undo brings it back.`)) return;
    const next = below ?? above;
    store.set(deleteStorey(project, storey.id));
    openStorey(next.id);
  };

  const setStorey = (next: Storey, record = true) => {
    if (previewing) return; // a preview is looked at, not edited
    store.set(replaceStorey(project, next), record);
  };

  // Any change to the project, or another storey, ends a preview: it was made for the plan as it was.
  useEffect(() => {
    setPreview(null);
    setLayoutError(null);
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
    const result = proposeLayouts(realStorey, apartmentId, layoutRuleSet, {
      partitionThickness: thickness.interior,
      door: editorDefaults.openings.door,
      snap: project.grid.snap,
    });
    if (!result.ok) {
      setLayoutError({ apartmentId, reason: result.reason });
      return;
    }
    setLayoutError(null);
    setSelection(null);
    setTool("select");
    setPreview({ storeyId: realStorey.id, apartmentId, proposals: result.proposals, index: 0 });
  };

  const stepPreview = (by: number) =>
    setPreview((p) => p && { ...p, index: (p.index + by + p.proposals.length) % p.proposals.length });
  const applyPreview = () => {
    if (previewing) store.set(replaceStorey(project, preview.proposals[preview.index].storey));
  };

  // Latest values for the keyboard handler, which is attached once.
  const live = useRef({ store, storey, selection, setStorey, project, setProject, exporting });
  live.current = { store, storey, selection, setStorey, project, setProject, exporting };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const { store, storey, selection, setStorey, project, setProject, exporting } = live.current;
      if (exporting) return; // the export dialog has the keyboard
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        store.redo();
      } else if (!mod && key === "v") setTool("select");
      else if (!mod && key === "w") setTool("wall");
      else if (!mod && key === "d") setTool("door");
      else if (!mod && key === "n") setTool("window");
      else if (!mod && key === "m") setTool("dimension");
      else if (!mod && key === "s") setTool("site");
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
    store.load(createProject("Untitled project", editorDefaults.snapStep));
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
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              className={tool === t.tool ? "is-active" : ""}
              onClick={() => setTool(t.tool)}
              title={t.title}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="inline">
          New walls
          <select value={wallKind} onChange={(e) => setWallKind(e.target.value as WallKind)}>
            <option value="exterior">exterior</option>
            <option value="interior">interior</option>
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
        <div className="inline-field">
          <LengthField
            label="Snap"
            value={project.grid.snap}
            min={0.001}
            onCommit={(v) => store.set({ ...project, grid: { snap: v } }, false)}
          />
        </div>
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
                Layout {preview.index + 1} of {preview.proposals.length}
              </strong>
              <span>
                {storey.apartments.find((a) => a.id === preview.apartmentId)?.name} ·{" "}
                {preview.proposals[preview.index].rooms.join(", ")}
                {preview.proposals[preview.index].relaxation < 1 &&
                  ` · tight: minimum sizes scaled to ${Math.round(preview.proposals[preview.index].relaxation * 100)} %`}
              </span>
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
                : STATUS[tool]}
          </p>
        </div>
        <aside className="sidebar">
          <StoreysPanel
            storeys={storeys}
            activeId={storey.id}
            warningCount={warningCount}
            canRestack={elevationIssues.length > 0}
            onSelect={openStorey}
            onAdd={() => {
              const r = addStorey(project, building.id);
              store.set(r.project);
              openStorey(r.storeyId);
            }}
            onCopy={() => {
              const r = copyStorey(project, storey.id);
              store.set(r.project);
              openStorey(r.storeyId);
            }}
            onDelete={removeStorey}
            onRestack={() => store.set(restackStoreys(project, building.id))}
            onUpdate={(patch) =>
              store.set(updateStoreyInfo(project, storey.id, patch), patch.name === undefined)
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
            onUseSiteTool={() => setTool("site")}
          />
          <PlanChecksPanel
            storey={storey}
            issues={storeyPlanIssues}
            onOpen={(issue) => issue.spaceId && setSelection({ kind: "space", id: issue.spaceId })}
          />
          <PropertiesPanel
            storey={storey}
            selection={selection}
            dimensionStyle={dimensionStyle}
            onChange={(s) => setStorey(s)}
            onSelect={setSelection}
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
            selection={selection}
            onChange={(s, record) => setStorey(s, record)}
            onSelect={setSelection}
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
        </aside>
      </main>
    </div>
  );
}
