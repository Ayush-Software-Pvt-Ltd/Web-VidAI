import { TriangleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button, Dialog, Field, Input, Select } from "@/components/ui";
import { Callout } from "@/features/jobs";
import { useAppState } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { findVideo } from "@/lib/store";
import { folderNameOf } from "@/lib/videoId";
import { useUploads } from "./env";
import { UploadArea } from "./UploadArea";
import { videoNameProblem } from "./validation";

/** What the dialog shows: the name of a new video, or the upload area of a video. */
export type DialogStep =
  { kind: "name"; channelId: string | null } | { kind: "files"; videoId: string; created: boolean };

/**
 * New Video and Upload files in one dialog (SPEC section 16). New Video asks for the channel (only
 * when none is selected) and the name, makes the folder, and then the same dialog turns into the
 * upload area of the new video. "Upload files" from a row's menu opens it at the upload area.
 * Closing it never stops an upload: they belong to the uploads controller.
 */
export function NewVideoDialog({ step, onClose }: { step: DialogStep; onClose: () => void }) {
  return step.kind === "name" ? (
    <NameStep channelId={step.channelId} onClose={onClose} />
  ) : (
    <FilesStep videoId={step.videoId} created={step.created} onClose={onClose} />
  );
}

function NameStep({ channelId, onClose }: { channelId: string | null; onClose: () => void }) {
  const controller = useUploads();
  const formId = useId();
  const channels = useAppState((s) => s.workspace.data?.channels);
  const choices = (channels ?? []).filter((channel) => channel.available);
  const fixed = channelId === null ? null : (channels ?? []).find((c) => c.id === channelId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [shown, setShown] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);

  const target = channelId ?? chosen ?? choices[0]?.id ?? null;
  const problem = videoNameProblem(name);
  const error = serverError ?? (shown ? problem : null);

  const submit = async () => {
    if (submitting) return;
    setShown(true);
    if (problem !== null || target === null) {
      nameField.current?.focus();
      return;
    }
    setSubmitting(true);
    setServerError(null);
    try {
      await controller.createVideo(target, name);
    } catch (failure) {
      setServerError(toApiError(failure).message);
      nameField.current?.focus();
      setSubmitting(false);
    }
  };

  const noChannel = channelId === null && choices.length === 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dismissible={!submitting}
      title="New Video"
      description={
        fixed ? <span dir="auto">In the channel {fixed.name}</span> : "Name the video first."
      }
      footer={
        <>
          <Button disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={submitting}
            disabled={noChannel}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {noChannel && (
          <Callout tone="warning" icon={<TriangleAlert />} title="There is no channel to put it in">
            Add a channel in Settings first, or ask your admin if its folder cannot be reached.
          </Callout>
        )}
        {channelId === null && !noChannel && (
          <Field label="Channel">
            {(id) => (
              <Select
                id={id}
                value={target ?? undefined}
                onValueChange={setChosen}
                options={choices.map((channel) => ({ value: channel.id, label: channel.name }))}
                disabled={submitting}
              />
            )}
          </Field>
        )}
        <Field label="Name" hint="This becomes the name of the video's folder." error={error}>
          {(id, describedBy) => (
            <Input
              ref={nameField}
              id={id}
              aria-describedby={describedBy}
              aria-required
              autoFocus
              autoComplete="off"
              invalid={error !== null}
              disabled={submitting}
              placeholder="For example: Hair Oil Review"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setServerError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function FilesStep({
  videoId,
  created,
  onClose,
}: {
  videoId: string;
  created: boolean;
  onClose: () => void;
}) {
  const video = useAppState((s) => findVideo(s.library.data, videoId));
  const channelName = useAppState(
    (s) => s.workspace.data?.channels.find((c) => c.id === video?.channelId)?.name,
  );
  const folderName = video?.folderName ?? folderNameOf(videoId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title="Upload files"
      description={
        <span dir="auto">
          {created
            ? `${folderName} was created${channelName ? ` in ${channelName}` : ""}. Add its footage.`
            : folderName}
        </span>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <UploadArea videoId={videoId} />
    </Dialog>
  );
}
