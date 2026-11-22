/**
 * "New channel": a name, a video type and where the channel's videos live: a new folder in the
 * user's personal folder (the default), a new folder in a place the user chooses, or an existing
 * folder. The folder is chosen in the in-page folder picker; the server's refusal (`conflict`,
 * `forbidden`, `invalidInput`) is shown under the field it belongs to.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Field, Input, PathText, SegmentedControl } from "@/components/ui";
import { useApi, useAppStoreApi } from "@/lib/appEnv";
import { baseName } from "@/lib/paths";
import { CHANNEL_TYPE_LABELS } from "@/lib/status";
import type { Channel, ChannelCreate, ChannelVideoType } from "@/lib/types";
import { FolderPickerDialog } from "@/features/filepicker";
import { useAction } from "../useAction";
import { channelNameProblem, MAX_CHANNEL_NAME_CHARS } from "./draft";
import { newChannelPath } from "./folderName";

type Place = "personal" | "place" | "existing";
type Picking = "parent" | "existing";

const PLACE_OPTIONS: { value: Place; label: string }[] = [
  { value: "personal", label: "My folder" },
  { value: "place", label: "Another place" },
  { value: "existing", label: "Existing folder" },
];

const TYPE_OPTIONS = (["auto", "long", "short"] as const).map((value) => ({
  value,
  label: CHANNEL_TYPE_LABELS[value],
}));

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the channel the server made. */
  onCreated: (channel: Channel) => void;
}) {
  const api = useApi();
  const store = useAppStoreApi();
  const [name, setName] = useState("");
  const [videoType, setVideoType] = useState<ChannelVideoType>("auto");
  const [place, setPlace] = useState<Place>("personal");
  const [parent, setParent] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [personal, setPersonal] = useState<string | null>(null);

  // The user's personal folder, to show where a new folder will be made.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .fsPlaces()
      .then((places) => {
        if (live) setPersonal(places.find((p) => p.kind === "personal")?.path ?? null);
      })
      .catch(() => {
        // Only the preview is missing; creating the channel does not need it.
      });
    return () => {
      live = false;
    };
  }, [api, open]);

  const trimmed = name.trim();
  const nameProblem = trimmed === "" ? null : channelNameProblem(trimmed);
  const folder = place === "existing" ? existing : place === "place" ? parent : personal;
  const chosen = place === "personal" ? true : folder !== null;
  const preview =
    place === "existing" || folder === null ? null : newChannelPath(folder, trimmed || "…");

  const resetFields = () => {
    setName("");
    setVideoType("auto");
    setPlace("personal");
    setParent(null);
    setExisting(null);
    setPicking(null);
  };

  const create = useAction(async () => {
    const location: ChannelCreate["location"] =
      place === "existing" && existing !== null
        ? { kind: "link", dir: existing }
        : { kind: "new", parent: place === "place" ? parent : null, folderName: null };
    const channel = await store.getState().createChannel({ name: trimmed, videoType, location });
    onCreated(channel);
    resetFields();
    onOpenChange(false);
  });

  const close = () => {
    resetFields();
    create.clearError();
    onOpenChange(false);
  };

  const canCreate = trimmed !== "" && nameProblem === null && chosen && !create.pending;
  const submit = () => {
    if (canCreate) void create.run();
  };

  const error = create.error;
  // A folder that is refused belongs under the folder field; a taken name under the name.
  const errorOnFolder = error !== null && (place === "existing" || error.code === "forbidden");
  const pick = (path: string) => {
    create.clearError();
    if (picking === "existing") {
      setExisting(path);
      if (name.trim() === "")
        setName(Array.from(baseName(path)).slice(0, MAX_CHANNEL_NAME_CHARS).join(""));
    } else {
      setParent(path);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
      dismissible={!create.pending}
      size="md"
      title="New Channel"
      description="Name it and say where its videos live. Each video is a folder inside the channel's folder."
      footer={
        <>
          <Button disabled={create.pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="new-channel-form"
            loading={create.pending}
            disabled={!canCreate}
          >
            Create Channel
          </Button>
        </>
      }
    >
      <form
        id="new-channel-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Channel name"
          error={nameProblem ?? (error && !errorOnFolder ? error.message : undefined)}
        >
          {(id, describedBy) => (
            <Input
              id={id}
              value={name}
              autoFocus
              dir="auto"
              placeholder="For example Glow Naturals"
              invalid={nameProblem !== null || (error !== null && !errorOnFolder)}
              aria-describedby={describedBy}
              onChange={(event) => {
                setName(event.target.value);
                create.clearError();
              }}
            />
          )}
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg" aria-hidden>
            Video type
          </span>
          <SegmentedControl<ChannelVideoType>
            aria-label="Channel video type"
            value={videoType}
            options={TYPE_OPTIONS}
            onValueChange={setVideoType}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg" aria-hidden>
            Where the videos live
          </span>
          <SegmentedControl<Place>
            aria-label="Where the videos live"
            value={place}
            options={PLACE_OPTIONS}
            onValueChange={(next) => {
              setPlace(next);
              create.clearError();
            }}
          />
          <div className="flex flex-col gap-1.5 text-sm" aria-live="polite">
            {place === "personal" && (
              <>
                <p className="text-fg-muted">
                  A new folder is made in your personal folder on the server.
                </p>
                {preview && <PathText path={preview} />}
              </>
            )}
            {place !== "personal" && (
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  {folder !== null ? (
                    <PathText path={folder} className="break-words" />
                  ) : (
                    <span className="text-fg-subtle">
                      {place === "place" ? "No place chosen yet." : "No folder chosen yet."}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setPicking(place === "place" ? "parent" : "existing");
                  }}
                >
                  {folder === null ? "Choose Folder…" : "Change Folder…"}
                </Button>
              </div>
            )}
            {place === "place" && (
              <p className="text-fg-muted">
                {preview
                  ? "A new folder is made here:"
                  : "A new folder is made inside the place you choose."}
              </p>
            )}
            {place === "place" && preview && <PathText path={preview} />}
            {place === "existing" && (
              <p className="text-fg-muted">
                The folder and everything in it stay as they are. A folder that belongs to a channel
                cannot be used.
              </p>
            )}
            {errorOnFolder && (
              <p role="alert" className="text-xs text-danger">
                {error.message}
              </p>
            )}
          </div>
        </div>
      </form>

      <FolderPickerDialog
        open={picking !== null}
        onOpenChange={(next) => {
          if (!next) setPicking(null);
        }}
        title={picking === "existing" ? "Choose the channel's folder" : "Choose where to make it"}
        startPath={picking === "existing" ? existing : parent}
        onPick={pick}
      />
    </Dialog>
  );
}
