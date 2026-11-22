/**
 * Left side of the main top bar (SPEC section 16): the search field (Cmd+F, Ctrl+F on Windows),
 * the filter (All, To edit, In progress, Edited), the sort, the user's own job summary such as
 * "2 running, 1 waiting".
 */
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { useRef } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Kbd,
  SegmentedControl,
} from "@/components/ui";
import { useAppState, usePlatform } from "@/lib/appEnv";
import { ownJobCounts } from "@/lib/store";
import { focusList } from "./focus";
import {
  FILTER_OPTIONS,
  jobSummary,
  nextSort,
  SORT_OPTIONS,
  sortWords,
  type LibraryFilter,
  type VideoSort,
} from "./model";
import { SEARCH_INPUT_ID, useLibraryView } from "./viewStore";

const DirIcon = ({ sort }: { sort: VideoSort }) =>
  sort.dir === "asc" ? <ArrowUp /> : <ArrowDown />;

/** Three items: the active one flips its direction when clicked again (arrow up is ascending). */
function SortMenu({ sort, onChange }: { sort: VideoSort; onChange: (sort: VideoSort) => void }) {
  const label = SORT_OPTIONS.find((o) => o.key === sort.key)?.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          aria-label={`Sort videos: ${label ?? ""}, ${sortWords(sort)}`}
          icon={<DirIcon sort={sort} />}
        >
          {/* In a narrow bar only the arrow stays, so the model controls keep their room. */}
          <span className="topbar-max-820:sr-only">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[104px]">
        {SORT_OPTIONS.map((option) => {
          const active = option.key === sort.key;
          return (
            <DropdownMenuItem
              key={option.key}
              icon={active ? <DirIcon sort={sort} /> : <span className="size-4" />}
              aria-label={active ? `${option.label}, ${sortWords(sort)}` : undefined}
              onSelect={() => {
                onChange(nextSort(sort, option.key));
              }}
            >
              {option.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LibraryToolbar() {
  const query = useLibraryView((s) => s.query);
  const filter = useLibraryView((s) => s.filter);
  const sort = useLibraryView((s) => s.sort);
  const setQuery = useLibraryView((s) => s.setQuery);
  const setFilter = useLibraryView((s) => s.setFilter);
  const setSort = useLibraryView((s) => s.setSort);
  // The selector returns the stored queue (stable); the counts are derived from it here.
  const queue = useAppState((s) => s.queue.data);
  const summary = jobSummary(ownJobCounts(queue));
  const inputRef = useRef<HTMLInputElement>(null);
  const platform = usePlatform();

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 topbar-max-760:gap-2">
      <Input
        ref={inputRef}
        id={SEARCH_INPUT_ID}
        icon={<Search />}
        placeholder="Search"
        aria-label="Search videos"
        aria-keyshortcuts={platform.ariaShortcut("F")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query !== "") {
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
          } else if (e.key === "Escape") {
            inputRef.current?.blur();
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            if (focusList()) e.preventDefault();
          }
        }}
        wrapperClassName="max-w-[240px] min-w-[96px] flex-1 topbar-max-680:min-w-[80px]"
        // The ⌘F hint hides in a narrow bar; so does the room kept for it.
        className={query === "" ? "topbar-max-820:pr-2" : undefined}
        trailing={
          query === "" ? (
            <Kbd keys={["mod", "F"]} className="pointer-events-none topbar-max-820:hidden" />
          ) : (
            <IconButton
              label="Clear search"
              noTooltip
              size="sm"
              icon={<X />}
              className="size-5 rounded-full"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            />
          )
        }
      />
      <SegmentedControl<LibraryFilter>
        aria-label="Filter videos"
        size="sm"
        value={filter}
        onValueChange={setFilter}
        options={FILTER_OPTIONS}
      />
      <SortMenu sort={sort} onChange={setSort} />
      {summary && (
        <span
          role="status"
          className="min-w-0 truncate text-sm whitespace-nowrap text-fg-muted tabular topbar-max-800:hidden"
        >
          {summary}
        </span>
      )}
    </div>
  );
}
