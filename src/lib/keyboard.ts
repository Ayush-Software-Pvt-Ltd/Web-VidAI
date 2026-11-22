/** Helpers for app-wide keyboard handling (Esc, shortcuts) that must not steal keys from layers. */

/**
 * Something modal or transient is open (dialog, sheet, popover, menu, select list, a drag in
 * progress): Esc belongs to it. Elements can opt in with `data-captures-escape`. Tooltips do not
 * count; they close on Esc along with whatever else Esc does.
 */
export function hasOpenLayer(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-captures-escape]',
    ) !== null
  );
}

/** The key went to a text field, which handles Esc itself (clear, blur). */
export function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/** A plain key press, without Cmd, Ctrl, Alt or Shift. */
export function isPlainKey(event: KeyboardEvent, key: string): boolean {
  return event.key === key && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}
