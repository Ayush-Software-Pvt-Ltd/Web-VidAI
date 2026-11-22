/**
 * The admin's in-page folder picker: a dialog in which the admin chooses one folder anywhere on the
 * server (SPEC section 6, "Folders on the server"). It shows the places (home, drives and, on a
 * Mac, volumes), the path, the folders of one folder and a New Folder button, all through the
 * server's `fsPlaces`, `fsList` and `fsCreateFolder`. A folder that cannot become a channel
 * (`taken`: it belongs to a channel or to VidAI's own data) is greyed and cannot be chosen, but it
 * can be opened, as it may hold folders that are free. A place that cannot be reached right now
 * (an unplugged drive) is greyed too.
 *
 * It is controlled and has no state of its own between openings: the dialog content mounts when
 * `open` becomes true and starts again at `startPath` (or the home folder).
 */
import {
  ArrowUp,
  CircleAlert,
  FolderPlus,
  HardDrive,
  House,
  RotateCw,
  Unplug,
  X,
} from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState, type ClipboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { returnFocus } from "@/components/ui/focusReturn";
import { useApi } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { toApiError } from "@/lib/errors";
import type { FsEntry, FsPlace } from "@/lib/types";
import { FolderList, TAKEN_HINT } from "./FolderList";
import { NewFolderBar } from "./NewFolderBar";
import { PathBar } from "./PathBar";
import { crumbsBelow, isAbsolutePath, leafName, normalizeTypedPath } from "./pathText";
import { rootCrumb, useBrowser } from "./useBrowser";

export interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chosen folder, as the server wrote its path. The dialog closes right after. */
  onPick: (path: string) => void;
  /** Default "Choose a folder". */
  title?: string;
  /** The text of the button that chooses. Default: `Choose "<name of the folder>"`. */
  confirmLabel?: string;
  /** The folder to open first. Default (or when it cannot be shown): the home folder. */
  startPath?: string | null;
}

export function FolderPickerDialog({ open, onOpenChange, ...rest }: FolderPickerDialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-overlay" />
        <PickerContent
          {...rest}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function placeIcon(place: FsPlace) {
  if (!place.available) return Unplug;
  return place.kind === "home" ? House : HardDrive;
}

function videoFilesText(count: number): string {
  return `${String(count)} video ${count === 1 ? "file" : "files"} in this folder`;
}

function PickerContent({
  onPick,
  onClose,
  title = "Choose a folder",
  confirmLabel,
  startPath = null,
}: Omit<FolderPickerDialogProps, "open" | "onOpenChange"> & {
  onClose: () => void;
}) {
  const api = useApi();
  // The element that had focus when the dialog opened gets it back when it closes.
  const [opener] = useState(() => document.activeElement);
  const ids = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const browser = useBrowser(api);
  const { location, listing, error, loading, selected, go } = browser;

  const [editingPath, setEditingPath] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [start] = useState(startPath);

  useEffect(() => {
    void go(start, { fallbackHome: true });
  }, [go, start]);

  const shown = listing !== null && listing.path === location ? listing : null;
  // While another folder loads, the one shown stays (dimmed by the list).
  const entries = listing?.entries ?? [];
  const selectedEntry = entries.find((entry) => entry.path === selected);
  const place = location === null ? null : browser.placeOf(location);
  const crumbs =
    location === null ? [] : crumbsBelow(location, rootCrumb(browser.driveOf(location)));
  const example = browser.places.find((p) => p.kind === "home")?.path ?? "/srv/footage";

  const focusList = () => {
    listRef.current?.focus();
  };

  // ---- choosing ----------------------------------------------------------------------------

  // What would be chosen: the selected folder, else the one shown.
  const chosenIsTaken = selectedEntry
    ? selectedEntry.taken
    : shown !== null && browser.isTaken(shown.path);
  const primaryDisabled = error !== null || shown === null || chosenIsTaken;
  const primaryLabel =
    confirmLabel ??
    `Choose "${selectedEntry ? selectedEntry.name : location === null ? "" : leafName(shown?.path ?? location)}"`;

  const choose = () => {
    if (primaryDisabled) return;
    onPick(selectedEntry?.path ?? shown.path);
    onClose();
  };

  const openFolder = (entry: FsEntry) => {
    void go(entry.path);
  };

  // ---- path field and New Folder -------------------------------------------------------------

  const submitPath = (text: string) => {
    const path = normalizeTypedPath(text);
    if (!isAbsolutePath(path)) {
      setPathError(`Type a full path, for example ${example}.`);
      return;
    }
    setPathError(null);
    setEditingPath(false);
    void go(path);
    focusList();
  };

  const createFolder = async (name: string) => {
    const parent = shown?.path;
    if (parent === undefined) return;
    if (name === "") {
      setFolderError("A name cannot be empty.");
      return;
    }
    setFolderBusy(true);
    setFolderError(null);
    try {
      const made = await api.fsCreateFolder({ parent, name });
      setCreating(false);
      await go(made.path);
      focusList();
    } catch (failure) {
      setFolderError(toApiError(failure).message);
    } finally {
      setFolderBusy(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const path = normalizeTypedPath(event.clipboardData.getData("text"));
    if (path.includes("\n") || !isAbsolutePath(path)) return;
    event.preventDefault();
    submitPath(path);
  };

  // ---- the parts -----------------------------------------------------------------------------

  const remark = pathError !== null ? { text: pathError, tone: "error" as const } : browser.notice;
  const empty = shown !== null && entries.length === 0;

  const placeButton = (item: FsPlace) => {
    const Icon = placeIcon(item);
    const active = item.available && place?.path === item.path;
    return (
      <li key={item.path}>
        <button
          type="button"
          title={item.available ? item.path : `${item.name} cannot be reached right now.`}
          aria-current={active ? "true" : undefined}
          aria-disabled={!item.available || undefined}
          onClick={() => {
            if (item.available) void go(item.path);
            else {
              browser.say({
                text: `"${item.name}" cannot be reached right now. Check that the drive is connected.`,
                tone: "error",
              });
            }
          }}
          className={cn(
            "focus-ring flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-base",
            active
              ? "bg-selected text-fg"
              : item.available
                ? "text-fg hover:bg-hover active:bg-pressed"
                : "text-fg-subtle hover:bg-hover",
          )}
        >
          <Icon
            className={cn(
              "size-4 shrink-0",
              item.available ? "text-accent-text" : "text-fg-subtle",
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          {!item.available && <span className="shrink-0 text-xs">Not reachable</span>}
        </button>
      </li>
    );
  };

  return (
    <RadixDialog.Content
      aria-describedby={undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        listRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        // Instead of Radix, which looks for a trigger this dialog does not have.
        event.preventDefault();
        if (opener instanceof HTMLElement && opener.isConnected) returnFocus(opener);
      }}
      onEscapeKeyDown={(event) => {
        // Escape first closes the smaller thing that is open.
        if (editingPath || creating) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (creating) {
            setCreating(false);
            setFolderError(null);
            focusList();
          }
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
          event.preventDefault();
          setEditingPath(true);
        }
      }}
      onPaste={onPaste}
      className="fixed top-1/2 left-1/2 z-50 flex h-[580px] max-h-[calc(100vh/var(--page-zoom,1)_-_64px)] w-[820px] max-w-[calc(100vw/var(--page-zoom,1)_-_48px)] -translate-x-1/2 -translate-y-1/2 animate-pop-in flex-col overflow-hidden rounded-xl bg-elevated shadow-dialog outline-none"
    >
      <div className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
        <RadixDialog.Title className="min-w-0 flex-1 truncate text-md font-semibold text-fg">
          {title}
        </RadixDialog.Title>
        <IconButton
          label="Close"
          icon={<X />}
          size="sm"
          noTooltip
          onClick={onClose}
          className="-mr-2"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 px-5 pb-3">
        <IconButton
          label="Up one level"
          icon={<ArrowUp />}
          variant="secondary"
          disabled={browser.upTarget === null}
          onClick={() => {
            if (browser.upTarget !== null) void go(browser.upTarget);
          }}
        />
        <PathBar
          location={location}
          crumbs={crumbs}
          editing={editingPath}
          onEditingChange={(next) => {
            setEditingPath(next);
            if (!next) setPathError(null);
          }}
          onSubmit={submitPath}
          onCancel={() => {
            setEditingPath(false);
            setPathError(null);
            focusList();
          }}
          onOpen={(path) => {
            void go(path);
          }}
          editLabel="Type a path"
          placeholder={example}
          invalid={pathError !== null}
        />
      </div>

      <div className="flex min-h-0 flex-1 border-t border-separator">
        <nav
          aria-label="Places"
          className="w-[200px] shrink-0 overflow-y-auto border-r border-separator bg-subtle/60 p-2"
        >
          <ul className="space-y-0.5">{browser.places.map(placeButton)}</ul>
        </nav>
        <div className="relative flex min-w-0 flex-1 flex-col bg-surface">
          {remark && (
            <p
              role="status"
              className={cn(
                "shrink-0 border-b border-separator px-4 py-1.5 text-sm",
                remark.tone === "error" ? "text-danger" : "text-fg-muted",
              )}
            >
              {remark.text}
            </p>
          )}
          {creating && (
            <NewFolderBar
              initialName="New folder"
              error={folderError}
              busy={folderBusy}
              createLabel="Create"
              onCreate={(name) => void createFolder(name)}
              onCancel={() => {
                setCreating(false);
                setFolderError(null);
                focusList();
              }}
            />
          )}
          <div className="relative min-h-0 flex-1">
            <FolderList
              ref={listRef}
              id={`${ids}-list`}
              label="Folders"
              entries={entries}
              selected={selectedEntry?.path ?? null}
              busy={loading}
              onSelect={browser.select}
              onOpen={openFolder}
              onUp={() => {
                if (browser.upTarget !== null) void go(browser.upTarget);
              }}
              onDefault={choose}
              className="size-full"
            />
            {error !== null && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface">
                <EmptyState
                  tone="error"
                  icon={<CircleAlert />}
                  title="This folder cannot be opened"
                  description={error}
                  action={
                    <Button
                      icon={<RotateCw />}
                      onClick={() => {
                        void go(location);
                      }}
                    >
                      Try Again
                    </Button>
                  }
                />
              </div>
            )}
            {error === null && listing === null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-fg-subtle">
                <Spinner size={18} label="Loading" />
              </div>
            )}
            {error === null && empty && (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-base text-fg-subtle">
                There are no folders in here.
              </p>
            )}
          </div>
          {chosenIsTaken ? (
            <p
              role="status"
              className="shrink-0 border-t border-separator px-4 py-1.5 text-sm text-fg-muted"
            >
              {TAKEN_HINT} Choose another folder.
            </p>
          ) : (
            shown !== null &&
            shown.videoCount > 0 && (
              <p className="shrink-0 border-t border-separator px-4 py-1.5 text-sm text-fg-subtle">
                {videoFilesText(shown.videoCount)}
              </p>
            )
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-separator bg-subtle/60 px-5 py-3">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <Button
            icon={<FolderPlus />}
            disabled={shown === null}
            onClick={() => {
              setCreating(true);
              setFolderError(null);
            }}
          >
            New Folder
          </Button>
        </div>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={primaryDisabled}
          title={chosenIsTaken ? TAKEN_HINT : primaryLabel}
          className="max-w-[300px]"
          onClick={choose}
        >
          <span className="min-w-0 truncate">{primaryLabel}</span>
        </Button>
      </div>
    </RadixDialog.Content>
  );
}
