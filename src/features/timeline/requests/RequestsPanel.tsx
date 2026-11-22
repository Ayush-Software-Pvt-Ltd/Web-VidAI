import { MessageSquarePlus } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { PRIORITY, useKeyClaim } from "../keys";
import { usePlayback } from "../playback";
import { AskForm } from "./AskForm";
import { NoteList } from "./NoteList";
import { RenderFinalSection } from "./RenderFinalSection";
import { useRequests, useRequestsStore } from "./requestsState";

export interface RequestsPanelProps {
  videoId: string;
}

/**
 * The column beside the player (SPEC section 11): "Ask for a change", the form while the user
 * draws, the list of change requests and, at the bottom, Render Final. The key C asks for a change
 * and Esc cancels the request being written (claimed through `../keys.ts`).
 */
export function RequestsPanel({ videoId }: RequestsPanelProps) {
  const playback = usePlayback();
  const requests = useRequestsStore();
  const drawing = useRequests((s) => s.drawing);
  const timeline = useAppState((s) => s.timelines[videoId]?.timeline.data ?? null);
  const ready = timeline !== null;

  // C and Esc come from the screen's one key owner (`../keys.ts`), which has already left out text
  // fields and open sheets; Esc here cancels the request being written and nothing else.
  useKeyClaim("c", () => {
    if (!ready) return false;
    requests.getState().start(playback.getState().frame);
    return true;
  });
  useKeyClaim(
    "Escape",
    () => {
      const state = requests.getState();
      if (!state.drawing) return false;
      state.cancel();
      return true;
    },
    PRIORITY.request,
  );

  return (
    <aside aria-label="Change requests and Render Final" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex flex-col gap-1.5">
          <Button
            variant="primary"
            icon={<MessageSquarePlus />}
            disabled={!ready || drawing}
            onClick={() => {
              requests.getState().start(playback.getState().frame);
            }}
          >
            Ask for a Change
            <Kbd keys={["C"]} className="ml-1" />
          </Button>
          {!ready && (
            <p className="text-sm text-fg-muted">
              The project is not open, so there is nothing to ask about yet.
            </p>
          )}
        </div>
        {timeline && drawing && <AskForm videoId={videoId} timeline={timeline} />}
        {timeline && <NoteList videoId={videoId} timeline={timeline} />}
      </div>
      <div className="shrink-0 border-t border-separator p-3">
        <RenderFinalSection videoId={videoId} />
      </div>
    </aside>
  );
}
