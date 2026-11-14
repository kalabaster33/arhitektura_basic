import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addWall, moveNode, moveWall } from "../core/edit.ts";
import { type Pt, dist, roundTo, samePoint, snapPoint } from "../core/geometry.ts";
import type { Storey, WallKind } from "../core/model.ts";
import type { Face } from "../core/topology.ts";

export type Tool = "select" | "wall";
export type Selection = { kind: "wall" | "space"; id: string } | null;

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
  | { kind: "wall"; base: Storey; id: string; start: Pt; last: Pt; moved: boolean };

const SNAP_PX = 10;

const ringPath = (ring: Pt[]) =>
  ring.length ? `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z` : "";

export function PlanCanvas(props: Props) {
  const { storey, faceBySpaceId, tool, selection, snapStep, onChange, onSelect } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ ox: -2, oy: -2, zoom: 60 });
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [chainStart, setChainStart] = useState<Pt | null>(null);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);

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
    const pts = storey.walls.flatMap((w) => [w.a, w.b]);
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
  }, [size, storey.walls]);

  useEffect(() => {
    if (!fitted.current && size.w > 0) {
      fitted.current = true;
      fit();
    }
  }, [size, fit]);

  // Leaving the wall tool ends the chain being drawn.
  useEffect(() => {
    if (tool !== "wall") setChainStart(null);
  }, [tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChainStart(null);
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

  /** While drawing, Shift keeps the new wall horizontal or vertical. */
  const drawPoint = (e: React.PointerEvent): Pt => {
    const p = snap(toModel(e));
    if (!chainStart || !e.shiftKey) return p;
    return Math.abs(p.x - chainStart.x) >= Math.abs(p.y - chainStart.y)
      ? { x: p.x, y: chainStart.y }
      : { x: chainStart.x, y: p.y };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && tool === "select")) {
      svgRef.current!.setPointerCapture(e.pointerId);
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, view, moved: false };
      return;
    }
    if (e.button !== 0 || tool !== "wall") return;
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
      setCursor(tool === "wall" ? drawPoint(e) : snapPoint(toModel(e), snapStep));
      return;
    }
    if (d.kind === "pan") {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      setView({ ...d.view, ox: d.view.ox - dx / d.view.zoom, oy: d.view.oy - dy / d.view.zoom });
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

  return (
    <svg
      ref={svgRef}
      className={`plan plan--${tool}`}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => !drag.current && setCursor(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setChainStart(null);
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

        {storey.spaces.map((space) => {
          const face = faceBySpaceId.get(space.id);
          if (!face) return null;
          const selected = selection?.kind === "space" && selection.id === space.id;
          return (
            <path
              key={space.id}
              d={[face.netOuter, ...face.netHoles].map(ringPath).join("")}
              fillRule="evenodd"
              className={`room room--${space.type}${selected ? " is-selected" : ""}`}
              strokeWidth={selected ? 2 * px : 0}
              pointerEvents={interactive ? "auto" : "none"}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                onSelect({ kind: "space", id: space.id });
              }}
            />
          );
        })}

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

        {storey.spaces.map((space) => {
          if (!faceBySpaceId.has(space.id)) return null;
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
            </text>
          );
        })}

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
        {tool === "wall" && cursor && (
          <circle cx={cursor.x} cy={cursor.y} r={4 * px} strokeWidth={1.5 * px} className="snap-dot" pointerEvents="none" />
        )}
      </g>

      <g className="plan-overlay">
        <text x={12} y={size.h - 12}>
          {cursor ? `x ${cursor.x.toFixed(2)}   y ${cursor.y.toFixed(2)} m` : ""}
        </text>
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
