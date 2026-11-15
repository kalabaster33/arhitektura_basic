/**
 * Writes sheets (core/sheets.ts) as a vector PDF, one page per sheet, each
 * drawn at its true scale with a title block. The PDF library is loaded only
 * when this runs.
 *
 * The built-in PDF fonts have no Cyrillic, so a font with it is embedded; the
 * caller passes the font files in (see fonts.ts).
 */
import { type Entity, arcPoints } from "../core/drawing.ts";
import type { Pt } from "../core/geometry.ts";
import { type ExportConfig, type Sheet, layoutSheet } from "../core/sheets.ts";

export interface PdfFonts {
  /** TrueType files. */
  regular: Uint8Array;
  bold: Uint8Array;
}

export interface PdfInfo {
  project: string;
  /** Date printed in the title block, already formatted. */
  date: string;
  /** Sheet size in millimetres. */
  paper: [number, number];
}

const FONT = "NotoSans";
/** Height of a capital letter as a share of the font size, for Noto Sans. */
const CAP_HEIGHT = 0.714;
const MM_PER_PT = 25.4 / 72;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The longest round length whose bar is at most `maxMm` long on paper. */
export function scaleBarLength(scale: number, maxMm: number): number {
  let best = 0.1;
  for (const m of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]) {
    if ((m * 1000) / scale <= maxMm) best = m;
  }
  return best;
}

export async function writePdf(
  sheets: Sheet[],
  config: ExportConfig,
  info: PdfInfo,
  fonts: PdfFonts,
): Promise<Uint8Array> {
  if (sheets.length === 0) throw new Error("There is nothing to export.");
  const { jsPDF } = await import("jspdf");
  const layouts = sheets.map((s) => layoutSheet(s.drawing.bounds, info.paper, s.scale, config));
  const short = Math.min(...info.paper);
  const long = Math.max(...info.paper);
  const doc = new jsPDF({ unit: "mm", format: [short, long], orientation: layouts[0].orientation });
  doc.addFileToVFS("NotoSans-Regular.ttf", toBase64(fonts.regular));
  doc.addFont("NotoSans-Regular.ttf", FONT, "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", toBase64(fonts.bold));
  doc.addFont("NotoSans-Bold.ttf", FONT, "bold");
  doc.setProperties({ title: info.project, creator: "Arhitektura" });

  const text = (
    value: string,
    x: number,
    y: number,
    sizePt: number,
    opts: { bold?: boolean; align?: "left" | "center" | "right"; baseline?: "middle" | "alphabetic" } = {},
  ) => {
    doc.setFont(FONT, opts.bold ? "bold" : "normal");
    doc.setFontSize(sizePt);
    doc.setTextColor(0);
    doc.text(value, x, y, { align: opts.align ?? "left", baseline: opts.baseline ?? "alphabetic" });
  };
  /**
   * Lettering centred on a point and turned by `angle` (radians, y down). The
   * library turns text about the start of its baseline, so that point is
   * worked out here.
   */
  const turnedText = (value: string, centre: Pt, capMm: number, angle: number) => {
    doc.setFont(FONT, "normal");
    doc.setFontSize(capMm / CAP_HEIGHT / MM_PER_PT);
    doc.setTextColor(0);
    const width = doc.getTextWidth(value);
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const up = { x: Math.sin(angle), y: -Math.cos(angle) };
    doc.text(
      value,
      centre.x - (dir.x * width) / 2 - (up.x * capMm) / 2,
      centre.y - (dir.y * width) / 2 - (up.y * capMm) / 2,
      { angle: (-angle * 180) / Math.PI },
    );
  };

  sheets.forEach((sheet, index) => {
    const layout = layouts[index];
    if (index > 0) doc.addPage([short, long], layout.orientation);
    const k = 1000 / sheet.scale;
    const at = (p: Pt): Pt => ({ x: layout.offset.x + p.x * k, y: layout.offset.y + p.y * k });
    const trace = (ring: Pt[], closed: boolean) => {
      ring.forEach((p, i) => {
        const q = at(p);
        if (i === 0) doc.moveTo(q.x, q.y);
        else doc.lineTo(q.x, q.y);
      });
      if (closed) doc.close();
    };

    const draw = (e: Entity) => {
      doc.setLineWidth(config.lineWeightMm[e.layer]);
      doc.setDrawColor(0);
      doc.setLineDashPattern([], 0);
      switch (e.kind) {
        case "region": {
          // Walls are filled dark, the footprint on the site plan light.
          const grey = e.layer === "walls" ? 110 : 222;
          doc.setFillColor(grey, grey, grey);
          for (const poly of e.region) for (const ring of poly) if (ring.length >= 3) trace(ring, true);
          if (e.filled) doc.fillStrokeEvenOdd();
          else doc.stroke();
          break;
        }
        case "polyline":
          if (e.points.length < 2) break;
          if (e.dashed) doc.setLineDashPattern([3, 1.5], 0);
          trace(e.points, e.closed);
          doc.stroke();
          break;
        case "arc":
          trace(arcPoints(e, 24), false);
          doc.stroke();
          break;
        case "text": {
          const p = at(e.at);
          if (e.angle !== undefined) {
            turnedText(e.text, p, e.height * k, e.angle);
            break;
          }
          text(e.text, p.x, p.y, (e.height * k) / CAP_HEIGHT / MM_PER_PT, {
            bold: e.bold,
            align: "center",
            baseline: "middle",
          });
          break;
        }
      }
    };
    // Shapes first, lettering on top.
    for (const e of sheet.drawing.entities) if (e.kind !== "text") draw(e);
    for (const e of sheet.drawing.entities) if (e.kind === "text") draw(e);

    // Border and title block.
    const { frame, titleBlock: t } = layout;
    doc.setLineDashPattern([], 0);
    doc.setDrawColor(0);
    doc.setLineWidth(0.35);
    doc.rect(frame.x, frame.y, frame.w, frame.h + t.h);
    doc.line(t.x, t.y, t.x + t.w, t.y);
    const columns = [0.38, 0.64, 0.84].map((share) => t.x + t.w * share);
    doc.setLineWidth(0.18);
    for (const x of columns) doc.line(x, t.y, x, t.y + t.h);
    const pad = 2.5;

    text(info.project, t.x + pad, t.y + 6, 11, { bold: true });
    text(sheet.title, t.x + pad, t.y + 12, 9);

    sheet.notes.slice(0, 4).forEach((note, i) => text(note, columns[0] + pad, t.y + 4.2 + i * 3.4, 7));

    text(`Scale 1:${sheet.scale}`, columns[1] + pad, t.y + 6, 9, { bold: true });
    const barMetres = scaleBarLength(sheet.scale, columns[2] - columns[1] - 2 * pad - 8);
    const barMm = barMetres * k;
    const bx = columns[1] + pad;
    const by = t.y + 10.5;
    doc.setLineWidth(0.25);
    doc.line(bx, by, bx + barMm, by);
    for (const f of [0, 0.5, 1]) doc.line(bx + barMm * f, by - 1, bx + barMm * f, by + 1);
    text("0", bx, by + 4, 6.5, { align: "center" });
    text(`${barMetres} m`, bx + barMm, by + 4, 6.5, { align: "center" });

    text(info.date, columns[2] + pad, t.y + 6, 9);
    text(`Sheet ${index + 1} of ${sheets.length}`, columns[2] + pad, t.y + 12, 9);
  });

  return new Uint8Array(doc.output("arraybuffer"));
}
