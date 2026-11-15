import { describe, expect, it } from "vitest";
import layoutRules from "../config/layoutRules.json";
import { type AdjacencyRule, type Layout, generateLayouts } from "../roomSubdivision.ts";
import { parseLayoutRules } from "./autoLayout.ts";

const rules = parseLayoutRules(layoutRules);

const rect = (w: number, h: number) => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

/** A 13 x 8 m flat, facades north and east, entered from the south. */
const flat = { polygon: rect(13, 8), facadeEdges: [0, 1], entrance: { x: 4, y: 8 } };
const twoBed = { bedrooms: 2, bathrooms: 1, wc: 1, storage: 0, kitchen: "separate" as const };

const run = (extra: Partial<typeof rules> = {}, count = 3): Layout[] =>
  generateLayouts(flat, { ...rules, program: twoBed, ...extra }, count);

/** The room a room's door opens into. */
const doorOf = (layout: Layout, roomId: string) =>
  layout.doors
    .filter((d) => d.kind === "door" && d.rooms.includes(roomId))
    .map((d) => d.rooms.find((r) => r !== roomId)!);

const typeOf = (layout: Layout, id: string) => layout.rooms.find((r) => r.id === id)!.type;

describe("layout rules", { timeout: 30000 }, () => {
  it("reports every size, adjacency and circulation rule", () => {
    const [layout] = run({}, 1);
    const groups = new Set(layout.checks.map((c) => c.group));
    expect(groups).toEqual(new Set(["size", "adjacency", "circulation"]));
    // One size line per room besides corridors: living, two bedrooms, kitchen, bathroom, WC.
    expect(layout.checks.filter((c) => c.group === "size" && !c.text.startsWith("Corridors"))).toHaveLength(6);
    // Rules about rooms the flat does not have (storage, a second bathroom) are left out.
    for (const rule of rules.adjacency!) {
      const applies = rule.a !== "storage" && !(rule.a === "bathroom" && rule.b === "bathroom");
      expect(layout.checks.some((c) => c.text === rule.text)).toBe(applies);
    }
  });

  it("keeps the minimum size of each kind of room", () => {
    for (const layout of run()) {
      if (layout.relaxation < 1) continue;
      const sizes = rules.roomSizes!;
      const bedrooms = layout.rooms.filter((r) => r.type === "bedroom");
      expect(bedrooms).toHaveLength(2);
      // The engine measures on its grid; the net polygons lose a little at the walls.
      expect(Math.max(...bedrooms.map((r) => r.area))).toBeGreaterThan(sizes.mainBedroom.minArea - 0.5);
      for (const r of bedrooms) expect(r.area).toBeGreaterThan(sizes.bedroom.minArea - 0.5);
      const kitchen = layout.rooms.find((r) => r.type === "kitchen")!;
      expect(kitchen.area).toBeGreaterThan(sizes.kitchen.minArea - 0.5);
      for (const c of layout.checks.filter((c) => c.group === "size")) expect(c.ok).toBe(true);
    }
  });

  it("never breaks a hard rule", () => {
    const hard: AdjacencyRule[] = [
      { a: "bedroom", b: "corridor", rule: "opensTo", weight: 1, hard: true, text: "Bedrooms off a corridor" },
      { a: "kitchen", b: "living", rule: "opensTo", weight: 1, hard: true, text: "Kitchen off the living room" },
    ];
    const layouts = run({ adjacency: hard });
    expect(layouts.length).toBeGreaterThan(0);
    for (const layout of layouts) {
      for (const room of layout.rooms) {
        if (room.type === "bedroom") expect(doorOf(layout, room.id).map((id) => typeOf(layout, id))).toEqual(["corridor"]);
        if (room.type === "kitchen") expect(doorOf(layout, room.id).map((id) => typeOf(layout, id))).toEqual(["living"]);
      }
      expect(layout.checks.filter((c) => c.group === "adjacency").every((c) => c.ok)).toBe(true);
    }
  });

  it("says which rooms break a rule", () => {
    const strict = { ...rules.circulation!, maxWalk: 1 };
    const [layout] = run({ circulation: strict }, 1);
    const walk = layout.checks.find((c) => c.text.startsWith("Every room within"))!;
    expect(walk.ok).toBe(false);
    expect(walk.detail).toMatch(/farthest: .+ m/);
  });

  it("weighs the soft rules: a strong wish moves the bedrooms off the living room", () => {
    const offLiving: AdjacencyRule = {
      a: "bedroom",
      b: "living",
      rule: "notOpensTo",
      weight: 6,
      text: "Bedrooms open off the hall",
    };
    const [layout] = run({ adjacency: [offLiving] }, 1);
    for (const room of layout.rooms.filter((r) => r.type === "bedroom")) {
      expect(doorOf(layout, room.id).map((id) => typeOf(layout, id))).not.toContain("living");
    }
  });
});
