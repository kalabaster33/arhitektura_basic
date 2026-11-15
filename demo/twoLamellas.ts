/**
 * Builds a residential block of two lamellas and writes it as a project file.
 *
 *   - 18 x 88 m on the upper floors: a 2.2 m erker on every side over a
 *     13.6 x 83.6 m ground floor; ground floor + 5, about 9 000 m2 gross.
 *   - Two equal lamellas, each with its own entrance, hall, stairs and
 *     elevator in the middle of its length, on the north-west side.
 *   - A 4.4 m passage through the ground floor between the lamellas; the
 *     upper floors bridge it (the erkers of the lamellas' inner ends).
 *   - Corridor access; the two corners at each lamella's outer end are
 *     three-bedroom flats of about 80 m2; the rest are one-bedroom flats of
 *     about 50 m2 on the upper floors and two-bedroom flats on the ground floor.
 *   - Ground-floor flats get 5 m deep private yards.
 *   - North 45 degrees counter-clockwise from the top of the plan.
 *
 * Each lamella is divided on its own, as a separate block with its inner end
 * marked as a party wall, then copied into the real building. The flats are
 * then laid out room by room with the layout rules, on the ground floor and
 * floor 1; floors 2 to 5 are copies of floor 1.
 *
 * Usage: npx tsx demo/twoLamellas.ts [out.json]
 */
import { writeFileSync } from "node:fs";
import areaDefinitions from "../src/config/areaDefinitions.json" with { type: "json" };
import editorDefaults from "../src/config/editorDefaults.json" with { type: "json" };
import layoutRulesJson from "../src/config/layoutRules.json" with { type: "json" };
import splitJson from "../src/config/storeySplit.json" with { type: "json" };
import windowJson from "../src/config/windowRules.json" with { type: "json" };
import { describeApartments } from "../src/core/apartments.ts";
import roomChecksJson from "../src/config/roomChecks.json" with { type: "json" };
import { computeBuildingAreas, parseAreaConfig } from "../src/core/areas.ts";
import { checkStoreyPlan, parseRoomCheckConfig } from "../src/core/checks.ts";
import coreJson from "../src/config/coreAlignment.json" with { type: "json" };
import { checkCoreAlignment, parseCoreConfig } from "../src/core/coreAlignment.ts";
import { parseLayoutRules, proposeLayouts } from "../src/core/autoLayout.ts";
import { addStorey, copyStorey, sortedStoreys } from "../src/core/building.ts";
import { applyWalls, updateSpace } from "../src/core/edit.ts";
import type { Pt } from "../src/core/geometry.ts";
import { newId } from "../src/core/ids.ts";
import type { Apartment, Building, Project, Storey, Wall } from "../src/core/model.ts";
import {
  addOpening,
  locateOnWall,
  openingGeometry,
  openingSides,
  wallFreeSpans,
} from "../src/core/openings.ts";
import { createProject, replaceStorey, serializeProject } from "../src/core/project.ts";
import { linkSpaces } from "../src/core/spaces.ts";
import { type UnitType, parseSplitRules, proposeSplits, usableArea } from "../src/core/storeySplit.ts";
import {
  addCoreElement,
  addEntrance,
  rebuildStructure,
  setAllErkerEdges,
  setErkerDepth,
  setErkerEdge,
  setFootprint,
  setStage,
} from "../src/core/structure.ts";
import { parseWindowRules } from "../src/core/windows.ts";

const OUT = process.argv[2] ?? "demo/out/two-lamellas.json";

// ------------------------------------------------------------------ figures
const WIDTH = 18; // upper floors, outside faces, erkers included
const LENGTH = 88;
const ERKER = 2.2; // upper floors project this far on every side
const LAMELLA = LENGTH / 2; // 44 m, upper floors
const UPPER_FLOORS = 5;
const YARD = 5;
const T = editorDefaults.wallThickness.exterior; // 0.25
// Outside wall centrelines: ground floor, and the upper floors.
const GX0 = ERKER + T / 2;
const GX1 = WIDTH - ERKER - T / 2;
const UX0 = T / 2;
const UX1 = WIDTH - T / 2;
// The ends of the lamellas at the passage, on the ground floor (wall centrelines).
const PASS_A = LAMELLA - ERKER - T / 2;
const PASS_B = LAMELLA + ERKER + T / 2;
const PARTY = 0.25; // wall between the lamellas
/**
 * The flats besides the corners. On the 18 m deep upper floors the flats are
 * about 8 m deep: a two-bedroom flat needs a living room and two bedrooms side
 * by side on the facade, about 8 m of it, so below about 62 m2 none fits.
 * There the flats are one-bedroom flats of about 50 m2. The ground floor is
 * 13.6 m deep, its flats about 5.8 m: two-bedroom flats of 50 to 54 m2 fit.
 */
interface Flat {
  name: string;
  area: number;
  bedrooms: number;
}
const UPPER_FLAT: Flat = { name: "One-bedroom", area: Number(process.env.UPPER_AREA ?? 50), bedrooms: 1 };
const GROUND_FLAT: Flat = { name: "Two-bedroom", area: Number(process.env.GROUND_AREA ?? 54), bedrooms: 2 };
/**
 * Three-bedroom corner flats per lamella on the ground floor. Its north-west
 * side is cut by the core into two pieces of only 5.8 m depth, too shallow for
 * a three-bedroom flat of 80 m2 there; the outer south-east corner takes one.
 */
const GROUND_CORNERS = Number(process.env.GROUND_CORNERS ?? 1);

const rules = parseSplitRules(splitJson);
const layoutRules = parseLayoutRules(layoutRulesJson);
const windowRules = parseWindowRules(windowJson);
const areaConfig = parseAreaConfig(areaDefinitions);
const applyOptions = {
  partitionThickness: editorDefaults.wallThickness.interior,
  door: editorDefaults.openings.door,
  snap: editorDefaults.snapStep,
  windows: windowRules,
};

type Rect = [kind: "hall" | "stair" | "elevator", x0: number, y0: number, x1: number, y1: number];

/** Core of lamella A, in the middle of its length on the north-west side; lamella B mirrors it. */
const CORE_A: Rect[] = [
  ["hall", GX0, 20.5, 9.9, 23.5],
  // Two flights along the hall, 5.4 x 2.6 m, lit from the facade.
  ["stair", GX0, 23.5, GX0 + 5.4, 26.1],
  // Opposite the stairs, against the corridor.
  ["elevator", 6.1, 18.5, 8.1, 20.5],
];
const mirror = ([k, x0, y0, x1, y1]: Rect): Rect => [k, x0, LENGTH - y1, x1, LENGTH - y0];
const CORE_B = CORE_A.map(mirror);

const prog = (bedrooms: number, bathrooms = 1) => ({ bedrooms, bathrooms, wc: 0, storage: 0, kitchen: "open" as const });

// ------------------------------------------------------------------ helpers
const log = (...a: unknown[]) => console.log(...a);
const fmt = (v: number) => v.toFixed(1);

function newBuilding(name: string, corners: Pt[], erkerOn: (a: Pt, b: Pt) => boolean, core: Rect[]): Project {
  let p = createProject(name, editorDefaults.snapStep, {
    shell: editorDefaults.wallThickness.exterior,
    // As thick as the facade: on the ground floor the stairs stand against the
    // facade, above it against the lobby, and must line up on every floor.
    core: T,
  });
  const id = p.site.buildings[0].id;
  p = setFootprint(p, id, corners);
  p = setAllErkerEdges(p, id, false);
  p = setErkerDepth(p, id, ERKER);
  const fp = p.site.buildings[0].structure.footprint;
  fp.forEach((a, i) => {
    if (erkerOn(a, fp[(i + 1) % fp.length])) p = setErkerEdge(p, id, i, true);
  });
  p = addStorey(p, id).project;
  for (const [kind, x0, y0, x1, y1] of core) {
    const r = addCoreElement(p, id, kind, { x: x0, y: y0 }, { x: x1, y: y1 });
    if (!r.id) throw new Error(`${name}: could not place the ${kind}`);
    p = r.project;
  }
  return rebuildStructure(p, id);
}

const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const onLine = (axis: "x" | "y", v: number) => (a: Pt, b: Pt) => Math.abs(a[axis] - v) < 1e-6 && Math.abs(b[axis] - v) < 1e-6;

function spaceAt(storey: Storey, pt: Pt): string | null {
  const linked = linkSpaces(storey);
  for (const s of storey.spaces) {
    const f = linked.faceBySpaceId.get(s.id);
    if (!f) continue;
    // pointInPolygon from the face
    const inside = ((): boolean => {
      const inRing = (ring: Pt[]) => {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i];
          const b = ring[j];
          if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
        }
        return c;
      };
      return inRing(f.outer) && !f.holes.some(inRing);
    })();
    if (inside) return s.id;
  }
  return null;
}

/** A door between the two rooms either side of a point on a wall of the given kind. */
function doorAt(storey: Storey, at: Pt, width: number, height: number, wallOk: (w: Wall) => boolean): Storey {
  const hit = locateOnWall({ ...storey, walls: storey.walls.filter(wallOk) }, at, 0.05);
  if (!hit) throw new Error(`no wall at ${at.x}, ${at.y}`);
  const next = addOpening(storey, hit.wallId, "door", hit.offset, { width, height, sill: 0 });
  if (next === storey) throw new Error(`no room for a door at ${at.x}, ${at.y}`);
  return next;
}

/** Splits a lamella, given as a separate block, into apartments; its inner end is a party wall. */
function splitLamella(block: Project, storeyIndex: number, mix: UnitType[], blindY: number, label: string): Storey {
  const b = block.site.buildings[0];
  const storey = sortedStoreys(b)[storeyIndex];
  const t0 = Date.now();
  // The solver scales every flat to fill the floor: fewer of the other flats
  // until they come out near the wanted size (and the plan divides at all).
  // The corridor along the lamella, flush with the far side of the hall: in the middle of the depth.
  const opts = {
    blind: [[{ x: -1, y: blindY }, { x: WIDTH + 1, y: blindY }]] as [Pt, Pt][],
    corridorLayouts: [{ axes: ["long" as const], anchor: "high" as const }],
  };
  const want = mix[1].area;
  let result = proposeSplits(b, storey, mix, "corridor", rules, 1, opts);
  for (let n = mix[1].count - 1; n >= 1; n--) {
    if (result.ok) {
      const twos = result.proposals[0].apartments.filter((a) => a.unitType === mix[1].name);
      const mean = twos.reduce((sum, a) => sum + a.area, 0) / twos.length;
      if (mean >= want - 2) break;
      log(`  ${label}: ${n + 1} ${mix[1].name} flats come out at ${fmt(mean)} m2, trying ${n}`);
    } else log(`  ${label}: no plan with ${n + 1} ${mix[1].name} flats, trying ${n}`);
    result = proposeSplits(b, storey, [mix[0], { ...mix[1], count: n }], "corridor", rules, 1, opts);
  }
  if (!result.ok) throw new Error(`${label}: ${result.reason}`);
  const q = result.proposals[0];
  log(
    `${label}: ${q.apartments.length} flats in ${((Date.now() - t0) / 1000).toFixed(1)} s ·`,
    q.apartments.map((a) => `${a.name} ${a.unitType} ${fmt(a.area)}`).join(", "),
  );
  return q.storey;
}

/**
 * Copies the apartments of a lamella block onto the real storey: their walls
 * (ends on the block's inner wall moved onto the real party wall), their doors,
 * the room names and the apartments themselves, renamed with the lamella's letter.
 */
function transplant(target: Storey, source: Storey, letter: "A" | "B", snapY: [number, number] | null): Storey {
  const snap = (p: Pt): Pt => (snapY && Math.abs(p.y - snapY[0]) < 1e-6 ? { x: p.x, y: snapY[1] } : p);
  const own = source.walls.filter((w) => !w.part).map((w) => ({ ...w, id: newId("wall"), a: snap(w.a), b: snap(w.b) }));
  let s = applyWalls(target, [...target.walls, ...own]);
  const ownIds = new Set(own.map((w) => w.id));

  for (const o of source.openings) {
    const wall = source.walls.find((w) => w.id === o.wallId)!;
    if (o.entrance || wall.part === "shell") continue;
    const at = snap(openingGeometry(wall, o).centre);
    const ok = wall.part === "core" ? (w: Wall) => w.part === "core" : (w: Wall) => ownIds.has(w.id) || (!w.part && !w.part);
    const hit = locateOnWall({ ...s, walls: s.walls.filter(ok) }, at, 0.05);
    if (!hit) throw new Error(`lamella ${letter}: lost a door at ${at.x}, ${at.y}`);
    const next = addOpening(s, hit.wallId, o.kind, hit.offset, { width: o.width, height: o.height, sill: o.sill });
    if (next === s) throw new Error(`lamella ${letter}: no room for a door at ${at.x}, ${at.y}`);
    s = next;
  }

  const rename = (name: string) => name.replace(/^A(\d+)/, `${letter}$1`).replace(/^Corridor/, `Corridor ${letter}`);
  const ids = new Map<string, string>();
  for (const sp of source.spaces) {
    if (!["room", "corridor"].includes(sp.type)) continue;
    const id = spaceAt(s, snap(sp.anchor));
    if (!id) throw new Error(`lamella ${letter}: lost the room ${sp.name}`);
    ids.set(sp.id, id);
    s = updateSpace(s, id, { name: rename(sp.name), type: sp.type });
  }
  const apartments: Apartment[] = source.apartments.map((a) => ({
    ...a,
    id: newId("apartment"),
    name: rename(a.name),
    spaceIds: a.spaceIds.map((id) => ids.get(id)!),
  }));
  return { ...s, apartments: [...s.apartments, ...apartments] };
}

/** Corner flats of 80 m2 and as many of the other flats as fill the rest. */
function mixFor(usable: number, corridor: number, flat: Flat, corners: number): UnitType[] {
  const left = usable - corridor - corners * 80;
  const count = Math.max(1, Math.round(left / flat.area));
  return [
    { name: "Three-bedroom corner", area: 80, count: corners, program: prog(3), corner: true },
    { name: flat.name, area: flat.area, count, program: prog(flat.bedrooms) },
  ];
}

// --------------------------------------------------------------- the blocks
const everySide = () => true;
// Each lamella on its own: its ground floor up to the passage, the erker all round.
// On the upper floors the erker strip in front of the hall and stairs is no
// place for a flat: there the core reaches the facade (it becomes a lobby).
const toFacade = (c: Rect[]): Rect[] => c.map(([k, x0, y0, x1, y1]) => [k, x0 === GX0 ? UX0 : x0, y0, x1, y1]);
const blockA = newBuilding("A", rect(ERKER, ERKER, WIDTH - ERKER, LAMELLA - ERKER), everySide, CORE_A);
const blockB = newBuilding("B", rect(ERKER, LAMELLA + ERKER, WIDTH - ERKER, LENGTH - ERKER), everySide, CORE_B);
const upperA = newBuilding("A", rect(ERKER, ERKER, WIDTH - ERKER, LAMELLA - ERKER), everySide, toFacade(CORE_A));
const upperB = newBuilding("B", rect(ERKER, LAMELLA + ERKER, WIDTH - ERKER, LENGTH - ERKER), everySide, toFacade(CORE_B));

const plans: Record<"A" | "B", Storey[]> = { A: [], B: [] };
for (const [letter, ground, upper, innerGround, innerUpper] of [
  ["A", blockA, upperA, PASS_A, LAMELLA - T / 2],
  ["B", blockB, upperB, PASS_B, LAMELLA + T / 2],
] as const) {
  for (const [index, inner, name] of [
    [0, innerGround, "ground floor"],
    [1, innerUpper, "upper floors"],
  ] as const) {
    const block = index === 0 ? ground : upper;
    const b = block.site.buildings[0];
    const storey = sortedStoreys(b)[index];
    const usable = usableArea(b, storey.id, rules)!;
    const length = index === 0 ? LAMELLA - 2 * ERKER : LAMELLA;
    const flat = index === 0 ? GROUND_FLAT : UPPER_FLAT;
    const corners = index === 0 ? GROUND_CORNERS : 2;
    const mix = mixFor(usable, 1.8 * length, flat, corners);
    log(`Lamella ${letter}, ${name}: ${fmt(usable)} m2 for flats and corridor; mix ${corners} x 80 + ${mix[1].count} x ${flat.area} (${flat.name})`);
    plans[letter].push(splitLamella(block, index, mix, inner, `Lamella ${letter}, ${name}`));
  }
}

// ---------------------------------------------------------- the real block
let project = newBuilding("Two lamellas, G+5", rect(ERKER, ERKER, WIDTH - ERKER, LENGTH - ERKER), everySide, [...CORE_A, ...CORE_B]);
const buildingId = project.site.buildings[0].id;
const storeyAt = (i: number) => sortedStoreys(project.site.buildings[0])[i];
const ext = (w: Wall) => w.part === "shell";
const core = (w: Wall) => w.part === "core";

// Ground floor: the passage, the two entrances, then the lamellas' flats.
{
  let g = storeyAt(0);
  const cross = (y: number): Wall => ({ id: newId("wall"), a: { x: GX0, y }, b: { x: GX1, y }, thickness: T, kind: "interior" });
  g = applyWalls(g, [...g.walls, cross(PASS_A), cross(PASS_B)]);
  const passage = spaceAt(g, { x: WIDTH / 2, y: LAMELLA })!;
  g = updateSpace(g, passage, { name: "Passage", type: "other" });
  // Open at both ends: a gate-wide opening in each outside wall.
  for (const x of [GX0, GX1]) g = doorAt(g, { x, y: LAMELLA }, PASS_B - PASS_A - T - 0.1, 3.0, ext);
  // Entrances into the halls, from the north-west side.
  for (const [, , y0, , y1] of [CORE_A[0], CORE_B[0]]) {
    const hit = locateOnWall({ ...g, walls: g.walls.filter(ext) }, { x: GX0, y: (y0 + y1) / 2 }, 0.05)!;
    const next = addEntrance(g, hit.wallId, hit.offset, editorDefaults.entranceDoor);
    if (next === g) throw new Error("no room for an entrance");
    g = next;
  }
  g = transplant(g, plans.A[0], "A", null);
  g = transplant(g, plans.B[0], "B", null);
  project = replaceStorey(project, g);
}
// Floor 1: the party wall between the lamellas, then their flats.
{
  let f = storeyAt(1);
  const party: Wall = { id: newId("wall"), a: { x: UX0, y: LAMELLA }, b: { x: UX1, y: LAMELLA }, thickness: PARTY, kind: "interior" };
  // The lobbies: the erker strip in front of each hall and stairs, closed off from the flats.
  const lobbyWalls: Wall[] = [];
  for (const c of [CORE_A, CORE_B]) {
    const y0 = Math.min(c[0][2], c[1][2]);
    const y1 = Math.max(c[0][4], c[1][4]);
    for (const y of [y0, y1]) {
      lobbyWalls.push({ id: newId("wall"), a: { x: UX0, y }, b: { x: GX0, y }, thickness: T, kind: "interior" });
    }
  }
  f = applyWalls(f, [...f.walls, party, ...lobbyWalls]);
  for (const c of [CORE_A, CORE_B]) {
    const [, , hy0, , hy1] = c[0];
    const id = spaceAt(f, { x: (UX0 + GX0) / 2, y: (hy0 + hy1) / 2 })!;
    f = updateSpace(f, id, { name: "Lobby", type: "corridor" });
    f = doorAt(f, { x: GX0, y: (hy0 + hy1) / 2 }, 1.2, 2.1, core);
    const [, , sy0, , sy1] = c[1];
    const hit = locateOnWall({ ...f, walls: f.walls.filter(ext) }, { x: UX0, y: (sy0 + sy1) / 2 }, 0.05)!;
    f = addOpening(f, hit.wallId, "window", hit.offset, { width: 1.8, height: 1.5, sill: 0.9 });
  }
  f = transplant(f, plans.A[1], "A", [LAMELLA - T / 2, LAMELLA]);
  f = transplant(f, plans.B[1], "B", [LAMELLA + T / 2, LAMELLA]);
  project = replaceStorey(project, f);
}
// Doors from each hall into its stairs and elevator, on both storeys.
for (const i of [0, 1]) {
  let s = storeyAt(i);
  for (const c of [CORE_A, CORE_B]) {
    const [, , hy0, , hy1] = c[0];
    const [, sx0, sy0, sx1, sy1] = c[1];
    const [, ex0, ey0, ex1, ey1] = c[2];
    const yStair = sy0 === hy1 ? sy0 : sy1; // the side the stairs share with the hall
    const yLift = ey0 === hy1 ? ey0 : ey1;
    void hy0;
    s = doorAt(s, { x: (sx0 + sx1) / 2, y: yStair }, 1.0, 2.1, core);
    s = doorAt(s, { x: (ex0 + ex1) / 2, y: yLift }, 0.9, 2.1, core);
  }
  project = replaceStorey(project, s);
}

// ---------------------------------------------------------- rooms per flat
const report = new Map<string, { met: number; total: number; examples: string[] }>();
for (const i of [0, 1]) {
  let s = storeyAt(i);
  const t0 = Date.now();
  const failed: string[] = [];
  for (const a of s.apartments) {
    const r = proposeLayouts(s, a.id, layoutRules, applyOptions, 3, a.program);
    if (!r.ok) {
      failed.push(`${a.name}: ${r.reason}`);
      continue;
    }
    s = r.proposals[0].storey;
    for (const c of r.proposals[0].checks) {
      const key = `${c.group}: ${c.text.replace(/^(Bedroom|Bathroom) \d/, "$1").replace(/^(Bedroom|Bedroom \d) at least/, "Bedroom at least")}`;
      const e = report.get(key) ?? { met: 0, total: 0, examples: [] as string[] };
      e.total++;
      if (c.ok) e.met++;
      else if (e.examples.length < 3 && c.detail) e.examples.push(`${a.name} ${c.detail}`);
      report.set(key, e);
    }
  }
  log(`${s.name}: rooms in ${s.apartments.length - failed.length} of ${s.apartments.length} flats, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const f of failed) log(`  no layout: ${f}`);
  project = replaceStorey(project, s);
}

// --------------------------------------------------------------- the yards
{
  let g = storeyAt(0);
  const infos = describeApartments(g);
  const fences: Wall[] = [];
  const yards: { name: string; side: number; y0: number; y1: number; apartmentId: string }[] = [];
  const fence = (a: Pt, b: Pt): Wall => ({ id: newId("wall"), a, b, thickness: 0.05, kind: "interior" });
  for (const info of infos) {
    const n = info.outline.length;
    for (const e of info.facadeEdges) {
      const a = info.outline[e];
      const b = info.outline[(e + 1) % n];
      if (Math.abs(a.x - b.x) > 1e-6) continue; // long sides only
      const side = Math.abs(a.x - GX0) < 1e-6 ? -1 : Math.abs(a.x - GX1) < 1e-6 ? 1 : 0;
      if (side === 0 || Math.abs(a.y - b.y) < 2) continue;
      yards.push({ name: info.name, side, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), apartmentId: info.apartmentId });
    }
  }
  const seen = new Set<string>();
  for (const y of yards) {
    const wallX = y.side < 0 ? GX0 : GX1;
    const outX = y.side < 0 ? ERKER - YARD : WIDTH - ERKER + YARD;
    for (const yy of [y.y0, y.y1]) {
      const key = `${y.side}:${yy.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fences.push(fence({ x: wallX, y: yy }, { x: outX, y: yy }));
    }
    fences.push(fence({ x: outX, y: y.y0 }, { x: outX, y: y.y1 }));
  }
  g = applyWalls(g, [...g.walls, ...fences]);
  let gardenDoors = 0;
  for (const y of yards) {
    const id = spaceAt(g, { x: y.side < 0 ? ERKER - YARD / 2 : WIDTH - ERKER + YARD / 2, y: (y.y0 + y.y1) / 2 });
    if (!id) throw new Error(`no yard face for ${y.name}`);
    g = updateSpace(g, id, { name: `Yard ${y.name}`, type: "yard" });
    // A garden door from the living room where it lies along the yard, else from another room.
    const apartment = g.apartments.find((a) => a.id === y.apartmentId)!;
    const rank = (sid: string) => ["living", "bedroom", "kitchen"].indexOf(g.spaces.find((sp) => sp.id === sid)?.type ?? "");
    const rooms = apartment.spaceIds.filter((sid) => rank(sid) >= 0).sort((p, q) => rank(p) - rank(q));
    const wall = g.walls.find((w) => w.part === "shell" && Math.abs(w.a.x - w.b.x) < 1e-6 && Math.abs(w.a.x - (y.side < 0 ? GX0 : GX1)) < 1e-6 && Math.min(w.a.y, w.b.y) <= y.y0 + 1e-6 && Math.max(w.a.y, w.b.y) >= y.y1 - 1e-6);
    if (!wall) continue;
    const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
    const toY = (offset: number) => wall.a.y + ((wall.b.y - wall.a.y) * offset) / len;
    const tryRoom = (room: string): boolean => {
      for (const [start, end] of wallFreeSpans(g, wall)) {
        const mid = (start + end) / 2;
        if (toY(mid) < y.y0 || toY(mid) > y.y1 || end - start < 1.2) continue;
        const probe = { id: "p", wallId: wall.id, kind: "door" as const, offset: mid, width: 0.1, height: 2, sill: 0 };
        if (!openingSides(g, probe).includes(room)) continue;
        const next = addOpening(g, wall.id, "door", end - 0.1 - 0.5, { width: 1.0, height: 2.2, sill: 0 });
        if (next !== g) {
          g = next;
          return true;
        }
      }
      // No free wall: the room's stretch of facade is shared out again, a
      // garden door at one end and a narrower window beside it.
      const win = g.openings.find((o) => {
        if (o.wallId !== wall.id || o.kind !== "window" || toY(o.offset) < y.y0 || toY(o.offset) > y.y1) return false;
        return openingSides(g, o).includes(room);
      });
      if (!win) return false;
      const without = { ...g, openings: g.openings.filter((o) => o !== win) };
      const span = wallFreeSpans(without, wall).find(([a, b]) => a <= win.offset && win.offset <= b);
      if (!span) return false;
      const [start, end] = span;
      const door = 1.0;
      const clear = 0.2;
      const pier = 0.4;
      const windowWidth = Math.min(win.width, end - start - 2 * clear - door - pier);
      if (windowWidth < 0.6) return false;
      let next = addOpening(without, wall.id, "door", end - clear - door / 2, { width: door, height: 2.2, sill: 0 });
      if (next === without) return false;
      const room0 = next;
      next = addOpening(next, wall.id, "window", start + clear + windowWidth / 2, { width: windowWidth, height: win.height, sill: win.sill });
      if (next === room0) return false;
      g = next;
      return true;
    };
    if (rooms.some(tryRoom)) gardenDoors++;
    else log(`  no garden door for the yard of ${y.name}`);
  }
  log(`Ground floor: ${yards.length} yards of ${YARD} m, ${gardenDoors} garden doors`);
  project = replaceStorey(project, g);
}

// ------------------------------------------------- floors 2 to 5, north, step
for (let n = 2; n <= UPPER_FLOORS; n++) project = copyStorey(project, storeyAt(1).id).project;
project = { ...project, site: { ...project.site, north: 315 } };
project = setStage(project, "apartments");
void buildingId;

// ---------------------------------------------------------------- summary
const b: Building = project.site.buildings[0];
const areas = computeBuildingAreas(b, areaConfig);
log(`\nStoreys: ${b.storeys.length} · gross ${fmt(areas.totals.gross)} m2 · net ${fmt(areas.totals.net)} m2`);
for (const s of areas.storeys) log(`  ${s.name}: gross ${fmt(s.totals.gross)} m2`);
const flats = b.storeys.flatMap((s) => s.apartments);
const byType = new Map<string, number>();
for (const a of flats) byType.set(a.unitType ?? "?", (byType.get(a.unitType ?? "?") ?? 0) + 1);
log(`Flats: ${flats.length} · ${[...byType].map(([k, v]) => `${v} ${k}`).join(", ")}`);
// Plan checks on every storey, and whether the corner flats got their corners.
const checkConfig = parseRoomCheckConfig(roomChecksJson);
for (const s of sortedStoreys(b)) {
  const issues = checkStoreyPlan(s, checkConfig);
  const cornerFlats = s.apartments.filter((a) => a.unitType === "Three-bedroom corner").length;
  const corners = describeApartments(s).filter((info) => {
    if (s.apartments.find((a) => a.id === info.apartmentId)?.unitType !== "Three-bedroom corner") return false;
    const n = info.outline.length;
    const dirs = new Set(
      info.facadeEdges.map((e) => (Math.abs(info.outline[e].x - info.outline[(e + 1) % n].x) < 1e-6 ? "x" : "y")),
    );
    return dirs.size === 2;
  }).length;
  const kinds = [...new Set(issues.map((i) => i.message.replace(/"[^"]*"/g, "…")))];
  log(`  ${s.name}: ${issues.length} plan warnings${kinds.length ? ` (${kinds.join("; ")})` : ""}; three-bedroom flats on a corner: ${corners} of ${cornerFlats}`);
}
const coreIssues = checkCoreAlignment(b, parseCoreConfig(coreJson));
log(`  Core: ${coreIssues.length === 0 ? "stairs, elevators and halls line up on every floor" : coreIssues.map((c) => c.message).join("; ")}`);
log("\nRule report, all laid-out flats on the ground floor and floor 1:");
for (const [k, v] of [...report].sort()) log(`  ${v.met === v.total ? "ok " : "   "} ${v.met}/${v.total}  ${k}${v.examples.length ? `  (e.g. ${v.examples.join("; ")})` : ""}`);
writeFileSync(OUT, serializeProject(project));
log(`\nWritten: ${OUT}`);
