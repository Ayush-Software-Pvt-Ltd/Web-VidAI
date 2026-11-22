import { usePlatform } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import type { KeyToken } from "@/lib/platform";

export interface KbdProps {
  /**
   * Keys in order, for example `["mod", ","]`. The tokens `mod` (⌘ in a browser on macOS, Ctrl
   * elsewhere), `enter` (↩ / Enter) and `esc` (esc / Esc) are shown the way the browser's own
   * operating system writes them (`usePlatform()`, read from the user agent).
   */
  keys: readonly (KeyToken | (string & {}))[];
  className?: string;
}

/** A keyboard shortcut hint; nothing for a shortcut the browser keeps for itself (its own zoom keys). */
export function Kbd({ keys, className }: KbdProps) {
  const { keyLabel, offersShortcut } = usePlatform();
  if (!offersShortcut(keys)) return null;
  return (
    <kbd className={cn("inline-flex items-center gap-0.5 font-sans", className)}>
      {keys.map((key) => (
        <span
          key={key}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-border bg-subtle px-1 text-xs leading-none text-fg-muted"
        >
          {keyLabel(key)}
        </span>
      ))}
    </kbd>
  );
}
