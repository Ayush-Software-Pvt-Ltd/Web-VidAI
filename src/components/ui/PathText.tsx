import type { MouseEvent } from "react";
import { cn } from "@/lib/cn";
import { pathSegments } from "@/lib/paths";

export interface PathTextProps {
  /** An absolute path, or a single file or folder name. */
  path: string;
  className?: string;
}

/**
 * A path or file name as people read it, whether the server runs on macOS, Windows or Linux and
 * so writes `/` or `\` (the paths are the server's, shown as it wrote them): monospace, selectable,
 * and wrapped only after a separator, so no line starts with a separator and no name is cut in
 * two. Each name with its separator is an inline block, which a line breaks between but not
 * inside; only a single name that is longer than the whole line wraps within itself (at a space
 * first, anywhere if it has to). A triple click selects the whole path, as it would in one run of
 * text.
 */
export function PathText({ path, className }: PathTextProps) {
  const selectAll = (event: MouseEvent<HTMLSpanElement>) => {
    if (event.detail !== 3) return;
    event.preventDefault();
    window.getSelection()?.selectAllChildren(event.currentTarget);
  };
  return (
    <span
      dir="ltr"
      data-path
      className={cn("font-mono text-sm text-fg-muted select-text", className)}
      onMouseDown={selectAll}
    >
      {pathSegments(path).map((part, i) => (
        <span key={i} className="inline-block max-w-full [overflow-wrap:anywhere]">
          {part}
        </span>
      ))}
    </span>
  );
}
