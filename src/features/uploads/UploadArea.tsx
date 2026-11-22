import { FolderOpen, Upload } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import type { UploadFolder } from "@/lib/types";
import { useUploads, useVideoUploads } from "./env";
import { ACCEPT, FOLDER_LABELS } from "./summary";
import { UploadRow } from "./UploadRow";

const ZONES: { folder: UploadFolder; description: string }[] = [
  {
    folder: "video",
    description: "The main recording of the video. Its largest video file is the A-roll.",
  },
  { folder: "broll", description: "Extra footage, pictures and audio that the edit can use." },
];

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

function DropZone({
  folder,
  description,
  onFiles,
}: {
  folder: UploadFolder;
  description: string;
  onFiles: (folder: UploadFolder, files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label = FOLDER_LABELS[folder];
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-dropzone={folder}
      className={cn(
        "flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-center transition-colors duration-100",
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
        onFiles(folder, droppedFiles(event));
      }}
    >
      <Upload className="size-5 text-fg-subtle" aria-hidden />
      <h3 id={titleId} className="text-base font-medium text-fg">
        {label}
      </h3>
      <p className="text-xs text-fg-muted">{description}</p>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        tabIndex={-1}
        aria-label={`${label} files`}
        className="sr-only"
        onChange={(event) => {
          onFiles(folder, Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button
        size="sm"
        icon={<FolderOpen />}
        aria-label={`Choose files for the ${label}`}
        onClick={() => {
          input.current?.click();
        }}
      >
        Choose files
      </Button>
    </section>
  );
}

/**
 * The upload area of a video (SPEC section 16): one drop zone for the A-roll and one for the
 * B-roll, with the accepted kinds and the largest size said under them, and the list of this
 * video's files with their progress. The uploads themselves belong to the controller, not to this
 * component.
 */
export function UploadArea({ videoId }: { videoId: string }) {
  const controller = useUploads();
  const items = useVideoUploads(videoId);
  const maxGb = useAppState((s) => s.workspace.data?.settings.maxUploadGb ?? null);
  const add = (folder: UploadFolder, files: File[]) => {
    controller.add(videoId, folder, files);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {ZONES.map((zone) => (
          <DropZone key={zone.folder} {...zone} onFiles={add} />
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        Videos, audio, pictures and text files (txt, md, srt)
        {maxGb !== null && `, up to ${maxGb} GB each`}. Drop them on a box or choose them. Uploads
        go on when you close this window.
      </p>
      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fg">Files</h3>
            {items.some((item) => item.phase === "done") && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  controller.clearFinished(videoId);
                }}
              >
                Clear finished
              </Button>
            )}
          </div>
          <ul aria-label="Files of this video" className="flex flex-col gap-2">
            {items.map((item) => (
              <UploadRow key={item.key} item={item} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
