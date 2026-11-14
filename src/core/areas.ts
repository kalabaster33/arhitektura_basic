/**
 * Net / useful / gross areas of a storey. What each of the three means is not
 * decided here: it comes from an AreaConfig (src/config/areaDefinitions.json).
 */
import { sortedStoreys } from "./building.ts";
import type { Building, SpaceType, Storey } from "./model.ts";
import { linkSpaces } from "./spaces.ts";

export type Boundary = "wallInnerFace" | "wallCentreline";
export type StoreyBoundary = "wallOuterFace" | "wallCentreline";

export interface AreaConfig {
  version: number;
  /** Decimals shown and exported. Sums are taken before rounding. */
  decimals: number;
  net: { boundary: Boundary };
  useful: { defaultFactor: number; factorBySpaceType: Partial<Record<SpaceType, number>> };
  gross: { space: Boundary; storey: StoreyBoundary };
}

export interface SpaceAreas {
  spaceId: string;
  name: string;
  type: SpaceType;
  net: number;
  useful: number;
  gross: number;
}

export interface StoreyAreas {
  spaces: SpaceAreas[];
  /** Net and useful are sums over the spaces; gross is the storey as a whole. */
  totals: { net: number; useful: number; gross: number };
}

const BOUNDARIES: Boundary[] = ["wallInnerFace", "wallCentreline"];
const STOREY_BOUNDARIES: StoreyBoundary[] = ["wallOuterFace", "wallCentreline"];

/** Checks a config loaded from JSON; throws with the offending key. */
export function parseAreaConfig(raw: unknown): AreaConfig {
  const c = raw as AreaConfig;
  const fail = (key: string): never => {
    throw new Error(`Area definitions: invalid or missing "${key}".`);
  };
  if (!c || typeof c !== "object") fail("(root)");
  if (typeof c.version !== "number") fail("version");
  if (!Number.isInteger(c.decimals) || c.decimals < 0) fail("decimals");
  if (!BOUNDARIES.includes(c.net?.boundary)) fail("net.boundary");
  if (typeof c.useful?.defaultFactor !== "number") fail("useful.defaultFactor");
  if (!c.useful.factorBySpaceType || typeof c.useful.factorBySpaceType !== "object") {
    fail("useful.factorBySpaceType");
  }
  for (const [type, factor] of Object.entries(c.useful.factorBySpaceType)) {
    if (typeof factor !== "number" || factor < 0) fail(`useful.factorBySpaceType.${type}`);
  }
  if (!BOUNDARIES.includes(c.gross?.space)) fail("gross.space");
  if (!STOREY_BOUNDARIES.includes(c.gross?.storey)) fail("gross.storey");
  return {
    version: c.version,
    decimals: c.decimals,
    net: { boundary: c.net.boundary },
    useful: {
      defaultFactor: c.useful.defaultFactor,
      factorBySpaceType: { ...c.useful.factorBySpaceType },
    },
    gross: { space: c.gross.space, storey: c.gross.storey },
  };
}

export function computeStoreyAreas(storey: Storey, config: AreaConfig): StoreyAreas {
  const { topology, faceBySpaceId } = linkSpaces(storey);
  const spaces: SpaceAreas[] = [];
  const totals = { net: 0, useful: 0, gross: 0 };
  for (const space of storey.spaces) {
    const face = faceBySpaceId.get(space.id);
    if (!face) continue;
    const measure = (b: Boundary) => (b === "wallInnerFace" ? face.netArea : face.centrelineArea);
    const net = measure(config.net.boundary);
    const factor = config.useful.factorBySpaceType[space.type] ?? config.useful.defaultFactor;
    const useful = net * factor;
    spaces.push({
      spaceId: space.id,
      name: space.name,
      type: space.type,
      net,
      useful,
      gross: measure(config.gross.space),
    });
    totals.net += net;
    totals.useful += useful;
  }
  for (const outline of topology.outlines) {
    totals.gross +=
      config.gross.storey === "wallOuterFace" ? outline.outerFaceArea : outline.centrelineArea;
  }
  return { spaces, totals };
}

export interface AreaGroup {
  spaces: SpaceAreas[];
  /** Sums over the rooms of the group; gross is the sum of the room gross areas. */
  totals: { net: number; useful: number; gross: number };
}

export interface ApartmentAreas extends AreaGroup {
  apartmentId: string;
  name: string;
}

export interface StoreyAreasByApartment {
  apartments: ApartmentAreas[];
  /** Rooms that belong to no apartment. */
  common: AreaGroup;
}

/** Splits a storey's room areas by apartment; what is left over is common area. */
export function computeApartmentAreas(
  storey: Storey,
  config: AreaConfig,
  areas: StoreyAreas = computeStoreyAreas(storey, config),
): StoreyAreasByApartment {
  const group = (rows: SpaceAreas[]): AreaGroup => {
    const totals = { net: 0, useful: 0, gross: 0 };
    for (const r of rows) {
      totals.net += r.net;
      totals.useful += r.useful;
      totals.gross += r.gross;
    }
    return { spaces: rows, totals };
  };
  const taken = new Set<string>();
  const apartments = storey.apartments.map((a) => {
    const rows = areas.spaces.filter((r) => a.spaceIds.includes(r.spaceId) && !taken.has(r.spaceId));
    for (const r of rows) taken.add(r.spaceId);
    return { apartmentId: a.id, name: a.name, ...group(rows) };
  });
  return { apartments, common: group(areas.spaces.filter((r) => !taken.has(r.spaceId))) };
}

export interface BuildingAreas {
  /** Lowest storey first. */
  storeys: { storeyId: string; name: string; elevation: number; totals: StoreyAreas["totals"] }[];
  totals: StoreyAreas["totals"];
}

export function computeBuildingAreas(building: Building, config: AreaConfig): BuildingAreas {
  const totals = { net: 0, useful: 0, gross: 0 };
  const storeys = sortedStoreys(building).map((s) => {
    const t = computeStoreyAreas(s, config).totals;
    totals.net += t.net;
    totals.useful += t.useful;
    totals.gross += t.gross;
    return { storeyId: s.id, name: s.name, elevation: s.elevation, totals: t };
  });
  return { storeys, totals };
}

export function formatArea(value: number, config: AreaConfig): string {
  return value.toFixed(config.decimals);
}
