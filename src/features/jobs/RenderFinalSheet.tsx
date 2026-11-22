import { Clapperboard, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { SegmentedControl, Sheet } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { findVideo } from "@/lib/store";
import type { RenderResolution, VideoType } from "@/lib/types";
import { Callout } from "./Callout";
import { useJobsEnv } from "./env";
import { SheetFooter } from "./SheetFooter";
import { useSubmitShortcut } from "./useSubmitShortcut";

export interface RenderFinalSheetProps {
  /** `<channelId>/<folder name>` of the video to render. */
  videoId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SIZES: Record<RenderResolution, { name: string; long: string; short: string }> = {
  1080: { name: "1080p", long: "1920 x 1080", short: "1080 x 1920" },
  2160: { name: "4K", long: "3840 x 2160", short: "2160 x 3840" },
};

/** The picture size of a resolution for a type of video ("1080p, 1920 x 1080"). */
function sizeLabel(resolution: RenderResolution, type: VideoType | null): string {
  const size = SIZES[resolution];
  if (type === null) return size.name;
  return `${size.name} - ${type === "long" ? size.long : size.short}`;
}

const RESOLUTIONS: readonly RenderResolution[] = [1080, 2160];

/**
 * Render Final (SPEC sections 8 and 16): the resolution of the finished video, nothing else. The
 * render always uses the timeline as it is now; a refusal of the server (the renderer is not
 * prepared, the project fails its check, a job is running, not enough disk space) stays in the
 * sheet as the server words it. Used by the video row and by the Timeline screen, which only give
 * the video and whether the sheet is open.
 */
export function RenderFinalSheet({ videoId, open, onOpenChange }: RenderFinalSheetProps) {
  const { controller } = useJobsEnv();
  const formId = useId();
  const video = useAppState((s) => findVideo(s.library.data, videoId));
  const [resolution, setResolution] = useState<RenderResolution>(1080);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = video?.videoType ?? null;

  const submit = () => {
    if (submitting || !open) return;
    setSubmitting(true);
    setError(null);
    void controller.submitRenderFinal(videoId, resolution).then((refusal) => {
      setSubmitting(false);
      if (refusal) setError(refusal.message);
      else onOpenChange(false);
    });
  };
  useSubmitShortcut(() => {
    if (open) submit();
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      dismissible={!submitting}
      title="Render Final"
      description={
        <span dir="auto">{video?.folderName ?? videoId.slice(videoId.indexOf("/") + 1)}</span>
      }
      footer={
        <SheetFooter
          form={formId}
          submitLabel="Render Final"
          shortcutHint="to render"
          submitIcon={<Clapperboard />}
          submitting={submitting}
          onCancel={() => {
            onOpenChange(false);
          }}
        />
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error && (
          <Callout tone="danger" icon={<TriangleAlert />} title="Could not start the final render">
            {error}
          </Callout>
        )}
        <p className="text-base text-fg">VidAI renders the video as it is in the timeline now.</p>
        <div className="flex flex-col gap-1.5">
          <p className="text-base font-medium text-fg" aria-hidden>
            Resolution
          </p>
          <SegmentedControl
            aria-label="Resolution"
            value={String(resolution)}
            disabled={submitting}
            onValueChange={(value) => {
              setResolution(Number(value) as RenderResolution);
            }}
            options={RESOLUTIONS.map((r) => ({ value: String(r), label: SIZES[r].name }))}
          />
          <p className="text-sm text-fg-muted" aria-live="polite">
            {sizeLabel(resolution, type)}. The finished video appears under the video when it is
            done.
          </p>
        </div>
      </form>
    </Sheet>
  );
}
