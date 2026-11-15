/**
 * Wall-to-room linking, geometry half: turns a set of walls into the rooms
 * they enclose.
 *
 * The wall centrelines are cut where they meet or cross, which gives a planar
 * graph. Walking that graph always turning as far left as possible traces the
 * boundary of every enclosed area (a "face"). Each face boundary is then moved
 * inward by half the thickness of each wall it runs along, which gives the net
 * outline of the room. Walls standing free inside a room (islands, columns,
 * inner cores) become holes in it; wall stubs poking into a room are cut out.
 */
import {
  type Pt,
  NODE_TOL,
  dist,
  distToSegment,
  lerp,
  lineIntersectionParams,
  offsetRingLeft,
  pointInRing,
  projectParam,
  ringSignedArea,
} from "./geometry.ts";
import type { Wall } from "./model.ts";

export interface Face {
  /** Boundary along the wall centrelines. */
  outer: Pt[];
  holes: Pt[][];
  /** Boundary along the inner wall faces. */
  netOuter: Pt[];
  netHoles: Pt[][];
  /** Every wall the room touches, including walls of islands inside it. */
  wallIds: string[];
  centrelineArea: number;
  netArea: number;
}

/** One connected group of walls that is not inside any room. */
export interface Outline {
  centreline: Pt[];
  outerFace: Pt[];
  centrelineArea: number;
  outerFaceArea: number;
}

export interface Topology {
  faces: Face[];
  outlines: Outline[];
}

interface HalfEdge {
  from: number;
  to: number;
  wallId: string;
  half: number;
  angle: number;
}

interface Cycle {
  ring: Pt[];
  halves: number[];
  wallIds: string[];
  area: number;
  component: number;
}

const nodeKey = (p: Pt) => `${Math.round(p.x / NODE_TOL)},${Math.round(p.y / NODE_TOL)}`;

export function buildTopology(walls: Wall[]): Topology {
  const valid = walls.filter((w) => dist(w.a, w.b) > NODE_TOL);

  // 1. Where must each wall be cut? At its ends, at crossings, and wherever
  //    another wall's end lands on it (T-junctions, overlapping collinear walls).
  const cuts: number[][] = valid.map(() => [0, 1]);
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const A = valid[i];
      const B = valid[j];
      const x = lineIntersectionParams(A.a, A.b, B.a, B.b);
      if (x) {
        const ea = NODE_TOL / dist(A.a, A.b);
        const eb = NODE_TOL / dist(B.a, B.b);
        if (x.t >= -ea && x.t <= 1 + ea && x.u >= -eb && x.u <= 1 + eb) {
          cuts[i].push(Math.max(0, Math.min(1, x.t)));
          cuts[j].push(Math.max(0, Math.min(1, x.u)));
        }
      }
      for (const p of [B.a, B.b]) {
        if (distToSegment(p, A.a, A.b) <= NODE_TOL) {
          cuts[i].push(Math.max(0, Math.min(1, projectParam(p, A.a, A.b))));
        }
      }
      for (const p of [A.a, A.b]) {
        if (distToSegment(p, B.a, B.b) <= NODE_TOL) {
          cuts[j].push(Math.max(0, Math.min(1, projectParam(p, B.a, B.b))));
        }
      }
    }
  }

  // 2. Nodes and edges of the planar graph.
  const nodes: Pt[] = [];
  const nodeIndex = new Map<string, number>();
  // Points closer than NODE_TOL are one node, even when rounding puts them in
  // neighbouring buckets (two points 0.01 mm apart either side of a bucket edge).
  const nodeOf = (p: Pt): number => {
    const bx = Math.round(p.x / NODE_TOL);
    const by = Math.round(p.y / NODE_TOL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const idx = nodeIndex.get(`${bx + dx},${by + dy}`);
        if (idx !== undefined && dist(nodes[idx], p) <= NODE_TOL) return idx;
      }
    }
    const idx = nodes.length;
    nodes.push(p);
    nodeIndex.set(nodeKey(p), idx);
    return idx;
  };
  const half: HalfEdge[] = [];
  const seenEdges = new Set<string>();
  valid.forEach((wall, i) => {
    const ts = cuts[i].slice().sort((p, q) => p - q);
    let prev = nodeOf(lerp(wall.a, wall.b, ts[0]));
    for (let k = 1; k < ts.length; k++) {
      const cur = nodeOf(lerp(wall.a, wall.b, ts[k]));
      if (cur === prev) continue;
      const key = prev < cur ? `${prev}-${cur}` : `${cur}-${prev}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        const p = nodes[prev];
        const q = nodes[cur];
        const h = wall.thickness / 2;
        half.push(
          { from: prev, to: cur, wallId: wall.id, half: h, angle: Math.atan2(q.y - p.y, q.x - p.x) },
          { from: cur, to: prev, wallId: wall.id, half: h, angle: Math.atan2(p.y - q.y, p.x - q.x) },
        );
      }
      prev = cur;
    }
  });

  // 3. Half-edges leaving each node, sorted by direction; connected components.
  const outgoing: number[][] = nodes.map(() => []);
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  half.forEach((h, i) => {
    outgoing[h.from].push(i);
    parent[find(h.from)] = find(h.to);
  });
  const slot = new Int32Array(half.length);
  for (const list of outgoing) {
    list.sort((p, q) => half[p].angle - half[q].angle);
    list.forEach((h, k) => (slot[h] = k));
  }
  // The twin of half-edge i is i ^ 1. Arriving along i, the sharpest left turn
  // is the edge just clockwise of the way back.
  const next = (i: number): number => {
    const list = outgoing[half[i].to];
    return list[(slot[i ^ 1] - 1 + list.length) % list.length];
  };

  // 4. Trace every boundary walk.
  const cycles: Cycle[] = [];
  const visited = new Uint8Array(half.length);
  for (let start = 0; start < half.length; start++) {
    if (visited[start]) continue;
    const ring: Pt[] = [];
    const halves: number[] = [];
    const wallIds = new Set<string>();
    for (let i = start; !visited[i]; i = next(i)) {
      visited[i] = 1;
      ring.push(nodes[half[i].from]);
      halves.push(half[i].half);
      wallIds.add(half[i].wallId);
    }
    cycles.push({
      ring,
      halves,
      wallIds: [...wallIds],
      area: ringSignedArea(ring),
      component: find(half[start].from),
    });
  }

  // 5. Positive walks enclose a room. Every connected group of walls has
  //    exactly one other walk: its outside.
  const rooms = cycles.filter((c) => c.area > 1e-6);
  const outsides = cycles.filter((c) => c.area <= 1e-6);
  const faces = new Map<Cycle, Face>();
  for (const c of rooms) {
    faces.set(c, {
      outer: c.ring,
      holes: [],
      netOuter: offsetRingLeft(c.ring, c.halves),
      netHoles: [],
      wallIds: c.wallIds.slice(),
      centrelineArea: 0,
      netArea: 0,
    });
  }

  // 6. A group of walls lying inside a room of another group is a hole in it.
  const outlines: Outline[] = [];
  for (const c of outsides) {
    let container: Cycle | null = null;
    for (const r of rooms) {
      if (r.component === c.component) continue;
      if (!pointInRing(c.ring[0], r.ring)) continue;
      if (!container || r.area < container.area) container = r;
    }
    const outerFace = offsetRingLeft(c.ring, c.halves);
    if (container) {
      const face = faces.get(container)!;
      face.holes.push(c.ring);
      face.netHoles.push(outerFace);
      for (const id of c.wallIds) if (!face.wallIds.includes(id)) face.wallIds.push(id);
    } else {
      outlines.push({
        centreline: c.ring,
        outerFace,
        centrelineArea: Math.abs(c.area),
        outerFaceArea: Math.abs(ringSignedArea(outerFace)),
      });
    }
  }

  for (const face of faces.values()) {
    let centre = ringSignedArea(face.outer);
    let net = ringSignedArea(face.netOuter);
    for (const hole of face.holes) centre -= Math.abs(ringSignedArea(hole));
    for (const hole of face.netHoles) net -= Math.abs(ringSignedArea(hole));
    face.centrelineArea = Math.max(0, centre);
    face.netArea = Math.max(0, net); // a room narrower than its walls has no floor
  }

  return { faces: [...faces.values()], outlines };
}
