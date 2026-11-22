/**
 * What the edit of a video produced (SPEC sections 12 and 16): the project with one button that
 * opens it in the timeline, the finished videos with a player and a download each, thumbnails,
 * and the text files the edit wrote (`info.txt`, `meta.txt`). Everything the wire lists
 * (`VideoView.output`) is shown; every file is served through `api.fileUrl`.
 */
import { Clapperboard, Download, FileText, FileVideo, FolderOpen, ImageOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, EmptyState, ScrollArea, Spinner, buttonVariants } from "@/components/ui";
import { buttonBase, buttonSizes } from "@/components/ui/buttonStyles";
import { useApi, useAppStoreApi } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { formatBytes, formatTimeAgo } from "@/lib/format";
import type { JobView, OutputFile, VideoView } from "@/lib/types";
import { fileName } from "@/features/jobs";

/** How much of a text file is shown; the rest stays behind the download. */
export const TEXT_LIMIT_BYTES = 64 * 1024;

/** One group of outputs; only rendered when it has something in it. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-1.5 flex h-5 items-center">
        <h3 className="text-xs font-semibold text-fg-muted">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/** A link that looks like a small quiet button and downloads a file. */
function DownloadLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      download
      aria-label={label}
      className={cn(buttonBase, buttonSizes.sm, buttonVariants.secondary)}
    >
      <Download aria-hidden />
      Download
    </a>
  );
}

function ProjectCard({ video }: { video: VideoView }) {
  const store = useAppStoreApi();
  const project = video.output.project;
  if (project === null) return null;
  return (
    <Section title="Project">
      <div className="flex items-center gap-3 rounded-lg border border-separator bg-subtle py-2.5 pr-2.5 pl-3">
        <span className="flex shrink-0 text-fg-subtle [&_svg]:size-4">
          <Clapperboard aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium text-fg">Timeline project</p>
          <p className="truncate text-sm text-fg-muted">
            Saved {formatTimeAgo(project.modifiedAt)}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            store.getState().showTimeline(video.id);
          }}
        >
          Open timeline
        </Button>
      </div>
    </Section>
  );
}

function FinalVideo({
  video,
  file,
  latest,
}: {
  video: VideoView;
  file: OutputFile;
  latest: boolean;
}) {
  const api = useApi();
  const [failed, setFailed] = useState(false);
  const url = api.fileUrl(video.id, file.path);
  const downloadUrl = api.fileUrl(video.id, file.path, { download: true });
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-separator p-2">
      {failed ? (
        <div className="flex aspect-video items-center justify-center rounded-md bg-muted px-4 text-center text-sm text-fg-muted">
          This video cannot be played in the page. Download it to watch it.
        </div>
      ) : (
        <video
          controls
          preload="metadata"
          src={url}
          aria-label={`Player of ${file.name}`}
          onError={() => {
            setFailed(true);
          }}
          className="max-h-80 w-full rounded-md bg-black"
        />
      )}
      <div className="flex items-center gap-2.5 pl-0.5">
        <span className="flex shrink-0 text-fg-subtle [&_svg]:size-4">
          <FileVideo aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate text-base font-medium text-fg select-text"
              dir="auto"
              title={file.path}
            >
              {file.name}
            </span>
            {latest && <Badge tone="accent">Latest</Badge>}
          </div>
          <p className="truncate text-sm text-fg-muted">
            {formatBytes(file.size)}, rendered {formatTimeAgo(file.modifiedAt)}
          </p>
        </div>
        <DownloadLink href={downloadUrl} label={`Download ${file.name}`} />
      </div>
    </li>
  );
}

function Thumbnail({ video, file }: { video: VideoView; file: OutputFile }) {
  const api = useApi();
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={api.fileUrl(video.id, file.path)}
      target="_blank"
      rel="noreferrer"
      title={file.name}
      aria-label={`Open ${file.name}`}
      className={cn(
        "focus-ring group relative block overflow-hidden rounded-md bg-muted ring-1 ring-border transition-shadow duration-100 ring-inset hover:ring-2 hover:ring-accent",
        video.videoType === "short" ? "aspect-[9/16]" : "aspect-video",
      )}
    >
      {failed ? (
        <span className="flex size-full items-center justify-center text-fg-subtle [&_svg]:size-4">
          <ImageOff aria-hidden />
        </span>
      ) : (
        <img
          src={api.fileUrl(video.id, file.path)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => {
            setFailed(true);
          }}
          className="size-full object-cover"
        />
      )}
    </a>
  );
}

type TextState =
  | { status: "loading" }
  | { status: "ready"; text: string; truncated: boolean }
  | { status: "error" };

/** Reads at most `TEXT_LIMIT_BYTES` of a response and stops the rest of the transfer. */
async function readLimited(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > TEXT_LIMIT_BYTES
      ? { text: text.slice(0, TEXT_LIMIT_BYTES), truncated: true }
      : { text, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > TEXT_LIMIT_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, TEXT_LIMIT_BYTES)),
    truncated,
  };
}

/** Loads a text file through its file URL once per mount (remount to try again). */
function useTextFile(url: string): TextState {
  const [state, setState] = useState<TextState>({ status: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    fetch(url, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { text, truncated } = await readLimited(response);
        setState({ status: "ready", text, truncated });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ status: "error" });
      });
    return () => {
      abort.abort();
    };
  }, [url]);
  return state;
}

function TextFileBody({ url, name, onRetry }: { url: string; name: string; onRetry: () => void }) {
  const state = useTextFile(url);
  if (state.status === "loading") {
    return (
      <div className="flex h-10 items-center text-fg-subtle">
        <Spinner size={14} label={`Loading ${name}`} />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <span>{`Could not load ${name}.`}</span>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Try Again
        </Button>
      </div>
    );
  }
  return (
    <>
      <pre
        tabIndex={0}
        aria-label={name}
        className="focus-ring max-h-60 overflow-auto rounded-md border border-separator bg-subtle px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-fg select-text"
      >
        {state.text === "" ? "The file is empty." : state.text}
      </pre>
      {state.truncated && (
        <p className="mt-1 text-sm text-fg-muted">
          The file is longer than the preview. Download it to read the rest.
        </p>
      )}
    </>
  );
}

/** One text file of the edit: its name, a download, and its text. */
function TextFile({ video, path }: { video: VideoView; path: string }) {
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const name = fileName(path);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex shrink-0 text-fg-subtle [&_svg]:size-3.5">
          <FileText aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg" title={path}>
          {name}
        </span>
        <DownloadLink
          href={api.fileUrl(video.id, path, { download: true })}
          label={`Download ${name}`}
        />
      </div>
      <TextFileBody
        key={attempt}
        url={api.fileUrl(video.id, path)}
        name={name}
        onRetry={() => {
          setAttempt((n) => n + 1);
        }}
      />
    </div>
  );
}

/** Why a video has no outputs yet, by what its job is doing. */
function emptyDescription(job: JobView | null): string {
  if (job === null) return "Start Editing, and the project appears here when the edit is done.";
  switch (job.state) {
    case "failed":
      return "The job did not finish, so there is nothing to show yet.";
    case "stopped":
      return "The job was stopped before it made anything.";
    case "completed":
      return "The job finished without leaving anything to show.";
    default:
      return job.kind === "render"
        ? "The finished video appears here when the render is done."
        : "The project appears here when the edit is done.";
  }
}

/** The outputs of a video: the project, finished videos, thumbnails, `meta.txt` and `info.txt`. */
export function Outputs({ video }: { video: VideoView }) {
  const { project, finals, thumbnails, metaFile, infoFile } = video.output;
  const empty =
    project === null &&
    finals.length === 0 &&
    thumbnails.length === 0 &&
    metaFile === null &&
    infoFile === null;

  if (empty) {
    return (
      <EmptyState
        className="h-full"
        icon={<FolderOpen />}
        title="No outputs yet"
        description={emptyDescription(video.job)}
      />
    );
  }

  const newestFirst = [...finals].sort((a, b) => b.modifiedAt - a.modifiedAt);
  const texts = [infoFile, metaFile].filter((path): path is string => path !== null);
  return (
    <ScrollArea className="h-full" viewportClassName="px-3 pt-3 pb-4">
      <div className="flex flex-col gap-5">
        <ProjectCard video={video} />
        {newestFirst.length > 0 && (
          <Section title={newestFirst.length > 1 ? "Finished videos" : "Finished video"}>
            <ul className="flex flex-col gap-2">
              {newestFirst.map((file, i) => (
                <FinalVideo
                  key={file.path}
                  video={video}
                  file={file}
                  latest={i === 0 && newestFirst.length > 1}
                />
              ))}
            </ul>
          </Section>
        )}
        {thumbnails.length > 0 && (
          <Section title="Thumbnails">
            <div
              className={cn(
                "grid gap-2",
                video.videoType === "short" ? "grid-cols-4" : "grid-cols-3",
              )}
            >
              {thumbnails.map((file) => (
                <Thumbnail key={file.path} video={video} file={file} />
              ))}
            </div>
          </Section>
        )}
        {texts.length > 0 && (
          <Section title="Files">
            <div className="flex flex-col gap-3">
              {texts.map((path) => (
                <TextFile key={path} video={video} path={path} />
              ))}
            </div>
          </Section>
        )}
      </div>
    </ScrollArea>
  );
}
