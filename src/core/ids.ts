/** Short unique id, e.g. "wall-3f9a1c2e". */
export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
