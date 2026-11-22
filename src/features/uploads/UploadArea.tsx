import { FolderOpen, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import type { UploadTarget } from "@/lib/types";
import { useTargetUploads, useUploads } from "./env";
import { UploadedFiles } from "./UploadedFiles";
import { UploadRow } from "./UploadRow";

/** The files of a drop; folders that were dropped are left out (a browser cannot read them). */
function droppedFiles(event: DragEvent): File[] {
  const { items, files } = event.dataTransfer;
  if (items.length > 0) {
    const found: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      if (item.webkitGetAsEntry()?.isDirectory === true) continue;
      const file = item.getAsFile();
      if (file) found.push(file);
    }
    return found;
  }
  return Array.from(files);
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <section
      aria-label="Add files"
      data-dropzone
      className={cn(
        "flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-6 text-center transition-colors duration-100",
        over ? "border-accent bg-accent-soft" : "border-border-strong bg-transparent",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onFiles(droppedFiles(event));
      }}
    >
      <Upload className="size-5 text-fg-subtle" aria-hidden />
      <p className="text-base font-medium text-fg">Drop files here</p>
      <input
        ref={input}
        type="file"
        multiple
        tabIndex={-1}
        aria-label="Files to upload"
        className="sr-only"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button
        size="sm"
        icon={<FolderOpen />}
        onClick={() => {
          input.current?.click();
        }}
      >
        Choose Files
      </Button>
    </section>
  );
}

/**
 * The body of the Upload Files dialog (SPEC section 16): one drop zone, the uploads that are not
 * finished with their progress, and the files that are in the folder now. A finished upload leaves
 * the list of uploads once the folder's list has been read again, so it is never shown twice. The
 * uploads themselves belong to the controller, not to this component.
 */
export function UploadArea({ target }: { target: UploadTarget }) {
  const controller = useUploads();
  const items = useTargetUploads(target);
  const maxGb = useAppState((s) => s.workspace.data?.settings.maxUploadGb ?? null);
  const finished = items.filter((item) => item.phase === "done").map((item) => item.key);
  const pending = items.filter((item) => item.phase !== "done");
  const finishedKey = finished.join(",");
  // The folder was read after these uploads finished: its list shows them, so they leave this one.
  const onRead = (readFor: string) => {
    for (const key of readFor.split(",")) if (key !== "") controller.dismiss(key);
  };

  const add = (files: File[]) => {
    controller.add(target, files);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <DropZone onFiles={add} />
        <p className="text-xs text-fg-muted">
          Any kind of file{maxGb !== null && `, up to ${maxGb} GB each`}. Uploads go on when you
          close this window.
        </p>
      </div>
      {pending.length > 0 && (
        <ul aria-label="Uploads" className="flex flex-col gap-2">
          {pending.map((item) => (
            <UploadRow key={item.key} item={item} />
          ))}
        </ul>
      )}
      <UploadedFiles target={target} refreshKey={finishedKey} onRead={onRead} />
    </div>
  );
}
