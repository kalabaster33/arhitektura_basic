/**
 * Wall-to-room linking, model half: keeps the storey's Space records in step
 * with the rooms its walls actually enclose.
 *
 * A Space keeps its identity (id, name, type) while its walls move. After every
 * wall edit the rooms are found again; an existing space is matched to the room
 * that contains its anchor point, or failing that to the room that shares most
 * of its walls. Rooms nobody claims become new spaces; spaces whose room is
 * gone are removed.
 */
import { interiorPoint, pointInPolygon } from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Space, Storey } from "./model.ts";
import { type Face, type Topology, buildTopology } from "./topology.ts";

export interface LinkedSpaces {
  topology: Topology;
  /** The room each space currently describes. */
  faceBySpaceId: Map<string, Face>;
}

function matchSpaces(spaces: Space[], faces: Face[]): Map<Face, Space> {
  const match = new Map<Face, Space>();
  const used = new Set<string>();
  for (const face of faces) {
    const space = spaces.find(
      (s) => !used.has(s.id) && pointInPolygon(s.anchor, face.outer, face.holes),
    );
    if (space) {
      match.set(face, space);
      used.add(space.id);
    }
  }
  // A wall dragged across an anchor leaves the anchor in the wrong room;
  // fall back on which walls the room is made of.
  for (const face of faces) {
    if (match.has(face)) continue;
    let best: Space | null = null;
    let bestShared = 0;
    for (const s of spaces) {
      if (used.has(s.id) || s.wallIds.length === 0) continue;
      const shared = s.wallIds.filter((id) => face.wallIds.includes(id)).length;
      if (shared * 2 >= s.wallIds.length && shared > bestShared) {
        bestShared = shared;
        best = s;
      }
    }
    if (best) {
      match.set(face, best);
      used.add(best.id);
    }
  }
  return match;
}

/** Read-only: which room each stored space describes right now. */
export function linkSpaces(storey: Storey): LinkedSpaces {
  const topology = buildTopology(storey.walls);
  const faceBySpaceId = new Map<string, Face>();
  for (const [face, space] of matchSpaces(storey.spaces, topology.faces)) {
    faceBySpaceId.set(space.id, face);
  }
  return { topology, faceBySpaceId };
}

function nextRoomName(taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const name = `Room ${n}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

/** Returns the storey with its spaces rebuilt from its walls. */
export function syncSpaces(storey: Storey, makeId: (prefix: string) => string = newId): Storey {
  const { faces } = buildTopology(storey.walls);
  const match = matchSpaces(storey.spaces, faces);
  const names = new Set(storey.spaces.map((s) => s.name));
  const spaces: Space[] = faces.map((face) => {
    const existing = match.get(face);
    const anchor =
      face.netArea > 0
        ? interiorPoint(face.netOuter, face.netHoles)
        : interiorPoint(face.outer, face.holes);
    return {
      id: existing?.id ?? makeId("space"),
      name: existing?.name ?? nextRoomName(names),
      type: existing?.type ?? "room",
      anchor,
      wallIds: face.wallIds.slice().sort(),
    };
  });
  // Keep the order stable: surviving spaces first in their old order, then new ones.
  const order = new Map(storey.spaces.map((s, i) => [s.id, i]));
  spaces.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));

  const alive = new Set(spaces.map((s) => s.id));
  return {
    ...storey,
    spaces,
    apartments: storey.apartments.map((a) => ({
      ...a,
      spaceIds: a.spaceIds.filter((id) => alive.has(id)),
    })),
    circulation: storey.circulation.filter((c) => !c.spaceId || alive.has(c.spaceId)),
  };
}
