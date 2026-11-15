/**
 * Writes drawings as a DXF file (ASCII, release 12: the oldest and most widely
 * read flavour, which AutoCAD, Revit and the free viewers all open).
 *
 * The file is in metres at 1:1. DXF release 12 cannot say which unit it uses,
 * so the program that opens it has to be told "metres". The y axis is flipped,
 * because y points down in the model and up in a DXF.
 */
import { northArrow } from "./annotations.ts";
import { type Drawing, type Entity, type LayerKey, LAYER_KEYS, translateDrawing } from "./drawing.ts";
import type { ExportConfig, Sheet } from "./sheets.ts";

/** Numbers as short as they can be without losing a thousandth of a millimetre. */
const num = (v: number): string => {
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
};

/**
 * Text as a DXF group value: anything outside plain ASCII (Cyrillic, "²", "·")
 * is written as a \U+XXXX escape, which every reader understands whatever
 * code page it assumes.
 */
export function dxfText(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\r\n]+/g, " ")) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code < 127) out += ch;
    else if (code <= 0xffff) out += `\\U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += "?";
  }
  return out;
}

/**
 * Where each sheet's drawing goes in the one model space of a DXF file. A
 * single drawing stays at its true coordinates, so it lines up with the model
 * and with other exports of it. Several are laid side by side from left to
 * right, `gap` metres apart, each with its title underneath.
 */
export function arrangeForDxf(sheets: Sheet[], config: Pick<ExportConfig, "dxfGap" | "textHeightMm">): Drawing[] {
  const out: Drawing[] = [];
  let cursor: number | null = null;
  for (const sheet of sheets) {
    let drawing = sheet.drawing;
    const b = drawing.bounds;
    if (sheets.length > 1 && b) {
      if (cursor === null) cursor = b.minX;
      drawing = translateDrawing(drawing, cursor - b.minX, 0);
      cursor += b.maxX - b.minX + config.dxfGap;
    }
    const placed = drawing.bounds;
    const height = (config.textHeightMm * 2 * sheet.scale) / 1000;
    const title: Entity = {
      kind: "text",
      layer: "titles",
      at: placed
        ? { x: (placed.minX + placed.maxX) / 2, y: placed.maxY + height * 2 }
        : { x: cursor ?? 0, y: 0 },
      text: `${sheet.title} 1:${sheet.scale}`,
      height,
      bold: true,
    };
    // The north arrow stands beside the top right corner of the drawing.
    const size = sheet.north ? (sheet.north.sizeMm * sheet.scale) / 1000 : 0;
    const arrow =
      sheet.north && placed
        ? northArrow({ x: placed.maxX + size, y: placed.minY + size / 2 }, size, sheet.north.degrees)
        : [];
    out.push({ entities: [...drawing.entities, title, ...arrow], bounds: placed });
  }
  return out;
}

export function writeDxf(sheets: Sheet[], config: ExportConfig): string {
  const lines: string[] = [];
  const g = (code: number, value: string | number) => {
    lines.push(String(code), typeof value === "number" ? num(value) : value);
  };
  const layerName = (key: LayerKey) => config.layers[key].name;
  // Dashes 3 mm long with 1.5 mm gaps when plotted at the largest scale exported.
  const dash = (3 * Math.max(1, ...sheets.map((s) => s.scale))) / 1000;

  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$ACADVER");
  g(1, "AC1009");
  g(0, "ENDSEC");

  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LTYPE");
  g(70, "2");
  g(0, "LTYPE");
  g(2, "CONTINUOUS");
  g(70, "0");
  g(3, "Solid line");
  g(72, "65");
  g(73, "0");
  g(40, 0);
  g(0, "LTYPE");
  g(2, "DASHED");
  g(70, "0");
  g(3, "Dashed __ __ __");
  g(72, "65");
  g(73, "2");
  g(40, dash * 1.5);
  g(49, dash);
  g(49, -dash / 2);
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "LAYER");
  g(70, String(LAYER_KEYS.length));
  for (const key of LAYER_KEYS) {
    g(0, "LAYER");
    g(2, layerName(key));
    g(70, "0");
    g(62, String(config.layers[key].color));
    g(6, "CONTINUOUS");
  }
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "STYLE");
  g(70, "1");
  g(0, "STYLE");
  g(2, "STANDARD");
  g(70, "0");
  g(40, 0);
  g(41, 1);
  g(50, 0);
  g(71, "0");
  g(42, 0.2);
  g(3, "txt");
  g(4, "");
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  const polyline = (layer: LayerKey, points: { x: number; y: number }[], closed: boolean, dashed?: boolean) => {
    if (points.length < 2) return;
    if (points.length === 2 && !dashed) {
      g(0, "LINE");
      g(8, layerName(layer));
      g(10, points[0].x);
      g(20, -points[0].y);
      g(11, points[1].x);
      g(21, -points[1].y);
      return;
    }
    g(0, "POLYLINE");
    g(8, layerName(layer));
    if (dashed) g(6, "DASHED");
    g(66, "1");
    g(70, closed ? "1" : "0");
    for (const p of points) {
      g(0, "VERTEX");
      g(8, layerName(layer));
      g(10, p.x);
      g(20, -p.y);
    }
    g(0, "SEQEND");
    g(8, layerName(layer));
  };

  g(0, "SECTION");
  g(2, "ENTITIES");
  for (const drawing of arrangeForDxf(sheets, config)) {
    for (const e of drawing.entities) {
      switch (e.kind) {
        case "region":
          for (const poly of e.region) for (const ring of poly) polyline(e.layer, ring, true);
          break;
        case "polyline":
          polyline(e.layer, e.points, e.closed, e.dashed);
          break;
        case "arc": {
          // Flipping y turns every angle a into -a. A DXF arc runs anticlockwise
          // from its start angle to its end angle.
          const deg = (rad: number) => (((-rad * 180) / Math.PI) % 360 + 360) % 360;
          const from = e.sweep < 0 ? e.start : e.start + e.sweep;
          const to = e.sweep < 0 ? e.start + e.sweep : e.start;
          g(0, "ARC");
          g(8, layerName(e.layer));
          g(10, e.centre.x);
          g(20, -e.centre.y);
          g(40, e.radius);
          g(50, deg(from));
          g(51, deg(to));
          break;
        }
        case "text": {
          const width = e.text.length * e.height * 0.6;
          g(0, "TEXT");
          g(8, layerName(e.layer));
          g(10, e.at.x - width / 2);
          g(20, -e.at.y - e.height / 2);
          g(40, e.height);
          g(1, dxfText(e.text));
          // Flipping y turns the lettering the other way round.
          if (e.angle) g(50, (((-e.angle * 180) / Math.PI) % 360 + 360) % 360);
          g(72, "1"); // centred left to right ...
          g(73, "2"); // ... and top to bottom on the point below
          g(11, e.at.x);
          g(21, -e.at.y);
          break;
        }
      }
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return lines.join("\r\n") + "\r\n";
}
