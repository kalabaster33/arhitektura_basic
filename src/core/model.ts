/**
 * Project data model: Project > Site > Building > Storey >
 * (Walls, Openings, Spaces, Apartments, Circulation).
 *
 * Plain JSON-serialisable data, no classes and no UI imports. Units are metres.
 * Bump SCHEMA_VERSION and add a migration in project.ts whenever a saved file
 * written by an older build would no longer load as-is.
 */
import type { Pt } from "./geometry.ts";

export const SCHEMA_VERSION = 5;

export type WallKind = "exterior" | "interior";

export interface Wall {
  id: string;
  /** Centreline end points. */
  a: Pt;
  b: Pt;
  thickness: number;
  kind: WallKind;
  /**
   * Set on walls generated from the building structure: the outside walls
   * ("shell"), the walls of the hall, stairs and elevator ("core") and the
   * railings of balconies and loggias ("balcony"). They are rebuilt from the
   * structure, not edited by hand.
   */
  part?: "shell" | "core" | "balcony";
  /**
   * A wall drawn by hand that carries the building. No door or window may be
   * put in it, and the generators leave it alone. The outside and core walls
   * count as load-bearing without this flag.
   */
  loadBearing?: boolean;
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
  /** True for a door that is an entrance to the building. */
  entrance?: boolean;
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
  "yard",
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

/** The rooms an apartment is to get besides its living room (see roomSubdivision.ts). */
export interface ApartmentProgram {
  bedrooms: number;
  bathrooms: number;
  /** Separate toilets. */
  wc: number;
  storage: number;
  kitchen: "open" | "separate" | "none";
}

export interface Apartment {
  id: string;
  name: string;
  spaceIds: string[];
  /** Rooms the layout generator plans for it; one bedroom and one bathroom when absent. */
  program?: ApartmentProgram;
  /** The apartment type it was generated as, e.g. "Two-bedroom". */
  unitType?: string;
  /** Floor area it was generated for, to wall centrelines. */
  targetArea?: number;
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

/**
 * A column: a rectangle of width `w` (along x) and depth `d` (along y) centred
 * on `at`. Columns belong to the structure and stand in the same place on
 * every storey; doors and windows are kept clear of them.
 */
export interface Column {
  id: string;
  at: Pt;
  w: number;
  d: number;
}

/**
 * The axes the columns stand on: x of every line along y, and y of every line
 * along x, each list in increasing order. A column stands at their crossings.
 */
export interface ColumnGrid {
  xs: number[];
  ys: number[];
}

export type BalconyKind = "balcony" | "loggia";

/**
 * A balcony (a slab standing out from the facade, behind a railing) or a
 * loggia (cut back into the building, open behind a railing in the facade
 * line). Placed on one side of the outline, on every storey above the ground
 * floor, at the facade of that storey (beyond the erker where there is one).
 */
export interface Balcony {
  id: string;
  kind: BalconyKind;
  /** The side of the ground floor outline it is on: edge i runs from corner i to corner i + 1. */
  edge: number;
  /** Distance along that side from corner i to where it begins. */
  offset: number;
  /** Length along the facade. */
  width: number;
  /** How far it stands out (balcony) or reaches in (loggia), from the outside face of the facade. */
  depth: number;
  /** Thickness of its railing. */
  railing: number;
  /**
   * Size of the door it gets from the room behind, when it has no door yet;
   * absent for none.
   */
  door?: { width: number; height: number };
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
  /**
   * The columns of the building, copied from its structure (see
   * structure.ts) so that work on one storey sees them. Absent when there are none.
   */
  columns?: Column[];
}

export type CoreKind = "hall" | "stair" | "elevator";

/** A hall, a staircase or an elevator: a rectangle that repeats on every storey. */
export interface CoreElement {
  id: string;
  kind: CoreKind;
  /** Two opposite corners, on the wall centrelines. */
  a: Pt;
  b: Pt;
}

/**
 * The building before its apartments: the outline of the ground floor, how far
 * the floors above reach beyond it, and where the hall, stairs and elevator
 * are. The outside and core walls of every storey are generated from this
 * (see structure.ts).
 */
export interface Structure {
  /**
   * Outline of the ground floor at the outside wall faces, interior on the
   * left of its edges; empty until it is drawn. Edge i runs from corner i to
   * corner i + 1.
   */
  footprint: Pt[];
  /** Thickness of the generated outside walls. */
  wallThickness: number;
  /** Thickness of the generated hall, stair and elevator walls. */
  coreWallThickness: number;
  /** How far the storeys above the ground floor project, and on which edges. */
  erker: {
    depth: number;
    /** One per footprint edge: true where that side has the projection. */
    edges: boolean[];
  };
  core: CoreElement[];
  /** Columns, the same on every storey. Absent or empty when there are none. */
  columns?: Column[];
  /** The axes the columns were placed on; absent when they were not placed on a grid. */
  columnGrid?: ColumnGrid;
  /** Balconies and loggias of the storeys above the ground floor. Absent when there are none. */
  balconies?: Balcony[];
}

export interface Building {
  id: string;
  name: string;
  storeys: Storey[];
  structure: Structure;
}

/** A place on the earth, in degrees (WGS 84). */
export interface GeoLocation {
  lat: number;
  lon: number;
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
  /** Where the origin of the plan (x 0, y 0) is on the earth; null when not set. */
  location: GeoLocation | null;
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

/** The steps a project is worked through, in order. */
export const STAGES = ["lot", "outline", "erker", "core", "apartments"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * A project's own layout rules, in the shape of src/config/layoutRules.json:
 * room sizes, adjacency rules and walking rules. Checked when used; rules that
 * do not pass fall back to the config.
 */
export interface LayoutRulesDoc {
  rooms: Record<string, { minArea: number; minWidth: number }>;
  adjacency: { a: string; b: string; rule: string; weight: number; hard?: boolean; text: string }[];
  circulation: Record<string, number>;
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
  /** The step of the workflow the project is in. */
  stage: Stage;
  site: Site;
  /** Layout rules edited for this project; absent when the config's rules apply. */
  layoutRules?: LayoutRulesDoc;
}
