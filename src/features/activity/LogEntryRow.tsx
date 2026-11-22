import {
  ChevronRight,
  CircleAlert,
  CornerDownRight,
  Dot,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { LogEntry } from "@/lib/types";
import { formatLogTimeFull, splitToolLine } from "./logFormat";
import { Markdown } from "./Markdown";

export interface LogEntryRowProps {
  entry: LogEntry;
  /** The short time shown in the gutter, or `null` when it equals the previous row's. */
  time: string | null;
  expanded: boolean;
  onToggle: (seq: number) => void;
}

const ICONS: Record<LogEntry["kind"], ReactNode> = {
  status: <Dot className="text-fg-subtle" strokeWidth={6} />,
  assistant: <Sparkles className="text-accent-text" />,
  tool: <Wrench className="text-fg-subtle" />,
  toolResult: <CornerDownRight className="text-fg-subtle" />,
  user: <UserRound className="text-accent-text" />,
  error: <CircleAlert className="text-danger" />,
};

function Body({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case "status":
      return <p className="text-sm text-fg-muted">{entry.text}</p>;
    case "assistant":
      return <Markdown text={entry.text} className="text-sm text-fg" />;
    case "tool": {
      const { tool, rest } = splitToolLine(entry.text);
      return (
        <p className="text-sm text-fg">
          {tool && (
            <span className="mr-1.5 inline-block rounded-sm bg-muted px-1 font-mono text-2xs leading-4 font-medium text-fg-muted">
              {tool}
            </span>
          )}
          {rest}
        </p>
      );
    }
    case "toolResult":
      return <p className="font-mono text-xs whitespace-pre-wrap text-fg-muted">{entry.text}</p>;
    case "user":
      return (
        <p className="rounded-md bg-accent-soft px-2 py-1 text-sm whitespace-pre-wrap text-fg">
          {entry.text}
        </p>
      );
    case "error":
      return <p className="text-sm font-medium whitespace-pre-wrap text-danger">{entry.text}</p>;
  }
}

/** One entry of the job log: time gutter, kind icon, text and the expandable detail. */
export function LogEntryRow({ entry, time, expanded, onToggle }: LogEntryRowProps) {
  const hasDetail = entry.detail !== null && entry.detail !== "";
  return (
    <div
      data-kind={entry.kind}
      data-nested={entry.nested}
      className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-1.5 pr-3 pl-3"
    >
      <time
        dateTime={entry.ts}
        title={formatLogTimeFull(entry.ts)}
        className="pt-[5px] text-2xs whitespace-nowrap text-fg-subtle tabular"
      >
        {time}
      </time>
      <div
        className={cn(
          "min-w-0 py-[3px]",
          entry.nested && "ml-[7px] border-l border-border-strong pl-2.5",
        )}
      >
        <div
          className="flex min-w-0 items-start gap-2"
          onClick={
            hasDetail
              ? () => {
                  // Clicking the line toggles the detail (the chevron button bubbles up here),
                  // unless the user is selecting text.
                  if (window.getSelection()?.isCollapsed !== false) onToggle(entry.seq);
                }
              : undefined
          }
        >
          <span className="mt-px flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">
            {ICONS[entry.kind]}
          </span>
          <div className="min-w-0 flex-1 break-words">
            <Body entry={entry} />
          </div>
          {hasDetail && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? "Hide details" : "Show details"}
              className="focus-ring -mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg [&_svg]:size-3.5"
            >
              <ChevronRight
                className={cn("transition-transform duration-100", expanded && "rotate-90")}
              />
            </button>
          )}
        </div>
        {hasDetail && expanded && (
          <div className="group relative mt-1 mb-0.5 ml-6">
            <pre className="max-h-[320px] overflow-auto rounded-md border border-separator bg-subtle py-1.5 pr-8 pl-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-fg select-text">
              {entry.detail}
            </pre>
            <CopyButton
              text={entry.detail ?? ""}
              label="Copy details"
              noTooltip
              className="absolute top-1 right-1 bg-subtle"
            />
          </div>
        )}
      </div>
    </div>
  );
}
