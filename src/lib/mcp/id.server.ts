/** Small id helper kept separate so domain logic stays testable. */
export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
