/**
 * The path of the folder as breadcrumbs, each of them opening that folder. A click on the empty
 * part of the bar (or its pencil, or Cmd/Ctrl+L) turns the bar into a field for typing or pasting
 * a full path; Enter goes there, Escape gives the breadcrumbs back.
 */
import { ChevronRight, Ellipsis, Pencil } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { Crumb } from "./pathText";

export interface PathBarProps {
  /** The folder shown (its full path is the title of the bar and the start of the typed path). */
  location: string | null;
  /** The folders from the top of the storage folder down to `location`. */
  crumbs: readonly Crumb[];
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** The text of the field was confirmed with Enter. */
  onSubmit: (text: string) => void;
  /** Escape in the field. */
  onCancel: () => void;
  onOpen: (path: string) => void;
  editLabel: string;
  placeholder: string;
  invalid: boolean;
}

/**
 * How much room the last folder keeps, in times its font size, before the folders above it start
 * to collapse into the "..." menu (a shorter name needs only its own width).
 */
const LAST_CRUMB_MIN_EM = 12;

/**
 * How many folders from the top of the path are collapsed into the "..." menu so that the last
 * ones stay readable. Layout decides, so it is measured: every render that overflows collapses
 * one more folder before the browser paints (never the last one), and a new path or a new width
 * starts again from nothing collapsed.
 */
function useCollapsedCount(
  key: string,
  total: number,
  list: React.RefObject<HTMLOListElement | null>,
): number {
  const [state, setState] = useState({ key, count: 0 });
  const count = state.key === key ? state.count : 0;
  // Layout is only known after rendering, so this measures after every render (no list of
  // dependencies, on purpose) and collapses one more folder before the browser paints.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const last = list.current?.querySelector<HTMLElement>("[aria-current=location]");
    if (!last || count >= total - 1) return;
    const room = parseFloat(getComputedStyle(last).fontSize) * LAST_CRUMB_MIN_EM;
    if (last.clientWidth < Math.min(last.scrollWidth, room)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ key, count: count + 1 });
    }
  });
  return count;
}

/** The field itself; it starts with the current path selected, so typing replaces it. */
function PathField({
  initial,
  placeholder,
  invalid,
  onSubmit,
  onCancel,
  onBlur,
}: {
  initial: string;
  placeholder: string;
  invalid: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onBlur: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initial);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit(text);
    } else if (event.key === "Escape") {
      // The dialog leaves Escape to this field (`onEscapeKeyDown` of the dialog).
      onCancel();
    }
  };

  return (
    <Input
      ref={inputRef}
      value={text}
      aria-label="Path"
      placeholder={placeholder}
      invalid={invalid}
      wrapperClassName="min-w-0 flex-1"
      className="font-mono text-sm"
      onChange={(event) => {
        setText(event.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}

export function PathBar({
  location,
  crumbs,
  editing,
  onEditingChange,
  onSubmit,
  onCancel,
  onOpen,
  editLabel,
  placeholder,
  invalid,
}: PathBarProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const collapsed = useCollapsedCount(`${location ?? ""}|${String(width)}`, crumbs.length, listRef);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidth(Math.round(bar.clientWidth));
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
    };
  }, [editing]);

  if (editing) {
    return (
      <PathField
        initial={location ?? ""}
        placeholder={placeholder}
        invalid={invalid}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onBlur={() => {
          onEditingChange(false);
        }}
      />
    );
  }

  return (
    <div
      ref={barRef}
      title={location ?? undefined}
      className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-border bg-surface pr-0.5 pl-1 hover:border-border-strong"
      onClick={(event) => {
        if (event.target === event.currentTarget) onEditingChange(true);
      }}
    >
      <nav aria-label="Path" className="flex min-w-0 flex-1 items-center">
        <ol ref={listRef} className="flex min-w-0 items-center">
          {collapsed > 0 && (
            <li className="flex shrink-0 items-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Higher folders"
                    title="Higher folders"
                    className="focus-ring flex rounded-sm px-1.5 py-0.5 text-fg-muted hover:bg-hover hover:text-fg active:bg-pressed data-[state=open]:bg-pressed [&_svg]:size-4"
                  >
                    <Ellipsis aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-[360px]">
                  {crumbs.slice(0, collapsed).map((crumb) => (
                    <DropdownMenuItem
                      key={crumb.path}
                      title={crumb.path}
                      onSelect={() => {
                        onOpen(crumb.path);
                      }}
                    >
                      {crumb.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          )}
          {crumbs.map((crumb, index) => {
            if (index < collapsed) return null;
            const current = index === crumbs.length - 1;
            return (
              <li
                key={crumb.path}
                className={cn("flex items-center", current ? "min-w-0 shrink" : "shrink-0")}
              >
                {index > 0 && (
                  <ChevronRight className="size-3 shrink-0 text-fg-subtle" aria-hidden />
                )}
                <button
                  type="button"
                  title={crumb.path}
                  aria-current={current ? "location" : undefined}
                  onClick={() => {
                    if (current) onEditingChange(true);
                    else onOpen(crumb.path);
                  }}
                  className={cn(
                    "focus-ring min-w-0 truncate rounded-sm px-1.5 py-0.5 text-base",
                    current
                      ? "font-medium text-fg"
                      : "text-fg-muted hover:bg-hover hover:text-fg active:bg-pressed",
                  )}
                >
                  {crumb.name}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <IconButton
        label={editLabel}
        icon={<Pencil />}
        size="sm"
        onClick={() => {
          onEditingChange(true);
        }}
      />
    </div>
  );
}
