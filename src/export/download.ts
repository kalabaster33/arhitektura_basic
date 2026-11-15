/** Browser side of export: handing a finished file to the user. */

/**
 * A project name as a file name: letters and digits of any alphabet are kept
 * (so a Cyrillic name survives), everything else becomes an underscore.
 */
export function fileBase(name: string): string {
  return name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "") || "project";
}

export function download(fileName: string, content: string | Uint8Array, type: string): void {
  const blob = new Blob([content as BlobPart], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}
