import { Send } from "lucide-react";
import { useEffect, useId, useRef, useState, type SyntheticEvent, type KeyboardEvent } from "react";
import { Button, Field, Kbd, Textarea } from "@/components/ui";
import { useAppStoreApi, usePlatform } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { toApiError } from "@/lib/errors";
import { isShortcut } from "@/lib/platform";
import type { Timeline } from "@/lib/types";
import { useLock } from "../useLock";
import { clampFrame, isMotionGraphic, lastFrame, timeCode } from "../model";
import {
  clipName,
  effectiveAbout,
  pictureClipsAt,
  useRequests,
  useRequestsStore,
} from "./requestsState";

/** The longest text of a request (the server's limit, in characters). */
export const MAX_TEXT = 4000;
/** From this many characters on, the count is shown. */
const COUNT_FROM = 3500;

const length = (text: string) => Array.from(text.trim()).length;

/** What is wrong with the request as it stands, one sentence each (shown after a Send attempt). */
function problems(text: string, hasArea: boolean): { text: string | null; area: string | null } {
  const size = length(text);
  return {
    text:
      size < 1
        ? "Write what should change."
        : size > MAX_TEXT
          ? `The text can have at most ${MAX_TEXT} characters.`
          : null,
    area: hasArea ? null : "Circle what should change on the picture, or choose Whole frame.",
  };
}

/**
 * The form of one change request (SPEC section 11, Change requests), open while the user draws:
 * the frame, what is marked and what is under the mark, the text, Send and Cancel. The mark itself
 * is drawn by `FrameOverlay` on the picture.
 */
export function AskForm({ videoId, timeline }: { videoId: string; timeline: Timeline }) {
  const store = useAppStoreApi();
  const { platform } = usePlatform();
  const requests = useRequestsStore();
  const state = useRequests((s) => s);
  const formId = useId();
  const areaId = useId();
  const [showErrors, setShowErrors] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const clips = pictureClipsAt(timeline, state.frame);
  const about = effectiveAbout(state, timeline);
  const aboutClip = clips.find((clip) => clip.id === about) ?? null;
  const hasArea = state.shape !== null || state.wholeFrame || aboutClip !== null;
  const found = problems(state.text, hasArea);
  const size = length(state.text);

  const send = async () => {
    if (requests.getState().sending) return;
    if (found.text !== null || found.area !== null) {
      setShowErrors(true);
      return;
    }
    const actions = requests.getState();
    actions.setSending(true);
    try {
      const note = await store.getState().addTimelineNote(videoId, {
        frame: clampFrame(state.frame, lastFrame(timeline.duration)),
        shape: state.shape,
        elementId: about,
        prompt: state.text.trim(),
      });
      actions.sent(note.id);
    } catch (error) {
      // The server's sentence stays in the form; the text and the mark are kept.
      actions.setError(toApiError(error).message);
    }
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || !isShortcut(event.nativeEvent, platform, "Enter")) return;
    event.preventDefault();
    void send();
  };

  const lockedByJob = useLock(videoId, timeline) !== null;

  return (
    <form
      id={formId}
      aria-label="New change request"
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 rounded-lg border border-separator bg-subtle p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-fg">New change request</h3>
        <span className="text-sm text-fg-muted tabular" data-testid="ask-time">
          {timeCode(state.frame, timeline.fps)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <p
            id={areaId}
            className={cn("text-sm", showErrors && found.area ? "text-danger" : "text-fg-muted")}
            role={showErrors && found.area ? "alert" : undefined}
          >
            {showErrors && found.area
              ? found.area
              : state.shape !== null
                ? "The circle on the picture marks what should change."
                : state.wholeFrame
                  ? "The whole frame."
                  : "Drag on the picture to circle what should change, or click to mark a point."}
          </p>
          {state.shape !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                requests.getState().setShape(null);
              }}
            >
              Draw Again
            </Button>
          ) : state.wholeFrame ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                requests.setState({ wholeFrame: false });
              }}
            >
              Draw a Circle
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                requests.getState().chooseWholeFrame();
              }}
            >
              Whole Frame
            </Button>
          )}
        </div>
      </div>

      {clips.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-fg">What is it about?</legend>
          {clips.map((clip) => (
            <AboutOption
              key={clip.id}
              name={`about-${formId}`}
              label={clipName(clip)}
              checked={about === clip.id}
              onSelect={() => {
                requests.getState().setAbout(clip.id);
              }}
            />
          ))}
          <AboutOption
            name={`about-${formId}`}
            label="The whole picture"
            checked={about === null}
            onSelect={() => {
              requests.getState().setAbout(null);
            }}
          />
        </fieldset>
      )}

      {aboutClip !== null && isMotionGraphic(aboutClip) && (
        <p className="rounded-md bg-warning-soft px-2.5 py-1.5 text-sm text-fg">
          This is a motion graphic. Only this graphic is made again, with your request, and replaced
          in the timeline. Nothing else changes.
        </p>
      )}

      <Field
        label="What should change?"
        error={showErrors ? found.text : null}
        aside={size >= COUNT_FROM ? `${size} / ${MAX_TEXT}` : undefined}
      >
        {(id, describedBy) => (
          <Textarea
            id={id}
            ref={textRef}
            rows={4}
            value={state.text}
            invalid={showErrors && found.text !== null}
            aria-describedby={describedBy}
            placeholder="Describe the change in your own words."
            onChange={(event) => {
              requests.getState().setText(event.target.value);
            }}
            className="w-full"
          />
        )}
      </Field>

      {lockedByJob && (
        <p className="text-sm text-fg-muted">
          This video is being worked on right now. Your request is saved and sent as soon as the
          video is free.
        </p>
      )}
      {state.error !== null && (
        <p role="alert" className="rounded-md bg-danger-soft px-2.5 py-1.5 text-sm text-danger">
          {state.error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto flex items-center gap-1.5 text-xs text-fg-subtle" aria-hidden>
          <Kbd keys={["mod", "enter"]} />
          to send
        </span>
        <Button
          size="sm"
          disabled={state.sending}
          onClick={() => {
            requests.getState().cancel();
          }}
        >
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary" icon={<Send />} loading={state.sending}>
          Send
        </Button>
      </div>
    </form>
  );
}

function AboutOption({
  name,
  label,
  checked,
  onSelect,
}: {
  name: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-sm text-fg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent",
        checked ? "border-accent bg-accent-soft" : "border-separator hover:bg-muted",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="size-3.5 accent-[var(--color-accent)]"
      />
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {label}
      </span>
    </label>
  );
}
