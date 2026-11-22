/** Moves the item at `from` to `to` (both clamped), returning a new array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

/**
 * The visual offset of row `index` while row `from` is dragged to `to`: rows between them make
 * room by one row height in the opposite direction.
 */
export function shiftFor(index: number, from: number, to: number, rowHeight: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -rowHeight;
  if (from > to && index < from && index >= to) return rowHeight;
  return 0;
}
