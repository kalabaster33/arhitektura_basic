/**
 * Apartments: named groups of rooms on one storey. A room belongs to at most
 * one apartment; rooms in none are common area.
 *
 * describeApartments() also derives what a layout tool needs to know about an
 * apartment: its outline, which outline edges are facade, and where its
 * entrance is.
 */
import { union } from "polyclip-ts";
import { type Pt, NODE_TOL, distToSegment, lerp, ringSignedArea } from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Apartment, ApartmentProgram, Storey } from "./model.ts";
import { openingGeometry, openingSides } from "./openings.ts";
import { type LinkedSpaces, linkSpaces } from "./spaces.ts";

function nextApartmentName(storey: Storey): string {
  const taken = new Set(storey.apartments.map((a) => a.name));
  for (let n = 1; ; n++) {
    const name = `Apartment ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Adds an apartment made of the given rooms, taking them out of any other apartment. */
export function createApartment(
  storey: Storey,
  spaceIds: string[] = [],
  makeId: (prefix: string) => string = newId,
): { storey: Storey; apartmentId: string } {
  const known = new Set(storey.spaces.map((s) => s.id));
  const mine = [...new Set(spaceIds)].filter((id) => known.has(id));
  const apartment: Apartment = {
    id: makeId("apartment"),
    name: nextApartmentName(storey),
    spaceIds: mine,
  };
  return {
    storey: {
      ...storey,
      apartments: [
        ...storey.apartments.map((a) => ({
          ...a,
          spaceIds: a.spaceIds.filter((id) => !mine.includes(id)),
        })),
        apartment,
      ],
    },
    apartmentId: apartment.id,
  };
}

export function renameApartment(storey: Storey, apartmentId: string, name: string): Storey {
  return {
    ...storey,
    apartments: storey.apartments.map((a) => (a.id === apartmentId ? { ...a, name } : a)),
  };
}

/** Sets the rooms the layout generator plans for the apartment. */
export function setApartmentProgram(storey: Storey, apartmentId: string, program: ApartmentProgram): Storey {
  return {
    ...storey,
    apartments: storey.apartments.map((a) => (a.id === apartmentId ? { ...a, program: { ...program } } : a)),
  };
}

/** Removes the apartment; its rooms stay and become common area. */
export function deleteApartment(storey: Storey, apartmentId: string): Storey {
  return { ...storey, apartments: storey.apartments.filter((a) => a.id !== apartmentId) };
}

/** Puts a room in an apartment, or in none when `apartmentId` is null. */
export function assignSpace(storey: Storey, spaceId: string, apartmentId: string | null): Storey {
  if (!storey.spaces.some((s) => s.id === spaceId)) return storey;
  if (apartmentId !== null && !storey.apartments.some((a) => a.id === apartmentId)) return storey;
  return {
    ...storey,
    apartments: storey.apartments.map((a) => {
      const rest = a.spaceIds.filter((id) => id !== spaceId);
      return { ...a, spaceIds: a.id === apartmentId ? [...rest, spaceId] : rest };
    }),
  };
}

export function apartmentOfSpace(storey: Storey, spaceId: string): Apartment | undefined {
  return storey.apartments.find((a) => a.spaceIds.includes(spaceId));
}

export interface ApartmentEntrance {
  openingId: string;
  /** Middle of the door, on the wall centreline. */
  position: Pt;
  /** The room the door leads out to; null when it leads outdoors. */
  outsideSpaceId: string | null;
}

export interface ApartmentInfo {
  apartmentId: string;
  name: string;
  spaceIds: string[];
  /**
   * Outline along the wall centrelines, interior on the left, no repeated last
   * vertex. Empty when the apartment has no rooms. When the rooms do not touch
   * each other this is the largest group only (see `pieces`).
   */
  outline: Pt[];
  /** Number of separate groups the rooms form; 1 for a proper apartment. */
  pieces: number;
  /** Indices of the outline edges that run along an exterior wall. Edge i is outline[i] -> outline[i + 1]. */
  facadeEdges: number[];
  /** Doors between the apartment and anything that is not part of it. */
  entrances: ApartmentEntrance[];
}

type Ring = [number, number][];

function toRing(points: Pt[]): Ring {
  return points.map((p) => [p.x, p.y]);
}

function fromRing(ring: Ring): Pt[] {
  const pts = ring.map(([x, y]) => ({ x, y }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && first.x === last.x && first.y === last.y) pts.pop();
  if (ringSignedArea(pts) < 0) pts.reverse();
  return pts;
}

export function describeApartments(
  storey: Storey,
  linked: LinkedSpaces = linkSpaces(storey),
): ApartmentInfo[] {
  const sides = storey.openings
    .filter((o) => o.kind === "door")
    .map((o) => ({ opening: o, sides: openingSides(storey, o, linked) }));
  const exterior = storey.walls.filter((w) => w.kind === "exterior");

  return storey.apartments.map((apartment) => {
    const members = new Set(apartment.spaceIds);
    const polys: Ring[][] = [];
    for (const id of apartment.spaceIds) {
      const face = linked.faceBySpaceId.get(id);
      if (face) polys.push([toRing(face.outer), ...face.holes.map(toRing)]);
    }
    let outline: Pt[] = [];
    let pieces = 0;
    if (polys.length > 0) {
      const merged = (polys.length === 1 ? [polys[0]] : union(polys[0], ...polys.slice(1))) as Ring[][];
      pieces = merged.length;
      for (const poly of merged) {
        const ring = fromRing(poly[0]);
        if (Math.abs(ringSignedArea(ring)) > Math.abs(ringSignedArea(outline))) outline = ring;
      }
    }

    const facadeEdges: number[] = [];
    outline.forEach((p, i) => {
      const mid = lerp(p, outline[(i + 1) % outline.length], 0.5);
      if (exterior.some((w) => distToSegment(mid, w.a, w.b) <= NODE_TOL)) facadeEdges.push(i);
    });

    const entrances: ApartmentEntrance[] = [];
    for (const { opening, sides: [left, right] } of sides) {
      const leftIn = left !== null && members.has(left);
      const rightIn = right !== null && members.has(right);
      if (leftIn === rightIn) continue;
      const wall = storey.walls.find((w) => w.id === opening.wallId)!;
      entrances.push({
        openingId: opening.id,
        position: openingGeometry(wall, opening).centre,
        outsideSpaceId: leftIn ? right : left,
      });
    }

    return {
      apartmentId: apartment.id,
      name: apartment.name,
      spaceIds: apartment.spaceIds.slice(),
      outline,
      pieces,
      facadeEdges,
      entrances,
    };
  });
}
