/**
 * Writes an area schedule (core/exportSchedule.ts) as an XLSX workbook.
 * The spreadsheet library is loaded only when this runs.
 */
import { type CellKind, type Schedule, cellValue } from "../core/exportSchedule.ts";

export async function writeXlsx(schedule: Schedule): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const zeros = schedule.decimals > 0 ? `.${"0".repeat(schedule.decimals)}` : "";
  const formats: Record<CellKind, string | undefined> = {
    text: undefined,
    area: `#,##0${zeros}`,
    length: "0.00",
    count: "0",
    ratio: "0.00",
    percent: "0.0%",
  };

  for (const sheet of schedule.sheets) {
    const ws = workbook.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({ width: c.width }));
    const header = ws.addRow(sheet.columns.map((c) => c.header));
    header.font = { bold: true };
    header.eachCell((cell, col) => {
      cell.border = { bottom: { style: "thin" } };
      if (sheet.columns[col - 1].kind !== "text") cell.alignment = { horizontal: "right" };
    });

    for (const row of sheet.rows) {
      const added = ws.addRow(
        row.cells.map((cell) =>
          cell !== null && typeof cell === "object" && cell.formula
            ? { formula: cell.formula, result: cell.value }
            : cellValue(cell),
        ),
      );
      row.cells.forEach((cell, i) => {
        const target = added.getCell(i + 1);
        const kind = cell !== null && typeof cell === "object" && cell.kind ? cell.kind : sheet.columns[i].kind;
        if (typeof cellValue(cell) === "number") {
          const format = formats[kind];
          if (format) target.numFmt = format;
        } else {
          target.alignment = { wrapText: true, vertical: "top", horizontal: "left" };
        }
        if (row.style === "total") {
          target.font = { bold: true };
          target.border = { top: { style: "thin" } };
        }
      });
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
