import { describe, expect, it } from "vitest";
import layoutRules from "../config/layoutRules.json";
import roomChecks from "../config/roomChecks.json";
import splitJson from "../config/storeySplit.json";
import windowJson from "../config/windowRules.json";
import { parseLayoutRules, proposeLayouts } from "./autoLayout.ts";
import { addStorey, sortedStoreys } from "./building.ts";
import { checkStoreyPlan, parseRoomCheckConfig } from "./checks.ts";
import type { Storey } from "./model.ts";
import { openingSides } from "./openings.ts";
import { createProject } from "./project.ts";
import { linkSpaces } from "./spaces.ts";
import { parseSplitRules, proposeSplits } from "./storeySplit.ts";
import { addCoreElement, rebuildStructure, setAllErkerEdges, setFootprint } from "./structure.ts";
import { parseWindowRules, placeWindows } from "./windows.ts";

const windows = parseWindowRules(windowJson);
const checks = parseRoomCheckConfig(roomChecks);

/** A point block divided into four apartments, without rooms yet. */
function plan(): Storey {
  let p = createProject();
  const id = p.site.buildings[0].id;
  p = setFootprint(p, id, [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 14 },
    { x: 0, y: 14 },
  ]);
  p = setAllErkerEdges(p, id, false);
  p = rebuildStructure(addStorey(p, id).project, id);
  p = addCoreElement(p, id, "hall", { x: 8, y: 5 }, { x: 12, y: 9 }).project;
  p = addCoreElement(p, id, "stair", { x: 8, y: 9 }, { x: 11, y: 13.875 }).project;
  p = addCoreElement(p, id, "elevator", { x: 11, y: 9 }, { x: 12.6, y: 11 }).project;
  const b = p.site.buildings[0];
  const prog = (bedrooms: number) => ({ bedrooms, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" as const });
  const split = proposeSplits(
    b,
    sortedStoreys(b)[1],
    [
      { name: "Two", area: 65, count: 2, program: prog(2) },
      { name: "One", area: 50, count: 2, program: prog(1) },
    ],
    "hall",
    parseSplitRules(splitJson),
  );
  if (!split.ok) throw new Error(split.reason);
  return split.proposals[0].storey;
}

const options = { partitionThickness: 0.1, door: { width: 0.9, height: 2.1, sill: 0 }, snap: 0.05 };

function layOut(storey: Storey, withWindows: boolean): Storey {
  let s = storey;
  for (const a of storey.apartments) {
    const r = proposeLayouts(s, a.id, parseLayoutRules(layoutRules), withWindows ? { ...options, windows } : options, 3, a.program);
    if (!r.ok) throw new Error(r.reason);
    s = r.proposals[0].storey;
  }
  return s;
}

const windowsOf = (s: Storey) => s.openings.filter((o) => o.kind === "window");

describe("window rules", () => {
  it("reads the config and rejects damaged values", () => {
    expect(windows.types.living?.width).toBeGreaterThan(0);
    expect(() => parseWindowRules({ ...windowJson, pier: -1 })).toThrow(/pier/);
    expect(() => parseWindowRules({ ...windowJson, types: { hallway: windowJson.types.living } })).toThrow(/hallway/);
    expect(() => parseWindowRules({ ...windowJson, types: { living: { width: 1 } } })).toThrow(/living/);
  });
});

describe("automatic windows", { timeout: 30000 }, () => {
  it("gives every room that needs daylight a window in its facade when an apartment is laid out", () => {
    const without = layOut(plan(), false);
    expect(checkStoreyPlan(without, checks).some((i) => i.kind === "roomNoDaylight")).toBe(true);

    const laid = layOut(plan(), true);
    expect(checkStoreyPlan(laid, checks).filter((i) => i.kind === "roomNoDaylight")).toEqual([]);
    const linked = linkSpaces(laid);
    const walls = new Map(laid.walls.map((w) => [w.id, w]));
    for (const o of windowsOf(laid)) {
      expect(walls.get(o.wallId)!.kind).toBe("exterior");
      const sides = openingSides(laid, o, linked).filter((s) => s !== null);
      expect(sides).toHaveLength(1);
      const room = laid.spaces.find((s) => s.id === sides[0])!;
      expect(windows.types[room.type]).toBeDefined();
      expect(o.width).toBeLessThanOrEqual(windows.types[room.type]!.width);
      expect(o.sill).toBe(windows.types[room.type]!.sill);
    }
    // Living rooms get their own large windows.
    const living = laid.spaces.filter((s) => s.type === "living");
    for (const l of living) {
      const own = windowsOf(laid).filter((o) => openingSides(laid, o, linked).includes(l.id));
      expect(own.length).toBeGreaterThan(0);
    }
  });

  it("does not stack windows when an apartment is laid out again", () => {
    const once = layOut(plan(), true);
    const twice = layOut(once, true);
    expect(windowsOf(twice).length).toBe(windowsOf(once).length);
  });

  it("only fills rooms that have no window yet, unless told to replace them", () => {
    const laid = layOut(plan(), false);
    const first = placeWindows(laid, windows);
    expect(windowsOf(first).length).toBeGreaterThan(0);
    expect(placeWindows(first, windows)).toBe(first);
    expect(windowsOf(placeWindows(first, windows, { replace: true })).length).toBe(windowsOf(first).length);
  });

  it("keeps windows clear of the walls that join the facade and of each other", () => {
    const laid = layOut(plan(), true);
    const byWall = new Map<string, { lo: number; hi: number }[]>();
    for (const o of windowsOf(laid)) {
      const list = byWall.get(o.wallId) ?? [];
      list.push({ lo: o.offset - o.width / 2, hi: o.offset + o.width / 2 });
      byWall.set(o.wallId, list);
    }
    for (const list of byWall.values()) {
      list.sort((a, b) => a.lo - b.lo);
      for (let i = 1; i < list.length; i++) expect(list[i].lo - list[i - 1].hi).toBeGreaterThan(0.1);
    }
  });
});
