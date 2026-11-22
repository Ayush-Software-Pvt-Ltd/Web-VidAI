/**
 * The pop-up list of the models a service offers (SPEC sections 7a and 9, Settings, Harness + API
 * Keys): a search box, the list (a loading and a failed state of the request, "No model matches"),
 * and a footer with the count and, when asked for, a Refresh action. It is the content of a Radix
 * popover that its user opens and anchors: `ModelCombobox` (OpenCode Go's picker) and
 * `ApiModelField` (Fetch Models of the other two options).
 */
import { Check, CircleAlert, RefreshCw, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Input, ScrollArea, Spinner } from "@/components/ui";
import type { Resource } from "@/lib/store";
import { formatTimeAgo } from "@/lib/format";
import type { ApiModel, ApiModels } from "@/lib/types";
import { matchesModel } from "./model";
import { MAX_LIST_HEIGHT } from "./modelListPlacement";

/** The narrowest the model list is, in CSS px. */
const MIN_LIST_WIDTH = 300;

export interface ModelListPopupProps {
  /** The list and the state of the request that fetches it. */
  models: Resource<ApiModels>;
  /** The chosen model id, `null` when none is chosen (it opens on this model). */
  value: string | null;
  /** The width of what the list opens from, in CSS px (the list is as wide, at least 300). */
  width: number;
  /**
   * The height the list may take below its anchor (`roomBelow`), `null` when the window is too
   * short for that and the list may open above instead.
   */
  maxHeight: number | null;
  onChoose: (model: ApiModel) => void;
  /** Adds "Refresh" (or "Try Again" after a failure) to the footer. */
  onRefresh?: () => void;
  /** Where the focus goes when the list closes. */
  onCloseAutoFocus: (event: Event) => void;
}

export function ModelListPopup({
  models,
  value,
  width,
  maxHeight,
  onChoose,
  onRefresh,
  onCloseAutoFocus,
}: ModelListPopupProps) {
  // The whole list, and from it what the rows may take (the search box and footer are fixed).
  const listMax =
    maxHeight === null
      ? `min(${String(MAX_LIST_HEIGHT)}px, var(--radix-popover-content-available-height))`
      : `${String(maxHeight)}px`;
  return (
    <Popover.Portal>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={3}
        collisionPadding={8}
        // Opens below its anchor at the width of the anchor, and never wider than the window;
        // the user made room for it (`roomBelow`) and gives the height. Only when the window is
        // too short for that (`maxHeight` null) may it flip above.
        // The width is measured by the user, not taken from Radix's `--radix-popover-trigger-width`:
        // that variable is only set after the first placement, which then resized the list
        // inside the callback of the observer that watches it ("ResizeObserver loop
        // completed with undelivered notifications").
        avoidCollisions={maxHeight === null}
        style={
          {
            width: Math.max(width, MIN_LIST_WIDTH),
            maxHeight: listMax,
            "--model-list-max": listMax,
          } as CSSProperties
        }
        aria-label="Models"
        onCloseAutoFocus={onCloseAutoFocus}
        className="z-50 flex max-w-[calc(100vw/var(--page-zoom,1)_-_16px)] animate-pop-in flex-col overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover outline-none"
      >
        <ModelListBody models={models} value={value} onChoose={onChoose} onRefresh={onRefresh} />
      </Popover.Content>
    </Popover.Portal>
  );
}

/** Mounted each time the list opens, so the search and the active row start fresh. */
function ModelListBody({
  models,
  value,
  onChoose,
  onRefresh,
}: Pick<ModelListPopupProps, "models" | "value" | "onChoose" | "onRefresh">) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => models.data?.models ?? [], [models.data]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      list.findIndex((m) => m.id === value),
    ),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const fetched = models.data?.fetchedAt != null;
  const loading = models.status === "loading" || models.status === "idle";
  const failed = models.status === "error";
  const filtered = useMemo(() => list.filter((m) => matchesModel(m, query)), [list, query]);

  // Keeps the active model in view, also right after the list appears (it opens on the chosen
  // model, which may be far down a long list); the popover mounts its content a frame later.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-index="${String(active)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, list.length]);

  return (
    <>
      <div className="border-b border-separator p-2">
        <Input
          autoFocus
          size="sm"
          icon={<Search />}
          value={query}
          placeholder={list.length > 0 ? `Search ${String(list.length)} models` : "Search models"}
          aria-label="Search the models"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={filtered[active] ? `${listId}-${String(active)}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(filtered.length - 1, i + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const model = filtered[active];
              if (model) onChoose(model);
            }
          }}
        />
      </div>
      {list.length === 0 && loading ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-fg-muted"
        >
          <Spinner size={13} />
          Loading the models
        </div>
      ) : list.length === 0 && failed ? (
        <div role="alert" className="flex flex-col items-start gap-2 px-3 py-3 text-sm">
          <span className="flex gap-1.5 text-danger">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            <span>{models.error?.message ?? "The models could not be loaded."}</span>
          </span>
        </div>
      ) : filtered.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm break-words text-fg-muted">
          No model matches {"“"}
          {query.trim()}
          {"”"}.
        </p>
      ) : (
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="max-h-[calc(var(--model-list-max)-88px)]"
        >
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Model list"
            className="flex flex-col p-1"
          >
            {filtered.map((model, index) => {
              const selected = model.id === value;
              return (
                <div
                  key={model.id}
                  id={`${listId}-${String(index)}`}
                  role="option"
                  aria-label={`${model.displayName} (${model.id})`}
                  aria-selected={selected}
                  data-index={index}
                  data-active={index === active || undefined}
                  onPointerMove={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    onChoose(model);
                  }}
                  className="group relative flex h-7 cursor-default items-center gap-3 rounded-md pr-2 pl-7 text-base text-fg select-none data-[active]:bg-accent data-[active]:text-accent-fg"
                >
                  {selected && <Check className="absolute left-2 size-3.5" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                  <span className="max-w-[50%] min-w-0 shrink truncate font-mono text-sm text-fg-muted group-data-[active]:text-accent-fg/75">
                    {model.id}
                  </span>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-separator px-3 py-2">
        <span className="min-w-0 truncate text-sm text-fg-muted">
          {failed && list.length > 0
            ? "Refresh failed"
            : fetched && models.data?.fetchedAt
              ? `${String(list.length)} models, updated ${formatTimeAgo(models.data.fetchedAt)}`
              : loading
                ? "Asking the service"
                : "Not loaded yet"}
        </span>
        {onRefresh && (
          <Button
            size="sm"
            icon={<RefreshCw />}
            loading={loading && models.status === "loading"}
            onClick={onRefresh}
          >
            {failed ? "Try Again" : "Refresh"}
          </Button>
        )}
      </div>
    </>
  );
}
