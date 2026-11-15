/**
 * The font embedded in exported PDFs: Noto Sans (SIL Open Font License), which
 * has Latin, Cyrillic and Greek. The two files are fetched only when a PDF is
 * exported, so they do not slow down opening the editor.
 */
import boldUrl from "@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url";
import regularUrl from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import type { PdfFonts } from "./pdf.ts";

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the PDF font (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

let cached: Promise<PdfFonts> | null = null;

export function loadPdfFonts(): Promise<PdfFonts> {
  cached ??= Promise.all([fetchBytes(regularUrl), fetchBytes(boldUrl)]).then(([regular, bold]) => ({
    regular,
    bold,
  }));
  // A failed download must not stick: the next export tries again.
  cached.catch(() => (cached = null));
  return cached;
}
