import { Tooltip } from "@/components/ui";
import { cn } from "@/lib/cn";

/** The last folder name is kept whole up to this many characters; a longer one is cut in front. */
const TAIL_CHARS = 32;

/** The path cut before its last folder name (with the separator); a very long name is cut too. */
function splitPath(path: string): [head: string, tail: string] {
  const end = path.replace(/[\\/]+$/, "").length;
  const trimmed = path.slice(0, end);
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  let at = Math.max(separator, 0);
  if (end - at > TAIL_CHARS) at = end - TAIL_CHARS;
  return [path.slice(0, at), path.slice(at)];
}

/**
 * A path on one line, cut in the middle when it does not fit: the start and the last folder name
 * stay, the full path is in a tooltip and, for assistive technology, in the text itself. The
 * path is the server's, shown as it wrote it.
 */
export function MiddleText({ path, className }: { path: string; className?: string }) {
  const [head, tail] = splitPath(path);
  return (
    <Tooltip content={path} side="bottom" align="start">
      <span
        dir="ltr"
        data-path
        className={cn("flex min-w-0 font-mono text-xs text-fg-muted select-text", className)}
      >
        <span className="sr-only">{path}</span>
        <span aria-hidden className="min-w-0 truncate">
          {head}
        </span>
        <span aria-hidden className="shrink-0 whitespace-pre">
          {tail}
        </span>
      </span>
    </Tooltip>
  );
}
