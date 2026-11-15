/**
 * Placing the plan on the earth. The plan's origin (x 0, y 0) is one point
 * with a latitude and a longitude; around it the plan's metres are laid on the
 * standard web map (Web Mercator) tiles. Over the size of a plot the map's
 * distortion is far below the drawing tolerance. Pure functions, no UI imports.
 *
 * Plan axes: x grows to the east and y grows to the south (down the screen),
 * when north is at the top of the plan.
 */
import type { Pt } from "./geometry.ts";
import type { GeoLocation } from "./model.ts";

export const TILE_SIZE = 256;
/** Metres per map pixel at the equator, zoom 0. */
const EQUATOR_METRES_PER_PIXEL = 156543.03392804097;
/** Web Mercator stops here. */
export const MAX_LATITUDE = 85.05112878;

export interface MapSettings {
  tileUrl: string;
  attribution: string;
  maxZoom: number;
  searchUrl: string | null;
  defaultCentre: GeoLocation;
  defaultZoom: number;
}

/** Checks a config loaded from JSON; throws with the offending key. */
export function parseMapSettings(raw: unknown): MapSettings {
  const c = raw as MapSettings;
  const fail = (key: string): never => {
    throw new Error(`Map settings: invalid or missing "${key}".`);
  };
  if (!c || typeof c !== "object") fail("(root)");
  if (typeof c.tileUrl !== "string" || !/\{z\}.*\{x\}.*\{y\}|\{z\}/.test(c.tileUrl)) fail("tileUrl");
  if (typeof c.attribution !== "string" || c.attribution.trim() === "") fail("attribution");
  if (!Number.isInteger(c.maxZoom) || c.maxZoom < 1 || c.maxZoom > 22) fail("maxZoom");
  if (c.searchUrl !== null && typeof c.searchUrl !== "string") fail("searchUrl");
  if (!isLocation(c.defaultCentre)) fail("defaultCentre");
  if (!Number.isInteger(c.defaultZoom) || c.defaultZoom < 0 || c.defaultZoom > c.maxZoom) fail("defaultZoom");
  return {
    tileUrl: c.tileUrl,
    attribution: c.attribution,
    maxZoom: c.maxZoom,
    searchUrl: c.searchUrl,
    defaultCentre: { lat: c.defaultCentre.lat, lon: c.defaultCentre.lon },
    defaultZoom: c.defaultZoom,
  };
}

export function isLocation(p: unknown): p is GeoLocation {
  const g = p as GeoLocation;
  return (
    !!g &&
    Number.isFinite(g.lat) &&
    Number.isFinite(g.lon) &&
    Math.abs(g.lat) <= MAX_LATITUDE &&
    Math.abs(g.lon) <= 180
  );
}

/** Reads "41.9981, 21.4254" (comma, semicolon or space between); null when it is not a place. */
export function parseLatLon(text: string): GeoLocation | null {
  const parts = text
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const [lat, lon] = parts.map(Number);
  const place = { lat, lon };
  return isLocation(place) ? place : null;
}

export function formatLatLon(p: GeoLocation): string {
  return `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
}

/** Position on the whole-world map image at this zoom, in pixels from its top left. */
export function worldPixel(p: GeoLocation, zoom: number): Pt {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((p.lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

export function fromWorldPixel(p: Pt, zoom: number): GeoLocation {
  const scale = TILE_SIZE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * p.y) / scale;
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lon: (p.x / scale) * 360 - 180,
  };
}

/** Ground metres covered by one map pixel at this latitude and zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** The map zoom whose tiles are shown at their own size or larger, never smaller. */
export function tileZoomFor(lat: number, pixelsPerMetre: number, maxZoom: number): number {
  const exact = Math.log2(EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180) * pixelsPerMetre);
  return Math.max(0, Math.min(maxZoom, Math.floor(exact)));
}

export interface PlacedTile {
  key: string;
  url: string;
  /** Top left corner and edge length on the plan, in metres. */
  x: number;
  y: number;
  size: number;
}

export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

/**
 * The map tiles that cover a rectangle of the plan (metres, north up, origin
 * at `origin`), placed in plan coordinates. Empty when it would take more than
 * `limit` tiles.
 */
export function tilesForPlan(
  origin: GeoLocation,
  zoom: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  template: string,
  limit = 60,
): PlacedTile[] {
  const centre = worldPixel(origin, zoom);
  const metres = metresPerPixel(origin.lat, zoom);
  const count = 2 ** zoom;
  const x0 = Math.floor((centre.x + bounds.minX / metres) / TILE_SIZE);
  const x1 = Math.floor((centre.x + bounds.maxX / metres) / TILE_SIZE);
  const y0 = Math.max(0, Math.floor((centre.y + bounds.minY / metres) / TILE_SIZE));
  const y1 = Math.min(count - 1, Math.floor((centre.y + bounds.maxY / metres) / TILE_SIZE));
  if (y1 < y0 || (x1 - x0 + 1) * (y1 - y0 + 1) > limit) return [];
  const tiles: PlacedTile[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wrapped = ((tx % count) + count) % count;
      tiles.push({
        key: `${zoom}/${tx}/${ty}`,
        url: tileUrl(template, zoom, wrapped, ty),
        x: (tx * TILE_SIZE - centre.x) * metres,
        y: (ty * TILE_SIZE - centre.y) * metres,
        size: TILE_SIZE * metres,
      });
    }
  }
  return tiles;
}

/** The place on the earth of a point of the plan, given where north is on the plan. */
export function planToLocation(origin: GeoLocation, p: Pt, northDegrees = 0): GeoLocation {
  // Turn the plan back so that north is up, then step from the origin on the map.
  const a = (-northDegrees * Math.PI) / 180;
  const east = p.x * Math.cos(a) - p.y * Math.sin(a);
  const south = p.x * Math.sin(a) + p.y * Math.cos(a);
  const zoom = 20;
  const centre = worldPixel(origin, zoom);
  const metres = metresPerPixel(origin.lat, zoom);
  return fromWorldPixel({ x: centre.x + east / metres, y: centre.y + south / metres }, zoom);
}
