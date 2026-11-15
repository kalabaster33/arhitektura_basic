/**
 * Annotations of a plan other than dimensions: a size tag at every door and
 * window, the floor level mark, and the north arrow. All worked out from the
 * model every time; nothing here is stored.
 *
 * Pure functions, no UI imports. How they look comes from a config
 * (src/config/annotationStyle.json). Coordinates are the model's: metres, y down.
 */
import { type DimensionUnit, formatDimension, textFrame } from "./dimensions.ts";
import type { Entity } from "./drawing.ts";
import { type Pt, pointInPolygon } from "./geometry.ts";
import type { Annotations, Opening, Storey } from "./model.ts";
import { openingGeometry, openingSides } from "./openings.ts";
import { type LinkedSpaces, linkSpaces } from "./spaces.ts";

export interface AnnotationStyle {
  tagUnit: DimensionUnit;
  tagDecimals: number;
  /** Written before the sill height in a window tag. */
  sillPrefix: string;
  tagTextHeightMm: number;
  tagGapMm: number;
  levelTextHeightMm: number;
  levelSymbolMm: number;
  levelOffsetMm: number;
  northArrowMm: number;
}

/** Checks a config loaded from JSON; throws with the offending key. */
export function parseAnnotationStyle(raw: unknown): AnnotationStyle {
  const c = raw as AnnotationStyle;
  const fail = (key: string): never => {
    throw new Error(`Annotation style: invalid or missing "${key}".`);
  };
  if (!c || typeof c !== "object") fail("(root)");
  if (!["mm", "cm", "m"].includes(c.tagUnit)) fail("tagUnit");
  if (!Number.isInteger(c.tagDecimals) || c.tagDecimals < 0 || c.tagDecimals > 4) fail("tagDecimals");
  if (typeof c.sillPrefix !== "string") fail("sillPrefix");
  const sizes = [
    "tagTextHeightMm",
    "tagGapMm",
    "levelTextHeightMm",
    "levelSymbolMm",
    "levelOffsetMm",
    "northArrowMm",
  ] as const;
  for (const key of sizes) {
    if (typeof c[key] !== "number" || !Number.isFinite(c[key]) || c[key] <= 0) fail(key);
  }
  return {
    tagUnit: c.tagUnit,
    tagDecimals: c.tagDecimals,
    sillPrefix: c.sillPrefix,
    tagTextHeightMm: c.tagTextHeightMm,
    tagGapMm: c.tagGapMm,
    levelTextHeightMm: c.levelTextHeightMm,
    levelSymbolMm: c.levelSymbolMm,
    levelOffsetMm: c.levelOffsetMm,
    northArrowMm: c.northArrowMm,
  };
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------------- tags

/** What is written beside an opening: width/height, and for a window its sill height. */
export function openingTag(
  opening: Pick<Opening, "kind" | "width" | "height" | "sill">,
  style: Pick<AnnotationStyle, "tagUnit" | "tagDecimals" | "sillPrefix">,
): string {
  const f = (v: number) => formatDimension(v, { unit: style.tagUnit, decimals: style.tagDecimals });
  const size = `${f(opening.width)}/${f(opening.height)}`;
  return opening.kind === "window" ? `${size} ${style.sillPrefix}${f(opening.sill)}` : size;
}

/**
 * A tag at every door and window, written along its wall just off the wall
 * face. A door's tag is on the side away from its swing; a window's is on the
 * room side, so it stays clear of the dimension chains outside.
 */
export function openingTags(
  storey: Storey,
  style: AnnotationStyle,
  scale: number,
  linked: LinkedSpaces = linkSpaces(storey),
): Entity[] {
  const mm = scale / 1000;
  const h = style.tagTextHeightMm * mm;
  const out: Entity[] = [];
  for (const o of storey.openings) {
    const wall = storey.walls.find((w) => w.id === o.wallId);
    if (!wall || o.width <= 0) continue;
    const g = openingGeometry(wall, o);
    let side = -1; // a door swings to the side its wall's normal points to
    if (o.kind === "window") {
      const rooms = openingSides(storey, o, linked);
      side = rooms[0] !== null || rooms[1] === null ? 1 : -1;
    }
    const off = (g.thickness / 2 + style.tagGapMm * mm + h / 2) * side;
    const end = { x: g.centre.x + g.dir.x, y: g.centre.y + g.dir.y };
    out.push({
      kind: "text",
      layer: "tags",
      at: { x: round(g.centre.x + g.normal.x * off), y: round(g.centre.y + g.normal.y * off) },
      text: openingTag(o, style),
      height: h,
      angle: textFrame(g.centre, end).angle,
    });
  }
  return out;
}

// --------------------------------------------------------------- level marks

/** A floor level as it is written on a plan: ±0.00, +3.00, -1.50. */
export function formatLevel(elevation: number): string {
  const v = Math.round(elevation * 100) / 100;
  if (v === 0) return "±0.00";
  return `${v > 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}`;
}

/**
 * The floor level of the storey, marked once: a small triangle and the level,
 * above the label of the largest room. Left out when there is no room, or no
 * space for it inside that room.
 */
export function levelMark(
  storey: Storey,
  style: AnnotationStyle,
  scale: number,
  linked: LinkedSpaces = linkSpaces(storey),
): Entity[] {
  const mm = scale / 1000;
  let best: { anchor: Pt; area: number; inside: (p: Pt) => boolean } | null = null;
  for (const space of storey.spaces) {
    const face = linked.faceBySpaceId.get(space.id);
    if (!face || face.netArea <= 0) continue;
    if (!best || face.netArea > best.area) {
      best = {
        anchor: space.anchor,
        area: face.netArea,
        inside: (p) => pointInPolygon(p, face.netOuter, face.netHoles),
      };
    }
  }
  if (!best) return [];
  const h = style.levelTextHeightMm * mm;
  const s = style.levelSymbolMm * mm;
  const text = formatLevel(storey.elevation);
  const gap = h * 0.4;
  const textWidth = text.length * h * 0.6;
  const total = s + gap + textWidth;
  const y = best.anchor.y - style.levelOffsetMm * mm;
  const left = best.anchor.x - total / 2;
  // The whole mark has to be in the room.
  const corners = [
    { x: left, y },
    { x: left + total, y },
    { x: left, y: y - s },
    { x: left + total, y: y - s },
  ];
  if (!corners.every(best.inside)) return [];
  const p = (x: number, yy: number): Pt => ({ x: round(x), y: round(yy) });
  return [
    // A triangle standing on its point, which rests on the floor level line.
    {
      kind: "polyline",
      layer: "tags",
      points: [p(left + s / 2, y), p(left, y - s * 0.8), p(left + s, y - s * 0.8)],
      closed: true,
    },
    {
      kind: "text",
      layer: "tags",
      at: p(left + s + gap + textWidth / 2, y - s * 0.4),
      text,
      height: h,
    },
  ];
}

// --------------------------------------------------------------- north arrow

/** Degrees as a direction on the plan: 0 is up, 90 is to the right. */
export function normaliseNorth(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const d = degrees % 360;
  return round(d < 0 ? d + 360 : d);
}

/**
 * A north arrow `size` long, centred on `at`: a shaft with a pointed head and
 * the letter N beyond it. `north` is in degrees clockwise from the top of the
 * plan. Sizes are in whatever unit `at` is in.
 */
export function northArrow(at: Pt, size: number, north: number): Entity[] {
  const a = (normaliseNorth(north) * Math.PI) / 180;
  const dir = { x: Math.sin(a), y: -Math.cos(a) };
  const side = { x: -dir.y, y: dir.x };
  const p = (along: number, across: number): Pt => ({
    x: round(at.x + dir.x * along + side.x * across),
    y: round(at.y + dir.y * along + side.y * across),
  });
  const half = size / 2;
  const head = size * 0.3;
  const letter = size * 0.22;
  return [
    { kind: "polyline", layer: "titles", points: [p(-half, 0), p(half - head, 0)], closed: false },
    {
      kind: "polyline",
      layer: "titles",
      points: [p(half, 0), p(half - head, head * 0.4), p(half - head, -head * 0.4)],
      closed: true,
    },
    { kind: "text", layer: "titles", at: p(half + letter, 0), text: "N", height: letter, bold: true },
  ];
}

/** The tags and level mark of a storey that are switched on. */
export function storeyAnnotations(
  storey: Storey,
  annotations: Pick<Annotations, "openingTags" | "levelMarks">,
  style: AnnotationStyle,
  scale: number,
  linked: LinkedSpaces = linkSpaces(storey),
): Entity[] {
  return [
    ...(annotations.openingTags ? openingTags(storey, style, scale, linked) : []),
    ...(annotations.levelMarks ? levelMark(storey, style, scale, linked) : []),
  ];
}
