import { CircleCheck, FileVideo, Pause, Play, TriangleAlert, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button, ConfirmDialog, IconButton, ProgressBar, TruncatedText } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useUploads } from "./env";
import { FOLDER_LABELS, percentOf, statusText } from "./summary";
import { canRetry, needsCancelConfirm, type UploadItem } from "./uploadStore";

/** One file of the upload area, in every state. */
export function UploadRow({ item }: { item: UploadItem }) {
  const controller = useUploads();
  const [confirming, setConfirming] = useState(false);
  const [wrongFile, setWrongFile] = useState<string | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const textId = useId();
  const { phase } = item;
  const percent = percentOf(item.received, item.size);
  const failed = phase === "failed";
  const text = wrongFile ?? statusText(item);

  const cancel = () => {
    if (needsCancelConfirm(item)) setConfirming(true);
    else controller.cancel(item.key);
  };

  return (
    <li
      data-upload-row={item.name}
      data-phase={phase}
      className="flex flex-col gap-1.5 rounded-lg border border-separator bg-subtle px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        {phase === "done" ? (
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
        ) : failed ? (
          <TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
        ) : (
          <FileVideo className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        )}
        <TruncatedText text={item.name} className="min-w-0 text-base font-medium text-fg" />
        <span className="shrink-0 rounded bg-neutral-soft px-1.5 py-px text-xs text-fg-muted">
          {FOLDER_LABELS[item.folder]}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {(phase === "waiting" || phase === "sending") && (
            <IconButton
              label={`Pause ${item.name}`}
              icon={<Pause />}
              size="sm"
              onClick={() => {
                controller.pause(item.key);
              }}
            />
          )}
          {phase === "paused" && (
            <IconButton
              label={`Resume ${item.name}`}
              icon={<Play />}
              size="sm"
              onClick={() => {
                controller.resume(item.key);
              }}
            />
          )}
          {phase === "interrupted" && (
            <>
              <input
                ref={chooser}
                type="file"
                tabIndex={-1}
                aria-label={`Choose ${item.name} again`}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) setWrongFile(controller.chooseAgain(item.key, file));
                }}
              />
              <Button
                size="sm"
                onClick={() => {
                  chooser.current?.click();
                }}
              >
                Choose file
              </Button>
            </>
          )}
          {failed && canRetry(item) && (
            <Button
              size="sm"
              onClick={() => {
                controller.retry(item.key);
              }}
            >
              Try again
            </Button>
          )}
          {phase !== "done" && phase !== "failed" && phase !== "preparing" && (
            <IconButton label={`Cancel ${item.name}`} icon={<X />} size="sm" onClick={cancel} />
          )}
          {(phase === "done" || failed) && (
            <IconButton
              label={`Remove ${item.name} from the list`}
              icon={<X />}
              size="sm"
              onClick={() => {
                controller.dismiss(item.key);
              }}
            />
          )}
        </div>
      </div>
      {phase !== "failed" && (
        <ProgressBar
          value={phase === "done" ? 100 : phase === "preparing" ? null : percent}
          tone={phase === "done" ? "success" : phase === "sending" ? "accent" : "muted"}
          label={`Upload of ${item.name}`}
          valueText={`${percent}%, ${statusText(item)}`}
        />
      )}
      <p
        id={textId}
        role={failed || wrongFile !== null ? "alert" : undefined}
        className={cn(
          "text-xs break-words tabular",
          failed || wrongFile !== null ? "text-danger" : "text-fg-muted",
        )}
      >
        {text}
      </p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Cancel this upload?"
        description={`${item.name} is ${percent}% uploaded. Cancelling deletes what the server received, and the file has to be uploaded again from the start.`}
        confirmLabel="Cancel upload"
        cancelLabel="Keep uploading"
        tone="danger"
        onConfirm={() => {
          controller.cancel(item.key);
        }}
      />
    </li>
  );
}
