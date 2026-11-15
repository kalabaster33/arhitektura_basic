/**
 * Project data model: Project > Site > Building > Storey >
 * (Walls, Openings, Spaces, Apartments, Circulation).
 *
 * Plain JSON-serialisable data, no classes and no UI imports. Units are metres.
 * Bump SCHEMA_VERSION and add a migration in project.ts whenever a saved file
 * written by an older build would no longer load as-is.
 */
import type { Pt } from "./geometry.ts";

export const SCHEMA_VERSION = 4;

export type WallKind = "exterior" | "interior";

export interface Wall {
  id: string;
  /** Centreline end points. */
  a: Pt;
  b: Pt;
  thickness: number;
  kind: WallKind;
}

export type OpeningKind = "door" | "window";

export interface Opening {
  id: string;
  wallId: string;
  kind: OpeningKind;
  /** Distance from the wall's `a` end to the centre of the opening. */
  offset: number;
  width: number;
  height: number;
  /** Height of the sill above the storey floor (0 for doors). */
  sill: number;
}

export const SPACE_TYPES = [
  "room",
  "living",
  "bedroom",
  "kitchen",
  "bathroom",
  "corridor",
  "storage",
  "balcony",
  "stair",
  "elevator",
  "shaft",
  "other",
] as const;

export type SpaceType = (typeof SPACE_TYPES)[number];

/**
 * A room. Its shape is not stored: it is the area enclosed by its walls, found
 * again from `anchor` every time the walls change (see spaces.ts).
 */
export interface Space {
  id: string;
  name: string;
  type: SpaceType;
  /** A point inside the room. */
  anchor: Pt;
  /** Walls that bound the room, kept in step with the geometry. */
  wallIds: string[];
}

export interface Apartment {
  id: string;
  name: string;
  spaceIds: string[];
}

export type CirculationKind = "stair" | "elevator" | "shaft" | "corridor";

export interface CirculationElement {
  id: string;
  kind: CirculationKind;
  /** The space this element occupies, if it has one. */
  spaceId?: string;
}

/**
 * A dimension placed by hand: the distance between two points, written on a
 * line parallel to them. It stays where it was put when walls move.
 */
export interface Dimension {
  id: string;
  a: Pt;
  b: Pt;
  /** How far the dimension line is from the two points, to the left of a -> b. */
  offset: number;
}

export interface Storey {
  id: string;
  name: string;
  /** Finished floor level above the site datum. */
  elevation: number;
  /** Floor-to-floor height. */
  height: number;
  walls: Wall[];
  openings: Opening[];
  spaces: Space[];
  apartments: Apartment[];
  circulation: CirculationElement[];
  /** Dimensions placed by hand. The automatic ones are worked out, not stored. */
  dimensions: Dimension[];
}

export interface Building {
  id: string;
  name: string;
  storeys: Storey[];
}

export interface SiteLimits {
  /** Largest allowed share of the plot covered by buildings (0.4 = 40 %). */
  maxCoverage: number | null;
  /** Largest allowed total gross floor area divided by plot area. */
  maxFloorAreaRatio: number | null;
}

export interface Site {
  id: string;
  name: string;
  /** Plot outline; empty until it is drawn. Edge i runs from corner i to corner i + 1. */
  boundary: Pt[];
  /** Setback of each boundary edge in metres, one per edge. */
  setbacks: number[];
  /** Planning limits for this plot; null means no limit is checked. */
  limits: SiteLimits;
  /** Where north is on the plan, in degrees clockwise from the top (0 = up). */
  north: number;
  buildings: Building[];
}

/** Which automatic annotations are drawn on the plans. */
export interface Annotations {
  /** Dimension chains around the building. */
  outsideDimensions: boolean;
  /** Clear width and length of every room. */
  roomDimensions: boolean;
  /** Size tag at every door and window. */
  openingTags: boolean;
  /** Floor level mark on every storey. */
  levelMarks: boolean;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  units: "m";
  grid: {
    /** Snap step in metres. */
    snap: number;
  };
  annotations: Annotations;
  site: Site;
}
