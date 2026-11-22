/**
 * Copying text to the clipboard, the one way the UI does it.
 *
 * The async Clipboard API is tried first. It is missing in a page that is not a secure context
 * (VidAI is often opened over plain http on the office network) and can be refused by the
 * browser's permission policy, so the fallback copies the selection of an off-screen text area
 * with `document.execCommand("copy")`, which browsers still allow during the click that asked
 * for it. Call it straight from the click handler.
 */

/** Copies `text`; rejects when neither way works. */
export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Refused: try the selection fallback below while the click still counts as a gesture.
    }
  }
  if (!copyWithSelection(text)) throw new Error("The clipboard is not available.");
}

/**
 * The legacy copy command. The DOM typings mark `execCommand` as deprecated; it is used on purpose
 * because WebKit offers no other synchronous way to copy, and it is typed here to say so.
 */
interface LegacyCopyDocument {
  execCommand?: (command: "copy") => boolean;
}

function copyWithSelection(text: string): boolean {
  if (typeof document === "undefined") return false;
  const legacy: LegacyCopyDocument = document;
  if (typeof legacy.execCommand !== "function") return false;
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i))
    : [];

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  // In the viewport (WebKit does not copy from far off-screen) but invisible and inert.
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(area);
  let copied: boolean;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    copied = legacy.execCommand.call(document, "copy");
  } catch {
    copied = false;
  } finally {
    area.remove();
    previousFocus?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  return copied;
}
