import { describe, expect, it } from "vitest";
import layoutRules from "../config/layoutRules.json";
import splitJson from "../config/storeySplit.json";
import { generateLayouts, normalizeProgram } from "../roomSubdivision.ts";
import { apartmentInteriorWalls, parseLayoutRules, proposeLayouts } from "./autoLayout.ts";
import { addStorey, sortedStoreys } from "./building.ts";
import { describeApartments } from "./apartments.ts";
import type { Project } from "./model.ts";
import { createProject } from "./project.ts";
import { linkSpaces } from "./spaces.ts";
import { type UnitType, parseSplitRules, proposeSplits, usableArea } from "./storeySplit.ts";
import { addCoreElement, rebuildStructure, setAllErkerEdges, setFootprint } from "./structure.ts";

const rules = parseSplitRules(splitJson);

function block(w: number, h: number, core: ["hall" | "stair" | "elevator", number, number, number, number][]): Project {
  let p = createProject();
  const id = p.site.buildings[0].id;
  p = setFootprint(p, id, [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]);
  p = setAllErkerEdges(p, id, false);
  p = rebuildStructure(addStorey(p, id).project, id);
  for (const [kind, x0, y0, x1, y1] of core) {
    p = addCoreElement(p, id, kind, { x: x0, y: y0 }, { x: x1, y: y1 }).project;
  }
  return p;
}

const unit = (name: string, area: number, count: number, bedrooms = 1): UnitType => ({
  name,
  area,
  count,
  program: { bedrooms, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" },
});

const upper = (p: Project) => {
  const b = p.site.buildings[0];
  return { building: b, storey: sortedStoreys(b)[1] };
};

/** A point block: hall in the middle, stairs and elevator beside it. */
const pointBlock = () =>
  block(20, 14, [
    ["hall", 8, 5, 12, 9],
    ["stair", 8, 9, 11, 13.875],
    ["elevator", 11, 9, 12.6, 11],
  ]);

/** A long slab: the hall alone cannot reach eight apartments. */
const slab = () =>
  block(40, 12, [
    ["hall", 18, 4.5, 22, 7.5],
    ["stair", 18, 7.5, 21, 11.875],
    ["elevator", 21, 7.5, 22.6, 9.5],
  ]);

describe("storey rules", () => {
  it("reads the config and rejects damaged values", () => {
    expect(rules.unitTypes.length).toBeGreaterThan(0);
    expect(() => parseSplitRules({ ...splitJson, cellSize: 0 })).toThrow(/cellSize/);
    expect(() => parseSplitRules({ ...splitJson, entranceDoor: {} })).toThrow(/entranceDoor/);
  });
});

describe("storey generator", () => {
  it("divides a point block into the wanted apartments, each entered from the hall", () => {
    const { building, storey } = upper(pointBlock());
    const result = proposeSplits(building, storey, [unit("Two", 65, 2, 2), unit("One", 50, 2)], "auto", rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const best = result.proposals[0];
    expect(best.access).toBe("hall");
    expect(best.storey.apartments).toHaveLength(4);
    const infos = describeApartments(best.storey);
    const hall = best.storey.spaces.find((s) => s.name === "Hall")!;
    for (const info of infos) {
      expect(info.pieces).toBe(1);
      expect(info.facadeEdges.length).toBeGreaterThan(0);
      expect(info.entrances.map((e) => e.outsideSpaceId)).toContain(hall.id);
    }
    // The floor is used up and the sizes keep their proportions.
    const usable = usableArea(building, storey.id, rules)!;
    const total = best.apartments.reduce((s, a) => s + a.area, 0);
    expect(total).toBeGreaterThan(0.9 * usable);
    for (const a of best.apartments) {
      const share = a.wanted / 230;
      expect(a.area / total).toBeCloseTo(share, 1);
    }
    // The generated walls are the apartments' own, the structure is untouched.
    expect(best.storey.walls.filter((w) => w.part)).toEqual(storey.walls.filter((w) => w.part));
  });

  it("stores each apartment's type, wanted area and rooms for the layout generator", () => {
    const { building, storey } = upper(pointBlock());
    const result = proposeSplits(building, storey, [unit("Two", 65, 2, 2), unit("One", 50, 2)], "hall", rules);
    if (!result.ok) throw new Error(result.reason);
    const twos = result.proposals[0].storey.apartments.filter((a) => a.unitType === "Two");
    expect(twos).toHaveLength(2);
    expect(twos[0].program?.bedrooms).toBe(2);
    expect(twos[0].targetArea).toBe(65);
  });

  it("runs a corridor from the hall when the hall cannot reach every apartment", { timeout: 20000 }, () => {
    const { building, storey } = upper(slab());
    const mix = [unit("Two", 60, 4, 2), unit("One", 45, 4)];
    const hallOnly = proposeSplits(building, storey, mix, "hall", rules);
    expect(hallOnly.ok).toBe(false);
    const result = proposeSplits(building, storey, mix, "auto", rules);
    if (!result.ok) throw new Error(result.reason);
    const best = result.proposals[0];
    expect(best.access).toBe("corridor");
    expect(best.storey.apartments).toHaveLength(8);
    const corridor = best.storey.spaces.find((s) => s.type === "corridor" && s.name.startsWith("Corridor"));
    expect(corridor).toBeDefined();
    const hall = best.storey.spaces.find((s) => s.name === "Hall")!;
    for (const info of describeApartments(best.storey)) {
      expect(info.pieces).toBe(1);
      const from = info.entrances.map((e) => e.outsideSpaceId);
      expect(from.some((id) => id === hall.id || best.storey.spaces.find((s) => s.id === id)?.type === "corridor")).toBe(
        true,
      );
    }
  });

  it("stops the corridor short of the ends when end apartments fit better there", { timeout: 30000 }, () => {
    // Six apartments on a 44 m slab: a corridor run to both end walls leaves
    // no way to cut the floor; stopped short, the end blocks take the corner flats.
    const { building, storey } = upper(
      block(44, 12, [
        ["hall", 20, 4.5, 24, 7.5],
        ["stair", 20, 7.5, 23, 11.875],
        ["elevator", 23, 7.5, 24.6, 9.5],
      ]),
    );
    const mix = [unit("Two", 80, 4, 2), unit("One", 60, 2)];
    const toWalls = proposeSplits(building, storey, mix, "corridor", rules, 1, {
      corridorLayouts: [{ axes: ["long"], anchor: "centre" }],
    });
    expect(toWalls.ok).toBe(false);
    const result = proposeSplits(building, storey, mix, "corridor", rules, 1);
    if (!result.ok) throw new Error(result.reason);
    const best = result.proposals[0];
    expect(best.storey.apartments).toHaveLength(6);
    const linked = linkSpaces(best.storey);
    const corridor = best.storey.spaces.filter((s) => s.type === "corridor" && s.name.startsWith("Corridor"));
    const xs = corridor.flatMap((c) => linked.faceBySpaceId.get(c.id)!.outer.map((p) => p.x));
    // It reaches neither end wall.
    expect(Math.min(...xs)).toBeGreaterThan(2);
    expect(Math.max(...xs)).toBeLessThan(42);
  });

  it("replaces the apartments and walls drawn on the storey before", () => {
    const { building, storey } = upper(pointBlock());
    const first = proposeSplits(building, storey, [unit("One", 50, 4)], "hall", rules);
    if (!first.ok) throw new Error(first.reason);
    const again = proposeSplits(building, first.proposals[0].storey, [unit("Two", 65, 2, 2), unit("One", 50, 2)], "hall", rules);
    if (!again.ok) throw new Error(again.reason);
    expect(again.proposals[0].storey.apartments).toHaveLength(4);
    expect(again.proposals[0].storey.apartments.filter((a) => a.unitType === "Two")).toHaveLength(2);
  });

  it("gives the same answer every time", () => {
    const { building, storey } = upper(pointBlock());
    const mix = [unit("Two", 65, 2, 2), unit("One", 50, 2)];
    const a = proposeSplits(building, storey, mix, "auto", rules);
    const b = proposeSplits(building, storey, mix, "auto", rules);
    if (!a.ok || !b.ok) throw new Error("no plan");
    const walls = (r: typeof a) => r.proposals[0].storey.walls.filter((w) => !w.part).map((w) => [w.a, w.b]);
    expect(walls(a)).toEqual(walls(b));
  });

  it("says why it cannot divide a storey", () => {
    const { building, storey } = upper(pointBlock());
    const none = proposeSplits(building, storey, [unit("One", 50, 0)], "auto", rules);
    expect(none.ok).toBe(false);
    const tooMany = proposeSplits(building, storey, [unit("Tiny", 10, 16)], "hall", rules);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toMatch(/hall/);
    const p = block(20, 14, []);
    const noHall = proposeSplits(upper(p).building, upper(p).storey, [unit("One", 50, 2)], "auto", rules);
    expect(noHall.ok).toBe(false);
    if (!noHall.ok) expect(noHall.reason).toMatch(/hall/i);
  });
});

describe("room programme", () => {
  const rect = (w: number, h: number) => [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];

  it("keeps counts whole and within limits", () => {
    expect(normalizeProgram({ bedrooms: 9, bathrooms: 0, wc: -1, kitchen: "x" as never })).toEqual({
      bedrooms: 5,
      bathrooms: 1,
      wc: 0,
      storage: 0,
      kitchen: "open",
    });
  });

  it("places the rooms the programme asks for", () => {
    const input = { polygon: rect(13, 8), facadeEdges: [0, 1], entrance: { x: 4, y: 8 } };
    const [layout] = generateLayouts(input, { program: { bedrooms: 3, bathrooms: 2, wc: 0, storage: 0, kitchen: "separate" } }, 1);
    const count = (t: string) => layout.rooms.filter((r) => r.type === t).length;
    expect(count("living")).toBe(1);
    expect(count("bedroom")).toBe(3);
    expect(count("bathroom")).toBe(2);
    expect(count("kitchen")).toBe(1);
    // Every bedroom and the kitchen have daylight.
    for (const r of layout.rooms.filter((r) => r.type === "bedroom" || r.type === "kitchen")) {
      expect(r.facadeLength).toBeGreaterThan(1);
    }
  });

  it("makes a studio without a bedroom", () => {
    const input = { polygon: rect(6, 5.5), facadeEdges: [0], entrance: { x: 2, y: 5.5 } };
    const [layout] = generateLayouts(input, { program: { bedrooms: 0, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" } }, 1);
    expect(layout.rooms.map((r) => r.type).sort()).toEqual(["bathroom", "living"]);
  });

  it("lays out a generated apartment with its own programme and numbers the rooms", () => {
    const { building, storey } = upper(pointBlock());
    const split = proposeSplits(building, storey, [unit("Two", 65, 2, 2), unit("One", 50, 2)], "hall", rules);
    if (!split.ok) throw new Error(split.reason);
    const plan = split.proposals[0].storey;
    const two = plan.apartments.find((a) => a.unitType === "Two")!;
    const result = proposeLayouts(
      plan,
      two.id,
      parseLayoutRules(layoutRules),
      { partitionThickness: 0.1, door: { width: 0.9, height: 2.1, sill: 0 }, snap: 0.05 },
      3,
      two.program,
    );
    if (!result.ok) throw new Error(result.reason);
    const laid = result.proposals[0].storey;
    const names = laid.apartments.find((a) => a.id === two.id)!.spaceIds.map((id) => laid.spaces.find((s) => s.id === id)!.name);
    expect(names).toEqual(expect.arrayContaining(["Living room", "Bedroom 1", "Bedroom 2", "Bathroom"]));
    expect(apartmentInteriorWalls(laid, two.id).length).toBeGreaterThan(0);
    expect(linkSpaces(laid).faceBySpaceId.size).toBe(laid.spaces.length);
  });
});

describe("storey generator options", () => {
  it("puts corner types at the corners", { timeout: 20000 }, () => {
    const { building, storey } = upper(slab());
    const mix = [{ ...unit("Corner", 75, 2, 3), corner: true }, unit("Two", 55, 6, 2)];
    const result = proposeSplits(building, storey, mix, "corridor", rules, 1);
    if (!result.ok) throw new Error(result.reason);
    const plan = result.proposals[0].storey;
    const corners = describeApartments(plan).filter(
      (i) => plan.apartments.find((a) => a.id === i.apartmentId)?.unitType === "Corner",
    );
    expect(corners).toHaveLength(2);
    for (const info of corners) {
      const n = info.outline.length;
      const dirs = new Set(
        info.facadeEdges.map((e) => (Math.abs(info.outline[e].x - info.outline[(e + 1) % n].x) < 1e-6 ? "x" : "y")),
      );
      expect(dirs.size).toBe(2);
    }
  });

  it("gives no facade on a party wall", () => {
    const { building, storey } = upper(pointBlock());
    const mix = [unit("Two", 65, 2, 2), unit("One", 50, 2)];
    expect(proposeSplits(building, storey, mix, "hall", rules, 1).ok).toBe(true);
    // Every side a party wall: no flat has daylight, so there is no plan.
    const ring: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: 0.125, y: -1 }, { x: 0.125, y: 15 }],
      [{ x: 19.875, y: -1 }, { x: 19.875, y: 15 }],
      [{ x: -1, y: 0.125 }, { x: 21, y: 0.125 }],
      [{ x: -1, y: 13.875 }, { x: 21, y: 13.875 }],
    ];
    expect(proposeSplits(building, storey, mix, "hall", rules, 1, { blind: ring }).ok).toBe(false);
  });

  it("tries only the corridor layouts it is given", { timeout: 20000 }, () => {
    const { building, storey } = upper(slab());
    const mix = [unit("Two", 60, 4, 2), unit("One", 45, 4)];
    const result = proposeSplits(building, storey, mix, "corridor", rules, 3, {
      corridorLayouts: [{ axes: ["long"], anchor: "centre" }],
    });
    if (!result.ok) throw new Error(result.reason);
    // One plate: every proposal has the same corridor.
    const corridor = (i: number) => {
      const s = result.proposals[i].storey;
      return s.spaces.filter((x) => x.type === "corridor").length;
    };
    for (let i = 0; i < result.proposals.length; i++) expect(corridor(i)).toBe(corridor(0));
  });
});
