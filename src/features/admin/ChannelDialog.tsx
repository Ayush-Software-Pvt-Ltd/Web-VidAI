import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import {
  Button,
  Dialog,
  Field,
  PathText,
  SegmentedControl,
  Select,
  toast,
  Input,
} from "@/components/ui";
import { useApi } from "@/lib/appEnv";
import { toApiError, type ApiError } from "@/lib/errors";
import { CHANNEL_TYPE_LABELS } from "@/lib/status";
import type { AdminChannel, ChannelVideoType, UserAccount } from "@/lib/types";
import { FolderPickerDialog } from "@/features/filepicker";

/** The sentence of the server for a channel whose owner or folder cannot change right now. */
export const CHANNEL_BUSY_REASON = "Stop the running edits of this channel's videos first.";

const TYPE_OPTIONS = (["auto", "long", "short"] as const).map((value) => ({
  value,
  label: CHANNEL_TYPE_LABELS[value],
}));

type ChannelField = "name" | "userId" | "dir" | "videoType" | "form";

const FIELDS: readonly ChannelField[] = ["name", "userId", "dir", "videoType"];

/** Where a refusal is shown: at the field the server named, else at the top of the form. */
function fieldOfRefusal(error: ApiError): ChannelField {
  return FIELDS.find((name) => name === error.field) ?? "form";
}

export interface ChannelDialogProps {
  /** `null` makes a channel; a channel edits it. */
  channel: AdminChannel | null;
  /** Every account, for the owner. */
  users: readonly UserAccount[];
  onClose: () => void;
  /** Called after the server accepted the change, before the dialog closes. */
  onSaved: () => void;
}

/**
 * Make or change one channel (SPEC section 6, "Channels"): its name, the user it belongs to, its
 * video type and its folder, which is chosen with the folder picker over the whole server. The
 * page mounts it only while it is open. A refusal is shown at the field it belongs to, worded by
 * the server. While a job of the channel's videos waits, runs or is paused, the owner and the
 * folder cannot change: they are disabled and say why.
 */
export function ChannelDialog({ channel, users, onClose, onSaved }: ChannelDialogProps) {
  const api = useApi();
  const formId = useId();
  const dirLabelId = useId();
  const dirNoteId = useId();
  const [name, setName] = useState(channel?.name ?? "");
  const [userId, setUserId] = useState<string | undefined>(channel?.userId);
  const [dir, setDir] = useState<string | null>(channel?.dir ?? null);
  const [videoType, setVideoType] = useState<ChannelVideoType>(channel?.videoType ?? "auto");
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<ChannelField, string>>>({});
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const ownerRow = useRef<HTMLDivElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const locked = channel?.busy === true;

  // A refusal puts the focus on the field it is about (the controls are enabled again by then).
  useEffect(() => {
    if (errors.name) nameRef.current?.focus();
    else if (errors.userId) ownerRow.current?.querySelector("button")?.focus();
    else if (errors.dir) chooseRef.current?.focus();
  }, [errors]);

  const trimmed = name.trim();
  const canSave = trimmed !== "" && userId !== undefined && dir !== null;

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy || !canSave) return;
    setErrors({});
    setBusy(true);
    try {
      if (channel === null) {
        await api.adminCreateChannel({ name: trimmed, userId, dir, videoType });
        toast.success("Channel created", trimmed);
      } else {
        // A field that did not change is left as it is (`null`), so a locked one is never sent.
        const update = {
          name: trimmed !== channel.name ? trimmed : null,
          userId: userId !== channel.userId ? userId : null,
          dir: dir !== channel.dir ? dir : null,
          videoType: videoType !== channel.videoType ? videoType : null,
        };
        if (Object.values(update).some((value) => value !== null)) {
          await api.adminUpdateChannel({ id: channel.id, update });
          toast.success("Channel changed", trimmed);
        }
      }
      onSaved();
      onClose();
    } catch (caught) {
      const error = toApiError(caught);
      setBusy(false);
      setErrors({ [fieldOfRefusal(error)]: error.message });
    }
  }

  const lockedNote = locked ? CHANNEL_BUSY_REASON : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="md"
      dismissible={!busy}
      title={channel === null ? "New Channel" : "Edit Channel"}
      description={
        channel === null
          ? "Give an existing folder to a user. Each video is a folder inside it."
          : "The videos stay where they are; only the channel's record changes."
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={!canSave}>
            {channel === null ? "Create Channel" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        {/* The visible button sits in the footer, outside the form: this one lets Enter submit. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        {errors.form && (
          <p role="alert" className="text-sm text-danger">
            {errors.form}
          </p>
        )}
        <Field label="Name" error={errors.name}>
          {(id, describedBy) => (
            <Input
              ref={nameRef}
              id={id}
              name="name"
              autoFocus
              dir="auto"
              placeholder="For example Glow Naturals"
              aria-describedby={describedBy}
              invalid={errors.name !== undefined}
              value={name}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Owner" hint={lockedNote} error={errors.userId}>
          {(id, describedBy) => (
            <div ref={ownerRow}>
              <Select
                id={id}
                aria-describedby={describedBy}
                aria-invalid={errors.userId !== undefined}
                value={userId}
                placeholder="Choose a user"
                options={users.map((user) => ({
                  value: user.id,
                  label: user.disabled ? `${user.email} (disabled)` : user.email,
                }))}
                disabled={busy || locked}
                className="w-full"
                onValueChange={setUserId}
              />
            </div>
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg" aria-hidden>
            Video type
          </span>
          <SegmentedControl<ChannelVideoType>
            aria-label="Video type"
            value={videoType}
            options={TYPE_OPTIONS}
            disabled={busy}
            onValueChange={setVideoType}
          />
          {errors.videoType && (
            <p role="alert" className="text-xs text-danger">
              {errors.videoType}
            </p>
          )}
        </div>
        <div role="group" aria-labelledby={dirLabelId} className="flex flex-col gap-1.5">
          <span id={dirLabelId} className="text-sm font-medium text-fg">
            Folder
          </span>
          <div className="flex items-start gap-2">
            <div
              className="flex min-h-7 min-w-0 flex-1 items-center rounded-md border border-border bg-subtle px-2.5 py-1"
              data-testid="channel-folder"
            >
              {dir === null ? (
                <span className="text-base text-fg-subtle">No folder chosen yet.</span>
              ) : (
                <PathText path={dir} className="break-words text-fg" />
              )}
            </div>
            <Button
              ref={chooseRef}
              disabled={busy || locked}
              aria-describedby={errors.dir || lockedNote ? dirNoteId : undefined}
              onClick={() => {
                setPicking(true);
              }}
            >
              Choose…
            </Button>
          </div>
          {(errors.dir ?? lockedNote) && (
            <p
              id={dirNoteId}
              role={errors.dir ? "alert" : undefined}
              className={errors.dir ? "text-xs text-danger" : "text-xs text-fg-muted"}
            >
              {errors.dir ?? lockedNote}
            </p>
          )}
        </div>
      </form>

      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        title="Choose the channel's folder"
        startPath={dir}
        onPick={(path) => {
          setDir(path);
          setErrors((current) => ({ ...current, dir: undefined }));
        }}
      />
    </Dialog>
  );
}
