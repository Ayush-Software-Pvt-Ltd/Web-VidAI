/**
 * The type badge of a video row (`Long 16:9` / `Short 9:16`) with a menu to pick Auto, Long or
 * Short. It marks a manual choice (pin), a type set by the channel's video type setting (TV) and
 * an unverified guess when no A-roll could be read (question mark), as SPEC sections 8 and 9 ask.
 * The tooltip says where the type comes from, including a type detected from the picture of an
 * A-roll filmed with the camera turned sideways (`typeInfo` in ./presentation).
 */
import { ChevronDown, CircleHelp, Pin, Tv } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  toast,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { useAppStoreApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import type { AppStore } from "@/lib/store";
import { videoTypeLabel } from "@/lib/status";
import type { TypeSource, VideoType, VideoView } from "@/lib/types";
import { hasActiveJob } from "./model";
import { autoTypeHint, typeInfo } from "./presentation";
import { useLibraryView } from "./viewStore";

type TypeChoice = "auto" | VideoType;

/** The badge marks where the type comes from: a pin for your choice, a TV for the channel's
 * setting, a question mark for a guess; a detected type needs no mark. */
const SOURCE_STYLES: Record<TypeSource, string> = {
  override: "border-accent/40 text-accent-text",
  channel: "border-border-strong text-fg",
  detected: "border-border text-fg-muted",
  assumed: "border-warning/45 text-warning",
};

/** Shows the choice at once and saves it; a refusal takes it back and says why. */
async function saveType(store: AppStore, video: VideoView, type: VideoType | null): Promise<void> {
  const view = useLibraryView.getState();
  view.setPendingType(video.id, type);
  try {
    await store.getState().setVideoTypeOverride(video.id, type);
  } catch (error) {
    view.clearPendingType(video.id);
    toast.error("Could not change the video type", toApiError(error).message);
  }
}

export function VideoTypeMenu({ video, tabbable }: { video: VideoView; tabbable: boolean }) {
  const store = useAppStoreApi();
  const pending = useLibraryView((s) => s.pendingTypes[video.id]);
  const info = typeInfo(video, pending);
  const value: TypeChoice = info.override ?? "auto";

  return (
    <DropdownMenu modal={false}>
      <Tooltip content={info.note} side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            tabIndex={tabbable ? 0 : -1}
            aria-label={`Video type: ${videoTypeLabel(info.type)}. ${info.note} Change video type`}
            data-type-source={info.source}
            className={cn(
              "focus-ring group/type inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border pr-1 pl-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-100 [&_svg]:size-3 [&_svg]:shrink-0",
              SOURCE_STYLES[info.source],
              "bg-control shadow-control hover:bg-control-hover data-[state=open]:bg-control-active",
            )}
          >
            {info.source === "override" && <Pin aria-hidden className="-ml-0.5" />}
            {info.source === "channel" && <Tv aria-hidden className="-ml-0.5" />}
            {info.source === "assumed" && <CircleHelp aria-hidden className="-ml-0.5" />}
            {videoTypeLabel(info.type)}
            <ChevronDown
              aria-hidden
              className="opacity-60 transition-opacity group-hover/type:opacity-100"
            />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-[250px]">
        <DropdownMenuLabel>Video type</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const type = next === "auto" ? null : (next as VideoType);
            if (type !== info.override) void saveType(store, video, type);
          }}
        >
          <DropdownMenuRadioItem value="auto" className="group h-auto min-h-7 py-1">
            <span className="flex min-w-0 flex-col">
              <span>Auto</span>
              <span className="text-sm text-fg-muted group-data-[highlighted]:text-accent-fg/80">
                {autoTypeHint(info.auto)}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="long">Long 16:9</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="short">Short 9:16</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {hasActiveJob(video) && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pt-0.5 pb-1 text-xs text-fg-subtle">
              The edit in progress keeps the type it started with.
            </p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
