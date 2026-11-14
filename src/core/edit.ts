/**
 * Editing operations on a storey. Each one returns a new storey with its
 * spaces already re-linked to the walls, so areas are never stale.
 */
import {
  type Pt,
  NODE_TOL,
  dist,
  distToSegment,
  lerp,
  projectParam,
  samePoint,
} from "./geometry.ts";
import { newId } from "./ids.ts";
import type { Space, Storey, Wall, WallKind } from "./model.ts";
import { reconcileOpenings } from "./openings.ts";
import { syncCirculation, syncSpaces } from "./spaces.ts";

/**
 * Keeps T-junctions together. A wall end that sat somewhere along another wall
 * (not at its corner) stays at the same relative position on it after that
 * wall has moved, unless the edit moved that end itself.
 */
function reattach(before: Wall[], after: Wall[]): Wall[] {
  const joints: { wallId: string; end: "a" | "b"; hostId: string; t: number }[] = [];
  const afterById = new Map(after.map((w) => [w.id, w]));
  for (const w of before) {
    for (const end of ["a", "b"] as const) {
      const p = w[end];
      const moved = afterById.get(w.id);
      if (!moved || !samePoint(moved[end], p, 1e-9)) continue;
      for (const host of before) {
        if (host.id === w.id || samePoint(p, host.a) || samePoint(p, host.b)) continue;
        if (distToSegment(p, host.a, host.b) <= NODE_TOL) {
          joints.push({ wallId: w.id, end, hostId: host.id, t: projectParam(p, host.a, host.b) });
          break;
        }
      }
    }
  }
  if (joints.length === 0) return after;
  const walls = after.map((w) => ({ ...w }));
  const byId = new Map(walls.map((w) => [w.id, w]));
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  // A few passes, so a wall hanging off a wall that itself hangs off the moved one follows.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const j of joints) {
      const w = byId.get(j.wallId);
      const host = byId.get(j.hostId);
      if (!w || !host) continue;
      const q = lerp(host.a, host.b, j.t);
      const target = { x: round(q.x), y: round(q.y) };
      if (!samePoint(w[j.end], target, 1e-9)) {
        w[j.end] = target;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return walls;
}

/** Drops walls that collapsed to a point (and their openings), then re-links. */
function finish(storey: Storey, edited: Wall[]): Storey {
  const walls = reattach(storey.walls, edited);
  const kept = walls.filter((w) => dist(w.a, w.b) > NODE_TOL);
  const ids = new Set(kept.map((w) => w.id));
  return syncSpaces(
    reconcileOpenings(storey, {
      ...storey,
      walls: kept,
      openings: storey.openings.filter((o) => ids.has(o.wallId)),
    }),
  );
}

export function addWall(
  storey: Storey,
  a: Pt,
  b: Pt,
  thickness: number,
  kind: WallKind = "interior",
): Storey {
  if (dist(a, b) <= NODE_TOL || !(thickness > 0)) return storey;
  return finish(storey, [...storey.walls, { id: newId("wall"), a, b, thickness, kind }]);
}

export function deleteWall(storey: Storey, id: string): Storey {
  return finish(storey, storey.walls.filter((w) => w.id !== id));
}

/** Moves a wall corner: every wall end at `from` goes to `to`, so walls stay joined. */
export function moveNode(storey: Storey, from: Pt, to: Pt): Storey {
  return finish(
    storey,
    storey.walls.map((w) => ({
      ...w,
      a: samePoint(w.a, from) ? to : w.a,
      b: samePoint(w.b, from) ? to : w.b,
    })),
  );
}

/** Moves a wall sideways or along; walls joined to its ends stretch with it. */
export function moveWall(storey: Storey, id: string, delta: Pt): Storey {
  const wall = storey.walls.find((w) => w.id === id);
  if (!wall) return storey;
  const shift = (p: Pt): Pt =>
    samePoint(p, wall.a) || samePoint(p, wall.b) ? { x: p.x + delta.x, y: p.y + delta.y } : p;
  return finish(
    storey,
    storey.walls.map((w) => ({ ...w, a: shift(w.a), b: shift(w.b) })),
  );
}

/** Sets a wall's length by moving its `b` end (and whatever is joined there). */
export function setWallLength(storey: Storey, id: string, length: number): Storey {
  const wall = storey.walls.find((w) => w.id === id);
  if (!wall || !(length > NODE_TOL)) return storey;
  const current = dist(wall.a, wall.b);
  const k = length / current;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return moveNode(storey, wall.b, {
    x: round(wall.a.x + (wall.b.x - wall.a.x) * k),
    y: round(wall.a.y + (wall.b.y - wall.a.y) * k),
  });
}

export function setWallThickness(storey: Storey, id: string, thickness: number): Storey {
  if (!(thickness > 0)) return storey;
  return finish(
    storey,
    storey.walls.map((w) => (w.id === id ? { ...w, thickness } : w)),
  );
}

export function setWallKind(storey: Storey, id: string, kind: WallKind): Storey {
  return { ...storey, walls: storey.walls.map((w) => (w.id === id ? { ...w, kind } : w)) };
}

export function updateSpace(
  storey: Storey,
  id: string,
  patch: Partial<Pick<Space, "name" | "type">>,
): Storey {
  return syncCirculation({
    ...storey,
    spaces: storey.spaces.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  });
}
