/**
 * Menus, selects and dialogs give focus back to their trigger when they close. That focus is not
 * the user moving to the trigger, so:
 *
 * - a tooltip on the trigger must not open for it (it would stay open after choosing a menu
 *   item): the closing layer calls `noteFocusReturn` from its `onCloseAutoFocus`, Radix moves
 *   focus right after in the same task, and `Tooltip` ignores focus while `isFocusReturn()`;
 * - after a mouse choice the trigger must not show a keyboard focus ring. Menus and selects open
 *   on pointerdown without focusing their trigger, so browsers treat the later programmatic focus
 *   as keyboard focus; `returnFocus` focuses the trigger itself and asks for a ring only when the
 *   user last used the keyboard.
 *
 * Keyboard focus at any other time still shows the tooltip and the ring.
 */
let returning = false;
let lastInput: "pointer" | "keyboard" = "pointer";

if (typeof window !== "undefined") {
  const options = { capture: true, passive: true };
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), options);
  window.addEventListener("keydown", () => (lastInput = "keyboard"), options);
}

export function noteFocusReturn(): void {
  returning = true;
  // Radix focuses the trigger synchronously after the close handler; anything later is the user.
  queueMicrotask(() => {
    returning = false;
  });
}

export function isFocusReturn(): boolean {
  return returning;
}

/** Gives focus back to `trigger`, with a focus ring only after keyboard use. */
export function returnFocus(trigger: HTMLElement): void {
  noteFocusReturn();
  trigger.focus({ preventScroll: true, focusVisible: lastInput === "keyboard" });
}

/** An `onCloseAutoFocus` handler that marks the focus return, then calls `handler`. */
export function quietFocusReturn<E extends Event>(
  handler?: (event: E) => void,
): (event: E) => void {
  return (event) => {
    noteFocusReturn();
    handler?.(event);
  };
}
