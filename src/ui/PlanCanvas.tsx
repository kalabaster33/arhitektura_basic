import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { moveBuilding } from "../core/building.ts";
import {
  type DimChain,
  type DimensionStyle,
  addDimension,
  chainEntities,
  dimensionSnapPoints,
  formatDimension,
  offsetFromLine,
  ownChain,
} from "../core/dimensions.ts";
import type { Entity } from "../core/drawing.ts";
import { addWall, addWallRun, moveNode, moveWall } from "../core/edit.ts";
import {
  type Pt,
  dist,
  projectParam,
  ringSignedArea,
  roundTo,
  samePoint,
  snapPoint,
} from "../core/geometry.ts";
import { type MapSettings, tileZoomFor, tilesForPlan } from "../core/geo.ts";
import {
  type Shape,
  type SnapGeometry,
  type SnapResult,
  type SnapSettings,
  SNAP_LABEL,
  findSnap,
  shapeRing,
  snapGeometry,
} from "../core/osnap.ts";
import type {
  CoreKind,
  GeoLocation,
  Opening,
  OpeningKind,
  Project,
  Storey,
  Structure,
  Wall,
  WallKind,
} from "../core/model.ts";
import {
  type OpeningSize,
  addOpening,
  fitOffset,
  locateOnWall,
  moveOpening,
  openingGeometry,
} from "../core/openings.ts";
import { type Region, type SiteAnalysis, boundaryProblem, moveBoundaryCorner } from "../core/site.ts";
import {
  MIN_CORE_SIZE,
  addEntrance,
  coreRect,
  moveFootprintCorner,
  outsideSign,
  ringArea,
  setErkerEdge,
} from "../core/structure.ts";
import type { Face } from "../core/topology.ts";

export type Tool =
  | "select"
  | "wall"
  | "door"
  | "window"
  | "dimension"
  | "site"
  /** Draws the outline of the ground floor, then reshapes it. */
  | "outline"
  /** Switches the erker of a side of the outline on and off. */
  | "erker"
  | "entrance"
  | CoreKind;

const CORE_TOOLS: Tool[] = ["hall", "stair", "elevator"];
const CORE_LABEL: Record<CoreKind, string> = { hall: "Hall", stair: "Stairs", elevator: "Elevator" };
export type Selection =
  | { kind: "wall" | "space" | "opening" | "dimension"; id: string }
  /** A corner of the plot, or the edge that starts at that corner. */
  | { kind: "siteCorner" | "siteEdge"; index: number }
  | null;

/** How a room that belongs to an apartment is marked on the plan. */
export interface ApartmentTag {
  name: string;
  color: string;
}

/** Outline of a core space on the storey above or below, drawn over the plan. */
export interface CoreGhost {
  key: string;
  outline: Pt[];
  label: string;
  /** True when it does not line up with this storey. */
  bad: boolean;
}

interface Props {
  storey: Storey;
  faceBySpaceId: Map<string, Face>;
  /** Area text shown under each room name. */
  areaLabel: (spaceId: string) => string;
  tool: Tool;
  selection: Selection;
  snapStep: number;
  /** Object snap, grid snap and ortho, as in AutoCAD. */
  snapSettings: SnapSettings;
  /** What the wall tool and an outline being drawn make: a run of lines or a closed shape. */
  shape: Shape;
  /** How many sides a polygon has, and how many walls make a circle. */
  shapeSides: { polygon: number; circle: number };
  wallThickness: number;
  wallKind: WallKind;
  /** Walls of the storey below, shown faintly for reference. */
  underlay: Wall[];
  coreGhosts: CoreGhost[];
  /** Spaces on this storey that have a core alignment warning. */
  flaggedSpaceIds: Set<string>;
  /** Size of the doors and windows the door and window tools place. */
  openingSize: Record<OpeningKind, OpeningSize>;
  /** The apartment of each room that is in one. */
  apartmentBySpaceId: Map<string, ApartmentTag>;
  /** The whole project, for the plot and for moving the building on it. */
  project: Project;
  /** The building the shown storey belongs to. */
  buildingId: string;
  site: SiteAnalysis;
  /** Every dimension of the storey that is to be shown, hand-placed ones included. */
  dimensionChains: DimChain[];
  dimensionStyle: DimensionStyle;
  /** Door and window tags and the floor level mark, where they are switched on. */
  annotationEntities: Entity[];
  /** Where north is, in degrees clockwise from the top of the plan. */
  north: number;
  /** The structure of the building: outline of the ground floor, erker and core. */
  structure: Structure;
  /** Outline of the shown storey at the outside wall faces; empty without a building outline. */
  outline: Pt[];
  /** Outline of the storeys above, shown on the ground floor where they project; null when they do not. */
  erkerOutline: Pt[] | null;
  /** The map shown under the plan, with the plan's origin on the earth; null for no map. */
  map: { origin: GeoLocation; settings: MapSettings } | null;
  /** Size of the door the entrance tool places. */
  entranceSize: OpeningSize;
  /** A plot outline drawn with the site tool, already checked. */
  onPlotDrawn: (corners: Pt[]) => void;
  /** A building outline drawn with the outline tool, already checked. */
  onFootprintDrawn: (corners: Pt[]) => void;
  /** A hall, staircase or elevator drawn as a rectangle between two corners. */
  onCoreDrawn: (kind: CoreKind, a: Pt, b: Pt) => void;
  onProjectChange: (project: Project, record: boolean) => void;
  onChange: (storey: Storey, record: boolean) => void;
  onSelect: (selection: Selection) => void;
}

interface View {
  ox: number;
  oy: number;
  zoom: number; // pixels per metre
}

type Drag =
  | { kind: "pan"; x: number; y: number; view: View; moved: boolean }
  | { kind: "node"; base: Storey; from: Pt; last: Pt; moved: boolean }
  | { kind: "wall"; base: Storey; id: string; start: Pt; last: Pt; moved: boolean }
  | { kind: "opening"; base: Storey; id: string; last: number; moved: boolean }
  | { kind: "corner"; base: Project; index: number; last: Pt; moved: boolean }
  | { kind: "footprintCorner"; base: Project; index: number; last: Pt; moved: boolean }
  | { kind: "rect"; core: CoreKind; start: Pt }
  | { kind: "building"; base: Project; start: Pt; last: Pt; moved: boolean };

const SNAP_PX = 10;
/** How near a wall the pointer must be for the door and window tools to use it. */
const WALL_REACH_PX = 28;

const ringPath = (ring: Pt[]) =>
  ring.length ? `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z` : "";
const regionPath = (region: Region) => region.map((poly) => poly.map(ringPath).join("")).join("");

/** Height of a capital letter as a share of the font size, near enough for any sans-serif. */
const CAP_HEIGHT = 0.714;

/** Dimension lines and figures, sized in metres so they sit on the plan as they will on paper. */
function DimensionShapes(props: { entities: Entity[]; px: number; className?: string }) {
  return (
    <g className={`dim ${props.className ?? ""}`} pointerEvents="none">
      {props.entities.map((e, i) => {
        if (e.kind === "polyline") {
          return (
            <path
              key={i}
              d={`M${e.points.map((p) => `${p.x},${p.y}`).join("L")}${e.closed ? "Z" : ""}`}
              className="dim__line"
              strokeWidth={props.px}
            />
          );
        }
        if (e.kind !== "text") return null;
        return (
          <text
            key={i}
            x={e.at.x}
            y={e.at.y}
            fontSize={e.height / CAP_HEIGHT}
            transform={e.angle ? `rotate(${(e.angle * 180) / Math.PI} ${e.at.x} ${e.at.y})` : undefined}
            className="dim__text"
          >
            {e.text}
          </text>
        );
      })}
    </g>
  );
}

/**
 * Plan symbol of a door (gap, leaf and swing arc) or a window (frame and glass
 * line), drawn in the wall's own axes: x along the wall from the first jamb,
 * y across it.
 */
function OpeningSymbol(props: {
  wall: Wall;
  opening: Pick<Opening, "kind" | "offset" | "width">;
  px: number;
  className?: string;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const { wall, opening, px } = props;
  const g = openingGeometry(wall, opening as Opening);
  const w = opening.width;
  const half = Math.max(g.thickness, 2 * px) / 2;
  const grab = Math.max(half, 7 * px);
  return (
    <g
      transform={`matrix(${g.dir.x} ${g.dir.y} ${g.normal.x} ${g.normal.y} ${g.start.x} ${g.start.y})`}
      className={`opening opening--${opening.kind} ${props.className ?? ""}`}
      pointerEvents={props.onPointerDown ? "auto" : "none"}
      onPointerDown={props.onPointerDown}
    >
      <rect x={0} y={-half} width={w} height={2 * half} className="opening__gap" strokeWidth={px} />
      {opening.kind === "door" ? (
        <>
          <path
            d={`M0 ${-half}V${half}M${w} ${-half}V${half}`}
            className="opening__line"
            strokeWidth={1.5 * px}
          />
          <path d={`M0 ${half}V${half + w}`} className="opening__line" strokeWidth={2 * px} />
          <path
            d={`M0 ${half + w}A${w} ${w} 0 0 0 ${w} ${half}`}
            className="opening__swing"
            strokeWidth={px}
          />
        </>
      ) : (
        <path d={`M0 0H${w}`} className="opening__line" strokeWidth={1.5 * px} />
      )}
      {props.onPointerDown && (
        <rect x={0} y={-grab} width={w} height={2 * grab} className="opening__hit" />
      )}
    </g>
  );
}

/** The AutoCAD-style marker of an object snap, with its name beside it. */
function SnapMarker(props: { kind: Exclude<SnapResult["kind"], "grid" | "free">; at: Pt; px: number }) {
  const { at, px } = props;
  const s = 6 * px;
  const shapes: Record<typeof props.kind, string> = {
    endpoint: `M${-s} ${-s}H${s}V${s}H${-s}Z`,
    midpoint: `M0 ${-s * 1.2}L${s * 1.1} ${s * 0.8}H${-s * 1.1}Z`,
    center: "",
    intersection: `M${-s} ${-s}L${s} ${s}M${s} ${-s}L${-s} ${s}`,
    perpendicular: `M${-s} ${-s}V${s}H${s}M${-s} 0H0V${s}`,
    nearest: `M${-s} ${-s}H${s}L${-s} ${s}H${s}Z`,
  };
  return (
    <g transform={`translate(${at.x} ${at.y})`} className="osnap" pointerEvents="none">
      {props.kind === "center" ? (
        <circle r={s} strokeWidth={2 * px} />
      ) : (
        <path d={shapes[props.kind]} strokeWidth={2 * px} />
      )}
      <text x={s * 1.8} y={s * 2.6} fontSize={11 * px} strokeWidth={3 * px} className="osnap__label">
        {SNAP_LABEL[props.kind]}
      </text>
    </g>
  );
}

export function PlanCanvas(props: Props) {
  const { storey, faceBySpaceId, tool, selection, snapStep, onChange, onSelect } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ ox: -2, oy: -2, zoom: 60 });
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [chainStart, setChainStart] = useState<Pt | null>(null);
  /** Where the door or window tool would place an opening right now. */
  const [placing, setPlacing] = useState<{ wallId: string; offset: number } | null>(null);
  /** Corners of a plot outline being drawn with the site tool. */
  const [plotDraft, setPlotDraft] = useState<Pt[]>([]);
  const [plotError, setPlotError] = useState<string | null>(null);
  /** A dimension being placed: its first point, then its second; the third click sets the line. */
  const [dimDraft, setDimDraft] = useState<{ a: Pt; b: Pt | null } | null>(null);
  /** A hall, staircase or elevator being dragged out. */
  const [rectDraft, setRectDraft] = useState<{ a: Pt; b: Pt } | null>(null);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);
  const plot = props.project.site.boundary;
  const setbacks = props.project.site.setbacks;
  const hasPlot = plot.length >= 3;
  const footprint = props.structure.footprint;
  const hasFootprint = footprint.length >= 3;
  /** Generated walls are changed through the structure, not dragged about. */
  const locked = (w: Wall) => hasFootprint && w.part !== undefined;
  const coreTool = CORE_TOOLS.includes(tool) ? (tool as CoreKind) : null;
  /** True while the pointer draws an outline: of the plot or of the building. */
  const drawingPlot = (tool === "site" && !hasPlot) || (tool === "outline" && !hasFootprint);

  useEffect(() => {
    const svg = svgRef.current!;
    const observer = new ResizeObserver(() =>
      setSize({ w: svg.clientWidth, h: svg.clientHeight }),
    );
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.w === 0 || size.h === 0) return;
    const pts = [
      ...storey.walls.flatMap((w) => [w.a, w.b]),
      ...plot,
      ...footprint,
      ...props.dimensionChains.flatMap((c) => c.spans.flatMap((s) => [s.from, s.to])),
    ];
    if (pts.length === 0) {
      setView({ ox: -1, oy: -1, zoom: 60 });
      return;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - minX);
    const h = Math.max(1, Math.max(...ys) - minY);
    const zoom = Math.min((size.w - 120) / w, (size.h - 120) / h, 160);
    setView({
      zoom,
      ox: minX - (size.w / zoom - w) / 2,
      oy: minY - (size.h / zoom - h) / 2,
    });
  }, [size, storey.walls, plot, footprint, props.dimensionChains]);

  useEffect(() => {
    if (!fitted.current && size.w > 0) {
      fitted.current = true;
      fit();
    }
  }, [size, fit]);

  // Leaving the wall tool ends the chain being drawn.
  useEffect(() => {
    if (tool !== "wall") setChainStart(null);
    setPlacing(null);
    setPlotDraft([]);
    setPlotError(null);
    setDimDraft(null);
  }, [tool, props.shape]);

  /** Closes the outline being drawn, or says why it cannot be a plot. */
  const finishPlot = (corners: Pt[]) => {
    const problem = boundaryProblem(corners);
    if (problem) {
      setPlotError(problem);
      return;
    }
    setPlotDraft([]);
    setPlotError(null);
    if (tool === "outline") props.onFootprintDrawn(corners);
    else props.onPlotDrawn(corners);
  };
  const liveDraft = useRef({ plotDraft, finishPlot });
  liveDraft.current = { plotDraft, finishPlot };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChainStart(null);
        setPlotDraft([]);
        setPlotError(null);
        setDimDraft(null);
      } else if (e.key === "Enter" && liveDraft.current.plotDraft.length > 0) {
        liveDraft.current.finishPlot(liveDraft.current.plotDraft);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Wheel zoom about the pointer. Needs a non-passive listener to stop page scroll.
  useEffect(() => {
    const svg = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const zoom = Math.max(8, Math.min(600, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        return {
          zoom,
          ox: v.ox + px / v.zoom - px / zoom,
          oy: v.oy + py / v.zoom - py / zoom,
        };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const toModel = (e: { clientX: number; clientY: number }): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: view.ox + (e.clientX - rect.left) / view.zoom,
      y: view.oy + (e.clientY - rect.top) / view.zoom,
    };
  };

  /** Everything the pointer can snap to: walls, wall faces and jambs, the plot, the outline, the core and rooms. */
  const snapGeo = useMemo<SnapGeometry>(() => {
    const rings: Pt[][] = [];
    if (plot.length >= 3) rings.push(plot);
    if (footprint.length >= 3) rings.push(footprint);
    for (const c of props.structure.core) {
      const r = coreRect(c);
      rings.push([r.min, { x: r.max.x, y: r.min.y }, r.max, { x: r.min.x, y: r.max.y }]);
    }
    const geo = snapGeometry(
      storey.walls.map((w): [Pt, Pt] => [w.a, w.b]),
      rings,
      dimensionSnapPoints(storey),
    );
    for (const face of faceBySpaceId.values()) {
      const ring = face.netOuter;
      if (ring.length < 3) continue;
      geo.centers.push({
        x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
        y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
      });
    }
    return geo;
  }, [storey.walls, storey.openings, plot, footprint, props.structure.core, faceBySpaceId]);

  /**
   * Where a point lands: on something drawn (object snap), else on the grid.
   * `from` is the last point placed, for ortho and perpendicular; Shift turns
   * ortho the other way while it is held. `exclude` is a point being dragged,
   * which must not snap to itself or to the edges that move with it.
   */
  const snapAt = (p: Pt, from: Pt | null = null, shift = false, exclude?: Pt): SnapResult => {
    const settings = shift ? { ...props.snapSettings, ortho: !props.snapSettings.ortho } : props.snapSettings;
    let geo = snapGeo;
    if (exclude) {
      geo = {
        segments: geo.segments.filter(([a, b]) => !samePoint(a, exclude) && !samePoint(b, exclude)),
        points: geo.points.filter((q) => !samePoint(q, exclude)),
        centers: geo.centers,
      };
    }
    return findSnap(p, geo, settings, SNAP_PX / view.zoom, snapStep, from);
  };
  /** Where the pointer snapped, kept for drawing its marker. */
  const [mark, setMark] = useState<SnapResult | null>(null);
  const snapMark = (r: SnapResult): Pt => {
    setMark(r);
    return r.pt;
  };
  const dimSnap = (p: Pt): Pt => snapAt(p, dimDraft?.a ?? null).pt;
  /** How far from its two points the dimension being placed would sit with the pointer at `p`. */
  const draftOffset = (a: Pt, b: Pt, p: Pt) => roundTo(offsetFromLine(a, b, p), snapStep);

  /** The shape tools draw a closed shape from two clicks; "line" draws a run of walls. */
  const shape: Shape = props.shape;
  const shapeOf = (a: Pt, b: Pt) => shapeRing(shape, a, b, props.shapeSides);

  /** While drawing, ortho (or Shift) keeps the new wall horizontal or vertical. */
  const drawPoint = (e: React.PointerEvent): Pt =>
    // Ortho would flatten a rectangle to a line, so it does not apply to its second corner.
    snapMark(snapAt(toModel(e), shape === "rectangle" ? null : chainStart, e.shiftKey));

  /** The spot on the nearest wall where the door or window tool can place its opening. */
  const placeAt = (e: { clientX: number; clientY: number }, kind: OpeningKind | "entrance") => {
    // An entrance goes in an outside wall of the building.
    const walls = kind === "entrance" ? storey.walls.filter((w) => w.part === "shell") : storey.walls;
    const hit = locateOnWall({ ...storey, walls }, toModel(e), WALL_REACH_PX / view.zoom);
    if (!hit) return null;
    const offset = fitOffset(
      storey,
      hit.wallId,
      roundTo(hit.offset, snapStep),
      (kind === "entrance" ? props.entranceSize : props.openingSize[kind]).width,
    );
    return offset === null ? null : { wallId: hit.wallId, offset };
  };

  /** While an outline is drawn, ortho (or Shift) keeps the new edge horizontal or vertical. */
  const outlinePoint = (e: React.PointerEvent): Pt =>
    snapMark(snapAt(toModel(e), shape === "rectangle" ? null : (plotDraft[plotDraft.length - 1] ?? null), e.shiftKey));

  const onBackgroundDown = (e: React.PointerEvent) => {
    const pans = tool === "select" || tool === "erker" || ((tool === "site" || tool === "outline") && !drawingPlot);
    if (e.button === 1 || (e.button === 0 && pans)) {
      svgRef.current!.setPointerCapture(e.pointerId);
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, view, moved: false };
      return;
    }
    if (e.button !== 0) return;
    if (tool === "door" || tool === "window") {
      const at = placeAt(e, tool);
      if (!at) return;
      const next = addOpening(storey, at.wallId, tool, at.offset, props.openingSize[tool]);
      if (next === storey) return;
      onChange(next, true);
      onSelect({ kind: "opening", id: next.openings[next.openings.length - 1].id });
      setPlacing(null);
      return;
    }
    if (tool === "entrance") {
      const at = placeAt(e, "entrance");
      if (!at) return;
      const next = addEntrance(storey, at.wallId, at.offset, props.entranceSize);
      if (next === storey) return;
      onChange(next, true);
      onSelect({ kind: "opening", id: next.openings[next.openings.length - 1].id });
      setPlacing(null);
      return;
    }
    if (coreTool) {
      const start = snapAt(toModel(e)).pt;
      svgRef.current!.setPointerCapture(e.pointerId);
      drag.current = { kind: "rect", core: coreTool, start };
      setRectDraft({ a: start, b: start });
      return;
    }
    if (tool === "site" || tool === "outline") {
      const p = outlinePoint(e);
      setPlotError(null);
      if (shape !== "line") {
        // Two clicks: a corner (or the centre), then the opposite corner (or a corner on the rim).
        if (plotDraft.length === 0) setPlotDraft([p]);
        else if (!samePoint(p, plotDraft[0])) finishPlot(shapeOf(plotDraft[0], p)!);
        return;
      }
      if (plotDraft.length >= 3 && dist(toModel(e), plotDraft[0]) <= SNAP_PX / view.zoom) {
        finishPlot(plotDraft);
      } else if (!plotDraft.some((q) => samePoint(q, p))) {
        setPlotDraft([...plotDraft, p]);
      }
      return;
    }
    if (tool === "dimension") {
      if (!dimDraft) {
        setDimDraft({ a: dimSnap(toModel(e)), b: null });
      } else if (!dimDraft.b) {
        const b = dimSnap(toModel(e));
        if (!samePoint(b, dimDraft.a)) setDimDraft({ a: dimDraft.a, b });
      } else {
        const next = addDimension(storey, dimDraft.a, dimDraft.b, draftOffset(dimDraft.a, dimDraft.b, toModel(e)));
        setDimDraft(null);
        if (next === storey) return;
        onChange(next, true);
        onSelect({ kind: "dimension", id: next.dimensions[next.dimensions.length - 1].id });
      }
      return;
    }
    if (tool !== "wall") return;
    const p = drawPoint(e);
    if (shape !== "line") {
      if (!chainStart) setChainStart(p);
      else if (!samePoint(p, chainStart)) {
        onChange(addWallRun(storey, shapeOf(chainStart, p)!, true, props.wallThickness, props.wallKind), true);
        setChainStart(null);
      }
      return;
    }
    if (!chainStart) {
      setChainStart(p);
    } else if (samePoint(p, chainStart)) {
      setChainStart(null); // clicking the same point twice ends the chain
    } else {
      onChange(addWall(storey, chainStart, p, props.wallThickness, props.wallKind), true);
      setChainStart(p);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      setCursor(
        tool === "wall"
          ? drawPoint(e)
          : tool === "dimension" && !dimDraft?.b
            ? snapMark(snapAt(toModel(e), dimDraft?.a ?? null, e.shiftKey))
            : coreTool
              ? snapMark(snapAt(toModel(e)))
              : drawingPlot
                ? outlinePoint(e)
                : snapPoint(toModel(e), snapStep),
      );
      if (tool !== "wall" && !drawingPlot && !coreTool && !(tool === "dimension" && !dimDraft?.b)) setMark(null);
      if (tool === "door" || tool === "window" || tool === "entrance") setPlacing(placeAt(e, tool));
      return;
    }
    if (d.kind === "rect") {
      const b = snapMark(snapAt(toModel(e)));
      setCursor(b);
      setRectDraft({ a: d.start, b });
      return;
    }
    if (d.kind === "footprintCorner") {
      const own = d.base.site.buildings.find((b) => b.id === props.buildingId)!.structure.footprint[d.index];
      const to = snapMark(snapAt(toModel(e), null, false, own));
      setCursor(to);
      if (samePoint(to, d.last, 1e-9)) return;
      const next = moveFootprintCorner(d.base, props.buildingId, d.index, to);
      // Unchanged although the corner was asked to move: the outline would cross itself.
      if (next === d.base && !samePoint(to, d.base.site.buildings.find((b) => b.id === props.buildingId)!.structure.footprint[d.index], 1e-9)) return;
      d.last = to;
      props.onProjectChange(next, !d.moved);
      d.moved = true;
      return;
    }
    if (d.kind === "pan") {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setView({ ...d.view, ox: d.view.ox - dx / d.view.zoom, oy: d.view.oy - dy / d.view.zoom });
      return;
    }
    if (d.kind === "corner") {
      const to = snapMark(snapAt(toModel(e), null, false, d.base.site.boundary[d.index]));
      setCursor(to);
      if (samePoint(to, d.last, 1e-9)) return;
      const next = moveBoundaryCorner(d.base, d.index, to);
      // Unchanged although the corner was asked to move: the outline would cross itself.
      if (next === d.base && !samePoint(to, d.base.site.boundary[d.index], 1e-9)) return;
      d.last = to;
      props.onProjectChange(next, !d.moved);
      d.moved = true;
      return;
    }
    if (d.kind === "building") {
      const p = toModel(e);
      const delta = { x: roundTo(p.x - d.start.x, snapStep), y: roundTo(p.y - d.start.y, snapStep) };
      if (samePoint(delta, d.last, 1e-9)) return;
      d.last = delta;
      props.onProjectChange(moveBuilding(d.base, props.buildingId, delta), !d.moved);
      d.moved = true;
      return;
    }
    if (d.kind === "node") {
      const to = snapMark(snapAt(toModel(e), null, false, d.from));
      setCursor(to);
      if (samePoint(to, d.last, 1e-9)) return;
      d.last = to;
      onChange(moveNode(d.base, d.from, to), !d.moved);
      d.moved = true;
      return;
    }
    if (d.kind === "opening") {
      const opening = d.base.openings.find((o) => o.id === d.id);
      const wall = d.base.walls.find((w) => w.id === opening?.wallId);
      if (!opening || !wall) return;
      const along = projectParam(toModel(e), wall.a, wall.b) * dist(wall.a, wall.b);
      const next = moveOpening(d.base, d.id, roundTo(along, snapStep));
      const offset = next.openings.find((o) => o.id === d.id)!.offset;
      if (offset === d.last) return;
      d.last = offset;
      onChange(next, !d.moved);
      d.moved = true;
      return;
    }
    const p = toModel(e);
    const delta = { x: roundTo(p.x - d.start.x, snapStep), y: roundTo(p.y - d.start.y, snapStep) };
    if (samePoint(delta, d.last, 1e-9)) return;
    d.last = delta;
    onChange(moveWall(d.base, d.id, delta), !d.moved);
    d.moved = true;
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (svgRef.current!.hasPointerCapture(e.pointerId)) {
      svgRef.current!.releasePointerCapture(e.pointerId);
    }
    if (d?.kind === "pan" && !d.moved && e.button === 0) onSelect(null);
    setMark(null);
    if (d?.kind === "rect") {
      const b = snapAt(toModel(e)).pt;
      setRectDraft(null);
      props.onCoreDrawn(d.core, d.start, b);
    }
  };

  const startWallDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ kind: "wall", id });
    svgRef.current!.setPointerCapture(e.pointerId);
    drag.current = {
      kind: "wall",
      base: storey,
      id,
      start: toModel(e),
      last: { x: 0, y: 0 },
      moved: false,
    };
  };

  const startOpeningDrag = (e: React.PointerEvent, opening: Opening) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ kind: "opening", id: opening.id });
    svgRef.current!.setPointerCapture(e.pointerId);
    drag.current = { kind: "opening", base: storey, id: opening.id, last: opening.offset, moved: false };
  };

  const startCornerDrag = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ kind: "siteCorner", index });
    svgRef.current!.setPointerCapture(e.pointerId);
    drag.current = { kind: "corner", base: props.project, index, last: plot[index], moved: false };
  };

  const startFootprintCornerDrag = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    drag.current = { kind: "footprintCorner", base: props.project, index, last: footprint[index], moved: false };
  };

  const startBuildingDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    drag.current = {
      kind: "building",
      base: props.project,
      start: toModel(e),
      last: { x: 0, y: 0 },
      moved: false,
    };
  };

  const startNodeDrag = (e: React.PointerEvent, from: Pt) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current!.setPointerCapture(e.pointerId);
    drag.current = { kind: "node", base: storey, from, last: from, moved: false };
  };

  const px = 1 / view.zoom; // one screen pixel in metres
  const minor = useMemo(
    () => [0.05, 0.1, 0.25, 0.5, 1, 5, 10].find((s) => s * view.zoom >= 9) ?? 10,
    [view.zoom],
  );
  const major = minor < 1 ? 1 : minor * 5;
  const selectedWall =
    selection?.kind === "wall" ? storey.walls.find((w) => w.id === selection.id) : undefined;
  const interactive = tool === "select";
  const preview = tool === "wall" && chainStart && cursor ? { a: chainStart, b: cursor } : null;
  const wallById = useMemo(() => new Map(storey.walls.map((w) => [w.id, w])), [storey.walls]);
  const placingKind = tool === "door" || tool === "window" || tool === "entrance" ? tool : null;
  const placingWall = placing && placingKind ? wallById.get(placing.wallId) : undefined;
  const placingWidth =
    placingKind === "entrance" ? props.entranceSize.width : placingKind ? props.openingSize[placingKind].width : 0;
  // The map under the plan: the tiles that cover the view, turned so that north is where the plan has it.
  const mapTiles = useMemo(() => {
    if (!props.map || size.w === 0) return [];
    const a = (-props.north * Math.PI) / 180;
    const corners = [
      { x: view.ox, y: view.oy },
      { x: view.ox + size.w / view.zoom, y: view.oy },
      { x: view.ox + size.w / view.zoom, y: view.oy + size.h / view.zoom },
      { x: view.ox, y: view.oy + size.h / view.zoom },
    ].map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
    const { origin, settings } = props.map;
    return tilesForPlan(
      origin,
      tileZoomFor(origin.lat, view.zoom, settings.maxZoom),
      {
        minX: Math.min(...corners.map((p) => p.x)),
        minY: Math.min(...corners.map((p) => p.y)),
        maxX: Math.max(...corners.map((p) => p.x)),
        maxY: Math.max(...corners.map((p) => p.y)),
      },
      settings.tileUrl,
    );
  }, [props.map, props.north, view, size]);
  /** A rectangle, polygon or circle being drawn as an outline, closed. */
  const draftShape =
    drawingPlot && shape !== "line" && plotDraft.length === 1 && cursor && !samePoint(cursor, plotDraft[0])
      ? shapeOf(plotDraft[0], cursor)
      : null;
  const draftRing = draftShape
    ? draftShape
    : drawingPlot && plotDraft.length > 0
      ? [...plotDraft, ...(cursor ? [cursor] : [])]
      : [];
  /** Walls of a rectangle, polygon or circle being drawn with the wall tool. */
  const shapePreview =
    preview && shape !== "line" && !samePoint(preview.a, preview.b) ? shapeOf(preview.a, preview.b) : null;
  const draftRect = rectDraft && coreRect(rectDraft);
  const siteTool = tool === "site";
  const dimScale = props.dimensionStyle.screenScale;
  const [autoDims, ownDims] = useMemo(() => {
    const own = props.dimensionChains.filter((c) => c.kind === "own");
    const auto = props.dimensionChains.filter((c) => c.kind !== "own");
    return [
      chainEntities(auto, props.dimensionStyle, dimScale),
      own.map((chain) => ({ chain, entities: chainEntities([chain], props.dimensionStyle, dimScale) })),
    ];
  }, [props.dimensionChains, props.dimensionStyle, dimScale]);
  const draftChain =
    dimDraft?.b && cursor
      ? ownChain({ id: "draft", a: dimDraft.a, b: dimDraft.b, offset: draftOffset(dimDraft.a, dimDraft.b, cursor) })
      : null;
  /** Which side of its edges the inside of the plot is on: 1 for left, -1 for right. */
  const plotSide = useMemo(() => (ringSignedArea(plot) >= 0 ? 1 : -1), [plot]);

  return (
    <svg
      ref={svgRef}
      className={`plan plan--${tool}${drawingPlot || coreTool || tool === "entrance" ? " plan--draw" : ""}`}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        if (drag.current) return;
        setCursor(null);
        setMark(null);
        setPlacing(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setChainStart(null);
        setPlotDraft([]);
        setPlotError(null);
        setDimDraft(null);
      }}
    >
      <defs>
        <pattern id="grid-minor" width={minor} height={minor} patternUnits="userSpaceOnUse">
          <path d={`M${minor} 0H0V${minor}`} className="grid-line grid-line--minor" strokeWidth={px} />
        </pattern>
        <pattern id="grid-major" width={major} height={major} patternUnits="userSpaceOnUse">
          <path d={`M${major} 0H0V${major}`} className="grid-line grid-line--major" strokeWidth={px} />
        </pattern>
      </defs>
      <g transform={`scale(${view.zoom}) translate(${-view.ox} ${-view.oy})`}>
        {[`grid-minor`, `grid-major`].map((id) => (
          <rect
            key={id}
            x={view.ox}
            y={view.oy}
            width={size.w * px}
            height={size.h * px}
            fill={`url(#${id})`}
            pointerEvents="none"
          />
        ))}
        {mapTiles.length > 0 && (
          <g transform={`rotate(${props.north})`} className="map-underlay" pointerEvents="none">
            {mapTiles.map((t) => (
              <image
                key={t.key}
                href={t.url}
                x={t.x}
                y={t.y}
                width={t.size + px}
                height={t.size + px}
                preserveAspectRatio="none"
              />
            ))}
          </g>
        )}
        <path d={`M${-12 * px} 0H${12 * px}M0 ${-12 * px}V${12 * px}`} className="origin" strokeWidth={px} />
        {hasPlot && <path d={ringPath(plot)} className="plot-fill" pointerEvents="none" />}

        {storey.spaces.map((space) => {
          const face = faceBySpaceId.get(space.id);
          if (!face) return null;
          const selected = selection?.kind === "space" && selection.id === space.id;
          const flagged = props.flaggedSpaceIds.has(space.id);
          return (
            <path
              key={space.id}
              d={[face.netOuter, ...face.netHoles].map(ringPath).join("")}
              fillRule="evenodd"
              className={`room room--${space.type}${selected ? " is-selected" : ""}${flagged ? " is-flagged" : ""}`}
              strokeWidth={selected || flagged ? 2 * px : 0}
              pointerEvents={interactive ? "auto" : "none"}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                onSelect({ kind: "space", id: space.id });
              }}
            />
          );
        })}

        {storey.spaces.map((space) => {
          const face = faceBySpaceId.get(space.id);
          const tag = props.apartmentBySpaceId.get(space.id);
          if (!face || !tag) return null;
          return (
            <path
              key={space.id}
              d={[face.netOuter, ...face.netHoles].map(ringPath).join("")}
              fillRule="evenodd"
              className="apartment-tint"
              fill={tag.color}
              stroke={tag.color}
              strokeWidth={2.5 * px}
              pointerEvents="none"
            />
          );
        })}

        {props.underlay.map((w) => (
          <line
            key={w.id}
            x1={w.a.x}
            y1={w.a.y}
            x2={w.b.x}
            y2={w.b.y}
            strokeWidth={Math.max(w.thickness, 2 * px)}
            strokeLinecap="square"
            className="wall-underlay"
            pointerEvents="none"
          />
        ))}

        {storey.walls.map((w) => (
          <line
            key={w.id}
            x1={w.a.x}
            y1={w.a.y}
            x2={w.b.x}
            y2={w.b.y}
            strokeWidth={Math.max(w.thickness, 2 * px)}
            strokeLinecap="square"
            className={`wall wall--${w.kind}${selectedWall?.id === w.id ? " is-selected" : ""}`}
            pointerEvents="none"
          />
        ))}
        {/* Wider invisible lines so thin walls are easy to grab. */}
        {interactive &&
          storey.walls.filter((w) => !locked(w)).map((w) => (
            <line
              key={w.id}
              x1={w.a.x}
              y1={w.a.y}
              x2={w.b.x}
              y2={w.b.y}
              strokeWidth={Math.max(w.thickness, 12 * px)}
              className="wall-hit"
              onPointerDown={(e) => startWallDrag(e, w.id)}
            />
          ))}

        {storey.openings.map((o) => {
          const wall = wallById.get(o.wallId);
          if (!wall) return null;
          const selected = selection?.kind === "opening" && selection.id === o.id;
          return (
            <OpeningSymbol
              key={o.id}
              wall={wall}
              opening={o}
              px={px}
              className={selected ? "is-selected" : ""}
              onPointerDown={interactive ? (e) => startOpeningDrag(e, o) : undefined}
            />
          );
        })}
        {placing && placingWall && placingKind && (
          <OpeningSymbol
            wall={placingWall}
            opening={{
              kind: placingKind === "entrance" ? "door" : placingKind,
              offset: placing.offset,
              width: placingWidth,
            }}
            px={px}
            className="is-preview"
          />
        )}

        {storey.spaces.map((space) => {
          if (!faceBySpaceId.has(space.id)) return null;
          const tag = props.apartmentBySpaceId.get(space.id);
          return (
            <text
              key={space.id}
              x={space.anchor.x}
              y={space.anchor.y}
              fontSize={12 * px}
              className="room-label"
              pointerEvents="none"
            >
              <tspan x={space.anchor.x} dy={-3 * px} className="room-label__name">
                {space.name}
              </tspan>
              <tspan x={space.anchor.x} dy={15 * px}>
                {props.areaLabel(space.id)}
              </tspan>
              {tag && (
                <tspan x={space.anchor.x} dy={14 * px} fontSize={10.5 * px} fill={tag.color}>
                  {tag.name}
                </tspan>
              )}
            </text>
          );
        })}

        {props.coreGhosts.map((g) => (
          <path
            key={g.key}
            d={ringPath(g.outline)}
            strokeWidth={(g.bad ? 2 : 1.25) * px}
            strokeDasharray={`${6 * px} ${4 * px}`}
            className={`core-ghost${g.bad ? " is-bad" : ""}`}
            pointerEvents="none"
          >
            <title>{g.label}</title>
          </path>
        ))}

        {storey.openings.map((o) => {
          const wall = wallById.get(o.wallId);
          if (!o.entrance || !wall) return null;
          const g = openingGeometry(wall, o);
          const out = props.outline.length >= 3 ? outsideSign(props.outline, g.centre, g.normal) : 1;
          // Clear of the wall, and of the door leaf where it swings to the outside.
          const reach = g.thickness / 2 + (out === 1 ? o.width : 0) + 8 * px;
          const tip = { x: g.centre.x + g.normal.x * out * reach, y: g.centre.y + g.normal.y * out * reach };
          const back = { x: tip.x + g.normal.x * out * 12 * px, y: tip.y + g.normal.y * out * 12 * px };
          const label = { x: tip.x + g.normal.x * out * 26 * px, y: tip.y + g.normal.y * out * 26 * px };
          return (
            <g key={o.id} className="entrance-mark" pointerEvents="none">
              <path
                d={`M${tip.x},${tip.y}L${back.x + g.dir.x * 7 * px},${back.y + g.dir.y * 7 * px}L${back.x - g.dir.x * 7 * px},${back.y - g.dir.y * 7 * px}Z`}
              />
              <text x={label.x} y={label.y} fontSize={11 * px}>
                Entrance
              </text>
            </g>
          );
        })}

        {props.erkerOutline && (
          <path
            d={ringPath(props.erkerOutline)}
            className="erker-outline"
            strokeWidth={1.5 * px}
            strokeDasharray={`${7 * px} ${4 * px}`}
            pointerEvents="none"
          >
            <title>Outline of the storeys above (erker)</title>
          </path>
        )}

        {hasFootprint && tool === "outline" && (
          <g className="footprint">
            <path d={ringPath(footprint)} className="footprint__ring" strokeWidth={2 * px} pointerEvents="none" />
            {footprint.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={6 * px}
                strokeWidth={1.5 * px}
                className="handle"
                onPointerDown={(e) => startFootprintCornerDrag(e, i)}
              />
            ))}
          </g>
        )}

        {hasFootprint && tool === "erker" && (
          <g className="footprint">
            {footprint.map((a, i) => {
              const b = footprint[(i + 1) % footprint.length];
              const on = props.structure.erker.edges[i] === true;
              return (
                <g key={i}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    strokeWidth={(on ? 4 : 2) * px}
                    className={`footprint__side${on ? " is-on" : ""}`}
                    pointerEvents="none"
                  />
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    strokeWidth={16 * px}
                    className="site__edge-hit"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      props.onProjectChange(setErkerEdge(props.project, props.buildingId, i), true);
                    }}
                  >
                    <title>{on ? "This side has the erker: click to switch it off" : "Click to give this side the erker"}</title>
                  </line>
                </g>
              );
            })}
          </g>
        )}

        {draftRect && coreTool && (
          <g pointerEvents="none">
            <rect
              x={draftRect.min.x}
              y={draftRect.min.y}
              width={draftRect.max.x - draftRect.min.x}
              height={draftRect.max.y - draftRect.min.y}
              strokeWidth={2 * px}
              className={`core-draft${
                draftRect.max.x - draftRect.min.x < MIN_CORE_SIZE || draftRect.max.y - draftRect.min.y < MIN_CORE_SIZE
                  ? " is-small"
                  : ""
              }`}
            />
            <text
              x={(draftRect.min.x + draftRect.max.x) / 2}
              y={draftRect.min.y - 8 * px}
              fontSize={12 * px}
              className="dimension"
            >
              {CORE_LABEL[coreTool]} {(draftRect.max.x - draftRect.min.x).toFixed(2)} × {(draftRect.max.y - draftRect.min.y).toFixed(2)} m
            </text>
          </g>
        )}

        {/* The plot: outline, buildable area, footprint and where the building breaks a limit. */}
        {hasPlot && (
          <g className={`site${siteTool ? " is-active" : ""}`}>
            <path
              d={regionPath(props.site.buildable)}
              fillRule="evenodd"
              className="site__buildable"
              strokeWidth={1.25 * px}
              strokeDasharray={`${8 * px} ${5 * px}`}
              pointerEvents="none"
            />
            <path
              d={regionPath(props.site.footprint)}
              fillRule="evenodd"
              className="site__footprint"
              strokeWidth={1.25 * px}
              strokeDasharray={`${2 * px} ${3 * px}`}
              pointerEvents={siteTool ? "auto" : "none"}
              onPointerDown={siteTool ? startBuildingDrag : undefined}
            >
              {siteTool && <title>Building footprint: drag to move the building</title>}
            </path>
            {[props.site.insideSetback, props.site.outsidePlot].map((region, i) => (
              <path
                key={i}
                d={regionPath(region)}
                fillRule="evenodd"
                className="site__violation"
                strokeWidth={1.5 * px}
                pointerEvents="none"
              />
            ))}
            <path d={ringPath(plot)} className="site__plot" strokeWidth={2 * px} pointerEvents="none" />
            {plot.map((a, i) => {
              const b = plot[(i + 1) % plot.length];
              const selected = selection?.kind === "siteEdge" && selection.index === i;
              const len = dist(a, b) || 1;
              // The setback is written a little inside the plot, beside the middle of the edge.
              const mx = (a.x + b.x) / 2 - ((b.y - a.y) / len) * plotSide * 12 * px;
              const my = (a.y + b.y) / 2 + ((b.x - a.x) / len) * plotSide * 12 * px;
              return (
                <g key={i}>
                  {selected && (
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className="site__edge-selected"
                      strokeWidth={4 * px}
                      pointerEvents="none"
                    />
                  )}
                  {siteTool && (
                    <>
                      <line
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        strokeWidth={14 * px}
                        className="site__edge-hit"
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          onSelect({ kind: "siteEdge", index: i });
                        }}
                      />
                      <text x={mx} y={my} fontSize={11 * px} className="site__setback" pointerEvents="none">
                        {(setbacks[i] ?? 0).toFixed(2)}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
            {siteTool &&
              plot.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={6 * px}
                  strokeWidth={1.5 * px}
                  className={`handle${selection?.kind === "siteCorner" && selection.index === i ? " is-selected" : ""}`}
                  onPointerDown={(e) => startCornerDrag(e, i)}
                />
              ))}
          </g>
        )}
        {draftRing.length > 0 && (
          <g pointerEvents="none">
            {draftRing.length >= 3 && <path d={ringPath(draftRing)} className="draft-fill" />}
            <path
              d={`M${draftRing.map((p) => `${p.x},${p.y}`).join("L")}${draftShape ? "Z" : ""}`}
              className={`site__plot site__plot--draft${tool === "outline" ? " is-building" : ""}`}
              strokeWidth={2 * px}
            />
            {cursor && (
              <text
                x={(plotDraft[plotDraft.length - 1].x + cursor.x) / 2}
                y={(plotDraft[plotDraft.length - 1].y + cursor.y) / 2 - 10 * px}
                fontSize={12 * px}
                className="dimension"
              >
                {dist(plotDraft[plotDraft.length - 1], cursor).toFixed(2)} m
              </text>
            )}
            {plotDraft.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={(i === 0 ? 6 : 3.5) * px}
                strokeWidth={1.5 * px}
                className="handle"
              />
            ))}
          </g>
        )}

        {selectedWall &&
          interactive &&
          !locked(selectedWall) &&
          [selectedWall.a, selectedWall.b]
            // A corner shared with a generated wall stays where the structure put it.
            .filter((p) => !storey.walls.some((w) => locked(w) && (samePoint(w.a, p) || samePoint(w.b, p))))
            .map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={6 * px}
              strokeWidth={1.5 * px}
              className="handle"
              onPointerDown={(e) => startNodeDrag(e, p)}
            />
          ))}

        <DimensionShapes entities={props.annotationEntities} px={px} className="dim--tags" />
        <DimensionShapes entities={autoDims} px={px} />
        {ownDims.map(({ chain, entities }) => {
          const selected = selection?.kind === "dimension" && selection.id === chain.id;
          const span = chain.spans[0];
          return (
            <g key={chain.id}>
              <DimensionShapes entities={entities} px={px} className={selected ? "is-selected" : "dim--own"} />
              {interactive && (
                <line
                  x1={span.from.x}
                  y1={span.from.y}
                  x2={span.to.x}
                  y2={span.to.y}
                  strokeWidth={12 * px}
                  className="dim__hit"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    onSelect({ kind: "dimension", id: chain.id! });
                  }}
                />
              )}
            </g>
          );
        })}
        {dimDraft && !dimDraft.b && cursor && (
          <>
            <line
              x1={dimDraft.a.x}
              y1={dimDraft.a.y}
              x2={cursor.x}
              y2={cursor.y}
              strokeWidth={px}
              className="dim__draft"
              pointerEvents="none"
            />
            <text
              x={(dimDraft.a.x + cursor.x) / 2}
              y={(dimDraft.a.y + cursor.y) / 2 - 10 * px}
              fontSize={12 * px}
              className="dimension"
              pointerEvents="none"
            >
              {formatDimension(dist(dimDraft.a, cursor), props.dimensionStyle)} {props.dimensionStyle.unit}
            </text>
          </>
        )}
        {draftChain && (
          <DimensionShapes
            entities={chainEntities([draftChain], props.dimensionStyle, dimScale)}
            px={px}
            className="is-selected"
          />
        )}

        {shapePreview && preview && (
          <>
            <path
              d={`${ringPath(shapePreview)}`}
              strokeWidth={Math.max(props.wallThickness, 2 * px)}
              strokeLinejoin="miter"
              className="wall wall--preview wall--shape"
              pointerEvents="none"
            />
            <line
              x1={preview.a.x}
              y1={preview.a.y}
              x2={preview.b.x}
              y2={preview.b.y}
              strokeWidth={px}
              strokeDasharray={`${4 * px} ${3 * px}`}
              className="dim__draft"
              pointerEvents="none"
            />
            <text
              x={(preview.a.x + preview.b.x) / 2}
              y={(preview.a.y + preview.b.y) / 2 - 10 * px}
              fontSize={12 * px}
              className="dimension"
              pointerEvents="none"
            >
              {shape === "rectangle"
                ? `${Math.abs(preview.b.x - preview.a.x).toFixed(2)} × ${Math.abs(preview.b.y - preview.a.y).toFixed(2)} m`
                : `R ${dist(preview.a, preview.b).toFixed(2)} m`}
            </text>
          </>
        )}
        {preview && !shapePreview && shape === "line" && (
          <>
            <line
              x1={preview.a.x}
              y1={preview.a.y}
              x2={preview.b.x}
              y2={preview.b.y}
              strokeWidth={Math.max(props.wallThickness, 2 * px)}
              strokeLinecap="square"
              className="wall wall--preview"
              pointerEvents="none"
            />
            <text
              x={(preview.a.x + preview.b.x) / 2}
              y={(preview.a.y + preview.b.y) / 2 - 10 * px}
              fontSize={12 * px}
              className="dimension"
              pointerEvents="none"
            >
              {dist(preview.a, preview.b).toFixed(2)} m
            </text>
          </>
        )}
        {mark && cursor && mark.kind !== "grid" && mark.kind !== "free" ? (
          <SnapMarker kind={mark.kind} at={mark.pt} px={px} />
        ) : (
          (tool === "wall" || drawingPlot || coreTool || (tool === "dimension" && !dimDraft?.b)) &&
          cursor && (
            <circle cx={cursor.x} cy={cursor.y} r={4 * px} strokeWidth={1.5 * px} className="snap-dot" pointerEvents="none" />
          )
        )}
      </g>

      <g className="plan-overlay">
        <g transform={`translate(${size.w - 38} 84) rotate(${props.north})`} className="north">
          <title>North</title>
          <path d="M0 16V-8" className="north__shaft" />
          <path d="M0 -18L-5 -6H5Z" className="north__head" />
          <text x={0} y={-22} textAnchor="middle">
            N
          </text>
        </g>
        <text x={12} y={size.h - 12}>
          {cursor ? `x ${cursor.x.toFixed(2)}   y ${cursor.y.toFixed(2)} m` : ""}
        </text>
        {plotError && (
          <text x={12} y={size.h - 30} className="plan-overlay__error">
            {plotError} Keep clicking corners, or press Esc to start again.
          </text>
        )}
        {!plotError && draftRing.length >= 3 && (
          <text x={12} y={size.h - 30} className="plan-overlay__area">
            {tool === "outline" ? "Base area" : "Plot area"} {ringArea(draftRing).toFixed(2)} m²
          </text>
        )}
        {mapTiles.length > 0 && (
          <text x={size.w / 2} y={size.h - 12} textAnchor="middle">
            {props.map!.settings.attribution}
          </text>
        )}
        <text x={size.w - 12} y={size.h - 12} textAnchor="end">
          grid {minor} m · snap {snapStep} m
        </text>
      </g>
      <foreignObject x={size.w - 64} y={12} width={52} height={32}>
        <button className="fit-button" onPointerDown={(e) => e.stopPropagation()} onClick={fit}>
          Fit
        </button>
      </foreignObject>
    </svg>
  );
}
