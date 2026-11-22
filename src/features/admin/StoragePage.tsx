/**
 * Admin, Storage (SPEC sections 5 and 6): the folders inside which users may place channels (the
 * default `<data dir>/media` is always one), the largest upload and the preview-copy cache.
 * Folders are added by typed full path and removed with a click; both are saved at once as the
 * whole list, because the server keeps the list as one setting. Whether a folder can be reached
 * right now comes from `fsPlaces`. Removing a folder never touches the channels already in it, and
 * the server refuses to drop a folder that still holds channels: that sentence is shown under the
 * folder's own row, and the list stays as it was. The default storage folder is not in the list,
 * so it has no remove control.
 */
import { Plus, X } from "lucide-react";
import { useEffect, useId, useState, type SyntheticEvent } from "react";
import { Badge, Button, EmptyState, IconButton, Input, PathText, Spinner } from "@/components/ui";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import { toApiError, type ApiError } from "@/lib/errors";
import type { FsPlace } from "@/lib/types";
import { Callout, Group, SettingsPage, useAction, useLoad } from "@/features/settings";
import { NumberRow, SaveBar } from "./fields";
import { useSettingsDraft } from "./useSettingsDraft";

const KEYS = ["maxUploadGb", "proxyCacheGb"] as const;
const LABELS = { maxUploadGb: "largest upload", proxyCacheGb: "preview copy cache" } as const;

export function StoragePage() {
  const draft = useSettingsDraft(KEYS, {
    name: "Storage",
    label: (key) => LABELS[key as (typeof KEYS)[number]],
  });
  const { data, status, error } = draft.settings;

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        {status === "error" && error ? (
          <EmptyState
            tone="error"
            title="The settings could not be loaded"
            description={error.message}
            action={<Button onClick={draft.reload}>Try Again</Button>}
          />
        ) : (
          <Spinner label="Loading the settings" />
        )}
      </div>
    );
  }

  return (
    <SettingsPage>
      <FoldersGroup roots={data.storageRoots} />
      <Group
        title="Uploads and previews"
        description="Limits on what users send and on what VidAI keeps for faster playback."
      >
        <NumberRow
          draft={draft}
          field="maxUploadGb"
          label="Largest upload"
          description="The biggest single file a user may upload."
          unit="GB"
        />
        <NumberRow
          draft={draft}
          field="proxyCacheGb"
          label="Preview copies"
          description="VidAI keeps small preview copies of videos for the timeline. When they take more than this, the oldest are deleted. They are made again when needed."
          unit="GB"
        />
      </Group>
      <SaveBar draft={draft} />
    </SettingsPage>
  );
}

/** The folder list is saved by itself (Add and Remove apply at once), not through the draft. */
function FoldersGroup({ roots }: { roots: string[] }) {
  const api = useApi();
  const store = useAppStoreApi();
  const loadedRoots = useAppState((s) => s.adminSettings.data?.storageRoots);
  const places = useLoad(() => api.fsPlaces());
  const [typed, setTyped] = useState("");
  // The folder whose Remove was clicked last: a refusal of that save belongs to its row.
  const [removing, setRemoving] = useState<string | null>(null);
  const inputId = useId();

  // A saved list changes what can be reached: ask again.
  const listKey = (loadedRoots ?? roots).join("\n");
  const { reload } = places;
  useEffect(() => {
    void reload();
  }, [listKey, reload]);

  const save = useAction(async (next: string[]) => {
    const result = await api.adminUpdateSettings({ storageRoots: next });
    store.getState().setAdminSettings(result);
  });

  const add = async (event: SyntheticEvent) => {
    event.preventDefault();
    const path = typed.trim();
    if (path === "" || save.pending) return;
    setRemoving(null);
    if (await save.run([...roots, path])) setTyped("");
  };

  const reachable = (path: string): boolean | null => {
    const place = places.data?.find((p: FsPlace) => p.path === path);
    return place ? place.available : null;
  };
  const refused: ApiError | null = save.error;
  const refusedAt = refused && removing !== null && roots.includes(removing) ? removing : null;

  return (
    <Group
      title="Storage folders"
      description="Users can place their channels only inside these folders. The folder VidAI keeps its own files in is always allowed."
      footer={
        <>
          Removing a folder does not move or delete anything in it. Channels that are already there
          keep working, but nobody can place new ones in it.
        </>
      }
    >
      <div className="flex flex-col divide-y divide-separator">
        {roots.length === 0 && (
          <p className="px-4 py-3 text-base text-fg-muted">
            No extra folder yet. Users can use the default storage folder.
          </p>
        )}
        {roots.map((path) => {
          const ok = reachable(path);
          const note = refusedAt === path ? refused : null;
          const noteId = `${inputId}-refusal-${String(roots.indexOf(path))}`;
          return (
            <div key={path} data-testid="root-row">
              <div className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <PathText path={path} className="text-fg" />
                </div>
                {ok === false && <Badge tone="warning">Cannot be reached</Badge>}
                {ok === true && <Badge tone="success">Available</Badge>}
                <IconButton
                  label={`Remove ${path}`}
                  icon={<X />}
                  disabled={save.pending}
                  aria-describedby={note ? noteId : undefined}
                  onClick={() => {
                    setRemoving(path);
                    void save.run(roots.filter((root) => root !== path));
                  }}
                />
              </div>
              {note && (
                <p id={noteId} role="alert" className="px-4 pb-2.5 text-sm text-danger">
                  {note.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <form
        onSubmit={(event) => void add(event)}
        className="flex items-center gap-2 px-4 py-3"
        noValidate
      >
        <label htmlFor={inputId} className="sr-only">
          Full path of a folder to add
        </label>
        <Input
          id={inputId}
          value={typed}
          placeholder="/full/path/to/a/folder"
          invalid={refused !== null && typed !== ""}
          wrapperClassName="flex-1"
          onChange={(event) => {
            setTyped(event.target.value);
            if (refused) save.clearError();
          }}
        />
        <Button type="submit" icon={<Plus />} loading={save.pending} disabled={typed.trim() === ""}>
          Add Folder
        </Button>
      </form>
      {refused && refusedAt === null && (
        <div className="px-4 pb-3">
          <Callout tone="danger" live title="The folders were not changed">
            {refused.message}
          </Callout>
        </div>
      )}
      {places.error && !places.data && (
        <div className="px-4 pb-3 text-sm text-fg-muted">
          Whether a folder can be reached is not known right now: {toApiError(places.error).message}
        </div>
      )}
    </Group>
  );
}
