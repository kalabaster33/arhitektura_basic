import { describe, expect, it } from "vitest";
import { addWallRun } from "./edit.ts";
import { dist } from "./geometry.ts";
import { createSampleProject } from "./project.ts";
import {
  DEFAULT_SNAP,
  type SnapSettings,
  findSnap,
  rectangleCorners,
  regularPolygon,
  snapGeometry,
} from "./osnap.ts";

const all: SnapSettings = {
  ...DEFAULT_SNAP,
  modes: { ...DEFAULT_SNAP.modes, nearest: true },
};
// A cross: two walls meeting in the middle, and a square around them.
const geo = snapGeometry(
  [
    [{ x: 0, y: 5 }, { x: 10, y: 5 }],
    [{ x: 5, y: 0 }, { x: 5, y: 10 }],
  ],
  [rectangleCorners({ x: 0, y: 0 }, { x: 10, y: 10 })],
);

describe("object snap", () => {
  it("snaps to an end point", () => {
    expect(findSnap({ x: 10.1, y: 9.95 }, geo, all, 0.3, 0.05)).toEqual({ pt: { x: 10, y: 10 }, kind: "endpoint" });
  });

  it("snaps to the middle of a segment", () => {
    const one = snapGeometry([[{ x: 0, y: 0 }, { x: 5, y: 0 }]], []);
    expect(findSnap({ x: 2.4, y: 0.1 }, one, all, 0.3, 0.05)).toEqual({ pt: { x: 2.5, y: 0 }, kind: "midpoint" });
  });

  it("snaps to where two segments cross", () => {
    const r = findSnap({ x: 5.1, y: 5.15 }, geo, all, 0.3, 0.05);
    expect(r.kind).toBe("intersection");
    expect(r.pt).toEqual({ x: 5, y: 5 });
  });

  it("snaps to the centre of a closed shape", () => {
    const centreOnly = { ...all, modes: { ...all.modes, intersection: false, midpoint: false, endpoint: false } };
    expect(findSnap({ x: 5.1, y: 5.1 }, geo, centreOnly, 0.3, 0.05).kind).toBe("center");
  });

  it("snaps to the foot of the perpendicular from the last point", () => {
    const r = findSnap({ x: 0.1, y: 7.3 }, geo, all, 0.3, 0.05, { x: 3, y: 7.3 });
    expect(r).toEqual({ pt: { x: 0, y: 7.3 }, kind: "perpendicular" });
  });

  it("falls back to the grid, and holds ortho to the last point", () => {
    expect(findSnap({ x: 3.03, y: 2.98 }, geo, all, 0.3, 0.05)).toEqual({ pt: { x: 3.05, y: 3 }, kind: "grid" });
    const ortho = { ...all, ortho: true };
    expect(findSnap({ x: 3.03, y: 2.4 }, geo, ortho, 0.3, 0.05, { x: 1, y: 2.333 }).pt).toEqual({ x: 3.05, y: 2.333 });
  });

  it("does nothing when object snap is off", () => {
    expect(findSnap({ x: 10.01, y: 10.02 }, geo, { ...all, osnap: false, grid: false }, 0.3, 0.05).kind).toBe("free");
  });
});

describe("shapes", () => {
  it("makes a regular polygon on the rim", () => {
    const ring = regularPolygon({ x: 0, y: 0 }, { x: 2, y: 0 }, 6);
    expect(ring).toHaveLength(6);
    expect(ring[0]).toEqual({ x: 2, y: 0 });
    for (const p of ring) expect(dist(p, { x: 0, y: 0 })).toBeCloseTo(2, 5);
  });

  it("draws a closed run of walls in one step", () => {
    const storey = createSampleProject().site.buildings[0].storeys[0];
    const empty = { ...storey, walls: [], openings: [], spaces: [] };
    const next = addWallRun(empty, rectangleCorners({ x: 0, y: 0 }, { x: 4, y: 3 }), true, 0.2, "interior");
    expect(next.walls).toHaveLength(4);
    expect(next.walls[3].b).toEqual({ x: 0, y: 0 });
  });
});
