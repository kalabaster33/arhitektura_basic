/**
 * Runs the subdivision on a few test outlines, prints an ASCII plan for each
 * and writes SVGs to demo/out. Usage: npm run demo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLayouts, type ApartmentInput, type Layout, type Pt } from "../src/roomSubdivision.ts";

const rotate = (p: Pt, deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
};

const rect: ApartmentInput = {
  polygon: [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 8 }, { x: 0, y: 8 }],
  facadeEdges: [2],
  entrance: { x: 1.2, y: 0 },
};

const cases: Record<string, ApartmentInput> = {
  "rect-7x8": rect,
  "deep-5.5x10": {
    polygon: [{ x: 0, y: 0 }, { x: 5.5, y: 0 }, { x: 5.5, y: 10 }, { x: 0, y: 10 }],
    facadeEdges: [2],
    entrance: { x: 4.5, y: 0 },
  },
  "l-shape": {
    polygon: [
      { x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 9 }, { x: 0, y: 9 },
    ],
    facadeEdges: [1, 4],
    entrance: { x: 0, y: 2 },
  },
  "slanted": {
    polygon: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 9.5, y: 7 }, { x: 0, y: 7 }],
    facadeEdges: [1, 2],
    entrance: { x: 3, y: 0 },
  },
  "rect-rotated-30": {
    polygon: rect.polygon.map((p) => rotate(p, 30)),
    facadeEdges: rect.facadeEdges,
    entrance: rotate(rect.entrance, 30),
  },
  "corner-with-stack": {
    polygon: [{ x: 0, y: 0 }, { x: 8.4, y: 0 }, { x: 8.4, y: 6.3 }, { x: 0, y: 6.3 }],
    facadeEdges: [1, 2],
    entrance: { x: 0, y: 1.0 },
    plumbingStack: { x: 0.3, y: 3.2 },
  },
};

function inPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polyArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return Math.abs(s / 2);
}

const CHAR = { living: "L", bedroom: "B", bathroom: "w", corridor: "c", wc: "t", kitchen: "K", storage: "s" } as const;

function ascii(input: ApartmentInput, layout: Layout): string {
  const xs = input.polygon.map((p) => p.x), ys = input.polygon.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = 0.25;
  const lines: string[] = [];
  for (let y = y1 - step / 2; y > y0; y -= step) {
    let line = "";
    for (let x = x0 + step / 2; x < x1; x += step) {
      const p = { x, y };
      if (!inPoly(p, input.polygon)) { line += "  "; continue; }
      const room = layout.rooms.find((r) => inPoly(p, r.polygon));
      const door = layout.doors.find((d) => Math.hypot(d.position.x - x, d.position.y - y) < 0.3);
      line += (door ? "D" : room ? CHAR[room.type] : "?") + " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

const FILL = { living: "#f3e3b8", bedroom: "#c9d9ee", bathroom: "#bfe3dc", wc: "#bfe3dc", kitchen: "#f0d2b4", storage: "#ddd6cc", corridor: "#e4e0da" } as const;

function svg(input: ApartmentInput, layout: Layout): string {
  const xs = input.polygon.map((p) => p.x), ys = input.polygon.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const S = 60, M = 30;
  const tx = (p: Pt) => `${(M + (p.x - x0) * S).toFixed(1)},${(M + (y1 - p.y) * S).toFixed(1)}`;
  const n = input.polygon.length;
  const parts: string[] = [];
  for (const r of layout.rooms) {
    const d = [r.polygon, ...r.holes].map((ring) => "M" + ring.map(tx).join("L") + "Z").join("");
    const c = r.polygon.reduce((a, p) => ({ x: a.x + p.x / r.polygon.length, y: a.y + p.y / r.polygon.length }), { x: 0, y: 0 });
    parts.push(`<path d="${d}" fill="${FILL[r.type]}" stroke="none" fill-rule="evenodd"/>`);
    parts.push(`<text x="${tx(c).split(",")[0]}" y="${tx(c).split(",")[1]}" text-anchor="middle" font-family="sans-serif" font-size="13">${r.type} ${r.area.toFixed(1)} m²</text>`);
  }
  for (const z of layout.zones) {
    parts.push(`<path d="M${z.polygon.map(tx).join("L")}Z" fill="#f08c00" fill-opacity="0.18" stroke="#f08c00" stroke-dasharray="6 4"/>`);
    parts.push(`<path d="M${z.counter.map(tx).join("L")}Z" fill="#b08968" stroke="#5c4033"/>`);
  }
  for (const w of layout.walls) {
    const d = [w.polygon, ...w.holes].map((ring) => "M" + ring.map(tx).join("L") + "Z").join("");
    parts.push(`<path d="${d}" fill="#333" fill-rule="evenodd"/>`);
  }
  for (let i = 0; i < n; i++) {
    const facade = input.facadeEdges.includes(i);
    const [a, b] = [input.polygon[i], input.polygon[(i + 1) % n]];
    parts.push(`<path d="M${tx(a)}L${tx(b)}" stroke="${facade ? "#1c7ed6" : "#111"}" stroke-width="${facade ? 6 : 4}" stroke-linecap="round"/>`);
  }
  for (const d of layout.doors) {
    const [cx, cy] = tx(d.position).split(",");
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${d.kind === "opening" ? 3 : 7}" fill="${d.kind === "entrance" ? "#e03131" : "#fff"}" stroke="#333" stroke-width="2"/>`);
  }
  parts.unshift(`<rect width="100%" height="100%" fill="#fff"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * S + 2 * M}" height="${(y1 - y0) * S + 2 * M}">${parts.join("")}</svg>`;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(outDir, { recursive: true });

for (const [name, input] of Object.entries(cases)) {
  const t = performance.now();
  const layouts = generateLayouts(input, {}, 3);
  const ms = performance.now() - t;
  console.log(`\n=== ${name}  (${layouts.length} layouts, ${ms.toFixed(0)} ms) ===`);
  if (layouts.length === 0) { console.log("no valid layout"); continue; }
  const best = layouts[0];
  console.log(ascii(input, best));
  const total = polyArea(input.polygon);
  const sum = best.rooms.reduce((a, r) => a + r.area, 0);
  for (const r of best.rooms) {
    console.log(`  ${r.id.padEnd(11)} ${r.area.toFixed(2).padStart(6)} m2   facade ${r.facadeLength.toFixed(2)} m   ${r.polygon.length} vertices`);
  }
  const wallArea = best.walls.reduce((a, w) => a + polyArea(w.polygon) - w.holes.reduce((h, r) => h + polyArea(r), 0), 0);
  for (const z of best.zones) console.log(`  ${z.type.padEnd(11)} ${z.area.toFixed(2).padStart(6)} m2   (zone of ${z.room})`);
  console.log(`  rooms ${sum.toFixed(2)} + walls ${wallArea.toFixed(2)} / apartment ${total.toFixed(2)} m2   cost ${best.cost.toFixed(3)}   relaxation ${best.relaxation}`);
  console.log(`  doors: ${best.doors.map((d) => `${d.kind}[${d.rooms.join("-")}]`).join("  ")}`);
  layouts.forEach((l, i) => {
    const s = svg(input, l);
    writeFileSync(join(outDir, `${name}-${i + 1}.svg`), s);
    writeFileSync(join(outDir, `${name}-${i + 1}.png`), new Resvg(s).render().asPng());
  });
}
