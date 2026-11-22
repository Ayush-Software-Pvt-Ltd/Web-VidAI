import { File as FileIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Spinner, TruncatedText } from "@/components/ui";
import { useApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { formatBytes, formatLocalDateTime, pluralize } from "@/lib/format";
import type { UploadedFile, UploadTarget } from "@/lib/types";

interface Listing {
  files: UploadedFile[] | null;
  error: string | null;
}

/**
 * The files that are in the upload folder now (`listUploads`). It reads the folder when it opens
 * and again whenever `refreshKey` changes to something that names finished uploads, and then
 * tells its owner with `onRead(refreshKey)`.
 */
export function UploadedFiles({
  target,
  refreshKey,
  onRead,
}: {
  target: UploadTarget;
  refreshKey: string;
  onRead: (readFor: string) => void;
}) {
  const api = useApi();
  const [listing, setListing] = useState<Listing>({ files: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const readOnce = useRef(false);
  const lastAttempt = useRef(0);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  });
  const targetKey = target.kind === "video" ? `v:${target.videoId}` : `c:${target.channelId}`;

  useEffect(() => {
    // Uploads that left the list change the key to "": nothing new to read.
    const retried = attempt !== lastAttempt.current;
    lastAttempt.current = attempt;
    if (refreshKey === "" && readOnce.current && !retried) return;
    let current = true;
    api.listUploads({ target }).then(
      (files) => {
        if (!current) return;
        readOnce.current = true;
        setListing({ files, error: null });
        onReadRef.current(refreshKey);
      },
      (error: unknown) => {
        if (!current) return;
        setListing((was) => ({ files: was.files, error: toApiError(error).message }));
      },
    );
    return () => {
      current = false;
    };
    // `target` is covered by `targetKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, targetKey, refreshKey, attempt]);

  const { files, error } = listing;
  return (
    <section aria-label="Files in the folder" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-fg">Files in the folder</h3>
        {files !== null && files.length > 0 && (
          <span className="text-xs text-fg-muted tabular">{pluralize(files.length, "file")}</span>
        )}
      </div>
      {error !== null && (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm text-danger">
          <span className="min-w-0 break-words">{error}</span>
          <Button
            size="sm"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {files === null ? (
        error === null && (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Reading the folder
          </p>
        )
      ) : files.length === 0 ? (
        <p className="text-sm text-fg-muted">No files in this folder yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator rounded-lg border border-separator">
          {files.map((file) => (
            <li
              key={file.name}
              data-uploaded-file={file.name}
              className="flex items-center gap-2 px-3 py-2"
            >
              <FileIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <TruncatedText text={file.name} className="min-w-0 flex-1 text-base text-fg" />
              <span className="w-[72px] shrink-0 text-right text-sm text-fg-muted tabular">
                {formatBytes(file.size)}
              </span>
              <span className="w-[120px] shrink-0 text-right text-sm text-fg-muted tabular">
                {formatLocalDateTime(file.modifiedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
