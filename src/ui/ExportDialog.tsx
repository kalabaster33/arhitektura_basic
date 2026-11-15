import { useEffect, useMemo, useState } from "react";
import type { AreaConfig } from "../core/areas.ts";
import { sortedStoreys } from "../core/building.ts";
import { writeDxf } from "../core/exportDxf.ts";
import { buildSchedule } from "../core/exportSchedule.ts";
import type { Project } from "../core/model.ts";
import { type ExportConfig, buildSheets, sheetsThatDoNotFit } from "../core/sheets.ts";
import type { SiteAnalysis } from "../core/site.ts";
import { download, fileBase } from "../export/download.ts";

type Format = "pdf" | "dxf" | "xlsx";

const FORMATS: { format: Format; label: string; what: string }[] = [
  { format: "pdf", label: "PDF", what: "Plan sheets to print, drawn to scale with a title block." },
  { format: "dxf", label: "DXF", what: "The same drawings for AutoCAD or Revit, at 1:1 in metres on named layers." },
  { format: "xlsx", label: "XLSX", what: "The area schedule as a spreadsheet: rooms, apartments, storeys and site." },
];

const today = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
};

export function ExportDialog(props: {
  project: Project;
  areaConfig: AreaConfig;
  analysis: SiteAnalysis;
  config: ExportConfig;
  /** Which storeys make up the footprint, in words. */
  footprintRule: string;
  /** The "to be verified" notes of the configs the figures depend on. */
  notes: string[];
  onClose: () => void;
}) {
  const { project, areaConfig, analysis, config } = props;
  const storeys = useMemo(
    () =>
      project.site.buildings.flatMap((b) =>
        sortedStoreys(b).map((s) => ({
          id: s.id,
          name: project.site.buildings.length > 1 ? `${b.name} · ${s.name}` : s.name,
        })),
      ),
    [project.site.buildings],
  );
  const [format, setFormat] = useState<Format>("pdf");
  const [paper, setPaper] = useState(config.defaultPaper);
  const [scale, setScale] = useState(config.defaultScale);
  const [siteScale, setSiteScale] = useState(config.defaultSiteScale);
  const [storeyIds, setStoreyIds] = useState(() => storeys.map((s) => s.id));
  const [includeSite, setIncludeSite] = useState(analysis.hasPlot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const drawing = format !== "xlsx";
  const sheets = useMemo(
    () => buildSheets(project, { storeyIds, includeSite, scale, siteScale }, areaConfig, analysis, config),
    [project, storeyIds, includeSite, scale, siteScale, areaConfig, analysis, config],
  );
  const tooLarge = format === "pdf" ? sheetsThatDoNotFit(sheets, config.paper[paper], config) : [];
  const ready = !busy && (!drawing || (sheets.length > 0 && tooLarge.length === 0));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = fileBase(project.name);
      if (format === "dxf") {
        download(`${base}.dxf`, writeDxf(sheets, config), "application/dxf");
      } else if (format === "pdf") {
        const [{ writePdf }, { loadPdfFonts }] = await Promise.all([
          import("../export/pdf.ts"),
          import("../export/fonts.ts"),
        ]);
        const bytes = await writePdf(
          sheets,
          config,
          { project: project.name, date: today(), paper: config.paper[paper] },
          await loadPdfFonts(),
        );
        download(`${base}.pdf`, bytes, "application/pdf");
      } else {
        const { writeXlsx } = await import("../export/xlsx.ts");
        const schedule = buildSchedule(project, areaConfig, analysis, {
          date: today(),
          notes: props.notes,
          footprintRule: props.footprintRule,
        });
        download(
          `${base}_areas.xlsx`,
          await writeXlsx(schedule),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
      }
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const scaleSelect = (label: string, value: number, options: number[], set: (v: number) => void) => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => set(Number(e.target.value))}>
        {options.map((s) => (
          <option key={s} value={s}>
            1:{s}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Export">
        <h2>Export</h2>
        <div className="group dialog__formats" role="group" aria-label="Format">
          {FORMATS.map((f) => (
            <button key={f.format} className={format === f.format ? "is-active" : ""} onClick={() => setFormat(f.format)}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="hint dialog__what">{FORMATS.find((f) => f.format === format)!.what}</p>

        {drawing && (
          <>
            <div className="field-grid">
              {format === "pdf" && (
                <label className="field">
                  <span>Paper</span>
                  <select value={paper} onChange={(e) => setPaper(e.target.value)}>
                    {Object.keys(config.paper).map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
              )}
              {scaleSelect(format === "pdf" ? "Scale of plans" : "Lettering sized for", scale, config.scales, setScale)}
              {analysis.hasPlot &&
                includeSite &&
                scaleSelect(
                  format === "pdf" ? "Scale of site plan" : "Site lettering sized for",
                  siteScale,
                  config.siteScales,
                  setSiteScale,
                )}
            </div>
            <fieldset className="dialog__sheets">
              <legend>Drawings</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={includeSite && analysis.hasPlot}
                  disabled={!analysis.hasPlot}
                  onChange={(e) => setIncludeSite(e.target.checked)}
                />
                Site plan{!analysis.hasPlot && " (no plot is drawn)"}
              </label>
              {storeys.map((s) => (
                <label key={s.id} className="check">
                  <input
                    type="checkbox"
                    checked={storeyIds.includes(s.id)}
                    onChange={(e) =>
                      setStoreyIds(e.target.checked ? [...storeyIds, s.id] : storeyIds.filter((id) => id !== s.id))
                    }
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
            {sheets.length === 0 && <p className="hint hint--warn">Choose at least one drawing.</p>}
            {tooLarge.length > 0 && (
              <p className="hint hint--warn">
                Too large for {paper} at this scale: {tooLarge.map((s) => `${s.title} (1:${s.scale})`).join(", ")}.
                Choose larger paper or a smaller scale.
              </p>
            )}
            {format === "dxf" && (
              <p className="hint">
                The file is in metres; choose metres as the unit when you open or link it.{" "}
                {sheets.length > 1
                  ? "The drawings are laid side by side. Export one drawing alone to keep it at its true coordinates."
                  : "A single drawing keeps its true coordinates."}
              </p>
            )}
          </>
        )}
        {format === "xlsx" && (
          <p className="hint">All storeys are included. Totals are formulas, so they follow if you edit a value.</p>
        )}
        {error && (
          <p className="hint hint--warn" role="alert">
            Export failed: {error}
          </p>
        )}
        <div className="dialog__actions">
          <button onClick={props.onClose} disabled={busy}>
            Cancel
          </button>
          <button className="is-active" disabled={!ready} onClick={() => void run()}>
            {busy ? "Exporting…" : `Export ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
