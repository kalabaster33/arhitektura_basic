/** Typed dimensions: "3.20 m", "3,2", "320 cm", "3200mm" -> metres. */

const FACTORS: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001 };

/** Metres, or null when the text is not a length. A bare number is metres. */
export function parseLength(text: string): number | null {
  const m = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(mm|cm|m)?\s*$/i.exec(text);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const metres = value * FACTORS[(m[2] ?? "m").toLowerCase()];
  return Math.round(metres * 1e6) / 1e6;
}

export function formatLength(metres: number, decimals = 2): string {
  return `${metres.toFixed(decimals)} m`;
}
