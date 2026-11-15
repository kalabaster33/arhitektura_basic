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
import { addWall, moveNode, moveWall } from "../core/edit.ts";
import {
  type Pt,
  dist,
  projectParam,
  ringSignedArea,
  roundTo,
  samePoint,
  snapPoint,
} from "../core/geometry.ts";
import type { Opening, OpeningKind, Project, Storey, Wall, WallKind } from "../core/model.ts";
import {
  type OpeningSize,
  addOpening,
  fitOffset,
  locateOnWall,
  moveOpening,
  openingGeometry,
} from "../core/openings.ts";
import { type Region, type SiteAnalysis, boundaryProblem, moveBoundaryCorner } from "../core/site.ts";
import type { Face } from "../core/topology.ts";

export type Tool = "select" | "wall" | "door" | "window" | "dimension" | "site";
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
  /** A plot outline drawn with the site tool, already checked. */
  onPlotDrawn: (corners: Pt[]) => void;
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
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);
  const plot = props.project.site.boundary;
  const setbacks = props.project.site.setbacks;
  const hasPlot = plot.length >= 3;

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
  }, [size, storey.walls, plot, props.dimensionChains]);

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
  }, [tool]);

  /** Closes the outline being drawn, or says why it cannot be a plot. */
  const finishPlot = (corners: Pt[]) => {
    const problem = boundaryProblem(corners);
    if (problem) {
      setPlotError(problem);
      return;
    }
    setPlotDraft([]);
    setPlotError(null);
    props.onPlotDrawn(corners);
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

  /** Snap to a nearby wall end first, then to the grid. */
  const snap = (p: Pt, walls = storey.walls, exclude?: Pt): Pt => {
    let best: Pt | null = null;
    let bestD = SNAP_PX / view.zoom;
    for (const w of walls) {
      for (const q of [w.a, w.b]) {
        if (exclude && samePoint(q, exclude)) continue;
        const d = dist(p, q);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
    }
    return best ?? snapPoint(p, snapStep);
  };

  /** For the dimension tool: a nearby wall corner, opening jamb or wall end, else the grid. */
  const snapPoints = useMemo(
    () => (tool === "dimension" ? dimensionSnapPoints(storey) : []),
    [tool, storey.walls, storey.openings],
  );
  const dimSnap = (p: Pt): Pt => {
    let best: Pt | null = null;
    let bestD = SNAP_PX / view.zoom;
    for (const q of snapPoints) {
      const d = dist(p, q);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return best ?? snapPoint(p, snapStep);
  };
  /** How far from its two points the dimension being placed would sit with the pointer at `p`. */
  const draftOffset = (a: Pt, b: Pt, p: Pt) => roundTo(offsetFromLine(a, b, p), snapStep);

  /** While drawing, Shift keeps the new wall horizontal or vertical. */
  const drawPoint = (e: React.PointerEvent): Pt => {
    const p = snap(toModel(e));
    if (!chainStart || !e.shiftKey) return p;
    return Math.abs(p.x - chainStart.x) >= Math.abs(p.y - chainStart.y)
      ? { x: p.x, y: chainStart.y }
      : { x: chainStart.x, y: p.y };
  };

  /** The spot on the nearest wall where the door or window tool can place its opening. */
  const placeAt = (e: { clientX: number; clientY: number }, kind: OpeningKind) => {
    const hit = locateOnWall(storey, toModel(e), WALL_REACH_PX / view.zoom);
    if (!hit) return null;
    const offset = fitOffset(
      storey,
      hit.wallId,
      roundTo(hit.offset, snapStep),
      props.openingSize[kind].width,
    );
    return offset === null ? null : { wallId: hit.wallId, offset };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && (tool === "select" || (tool === "site" && hasPlot)))) {
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
    if (tool === "site") {
      const p = snapPoint(toModel(e), snapStep);
      setPlotError(null);
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
            ? dimSnap(toModel(e))
            : snapPoint(toModel(e), snapStep),
      );
      if (tool === "door" || tool === "window") setPlacing(placeAt(e, tool));
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
      const to = snapPoint(toModel(e), snapStep);
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
      const to = snap(toModel(e), d.base.walls, d.from);
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
  const placingKind = tool === "door" || tool === "window" ? tool : null;
  const placingWall = placing && placingKind ? wallById.get(placing.wallId) : undefined;
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
  const drawingPlot = siteTool && !hasPlot;
  /** Which side of its edges the inside of the plot is on: 1 for left, -1 for right. */
  const plotSide = useMemo(() => (ringSignedArea(plot) >= 0 ? 1 : -1), [plot]);

  return (
    <svg
      ref={svgRef}
      className={`plan plan--${tool}`}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => {
        if (drag.current) return;
        setCursor(null);
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
          storey.walls.map((w) => (
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
              kind: placingKind,
              offset: placing.offset,
              width: props.openingSize[placingKind].width,
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
        {drawingPlot && plotDraft.length > 0 && (
          <g pointerEvents="none">
            <path
              d={`M${[...plotDraft, ...(cursor ? [cursor] : [])].map((p) => `${p.x},${p.y}`).join("L")}`}
              className="site__plot site__plot--draft"
              strokeWidth={2 * px}
            />
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
          [selectedWall.a, selectedWall.b].map((p, i) => (
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

        {preview && (
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
        {(tool === "wall" || drawingPlot || (tool === "dimension" && !dimDraft?.b)) && cursor && (
          <circle cx={cursor.x} cy={cursor.y} r={4 * px} strokeWidth={1.5 * px} className="snap-dot" pointerEvents="none" />
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
