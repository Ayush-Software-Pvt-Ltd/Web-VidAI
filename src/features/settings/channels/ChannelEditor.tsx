/**
 * The editor of one channel: its name and folder (shown; an admin sets both), its video type setting (Auto-detect, Always Long, Always Short), and per type
 * (Long 16:9, Short 9:16) a Prompt and a Style editor. Edits stay in a draft until Save (or
 * Ctrl+S); Revert drops them.
 */
import { Check, CircleAlert, Info } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import {
  Button,
  Input,
  Kbd,
  PathText,
  SegmentedControl,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ApiError } from "@/lib/errors";
import { CHANNEL_TYPE_LABELS, videoTypeLabel } from "@/lib/status";
import type { Channel, ChannelVideoType, VideoType } from "@/lib/types";
import { Callout } from "../layout";
import { characterCount, TYPE_LABEL } from "../text";
import { UNREACHABLE_TEXT } from "./ChannelList";
import {
  changedFields,
  describeFields,
  type Draft,
  type DraftField,
  draftValue,
  isFieldChanged,
  hasInvalidSlotName,
  isTypeChanged,
  type ProfileField,
  SLOT_INDEXES,
  slotField,
  slotNameProblem,
} from "./draft";
import { PromptTools } from "./PromptTools";

const TYPES: VideoType[] = ["long", "short"];
const DEFAULT_SLOT_NAME = "Default";
const PARTS: ProfileField[] = ["prompt", "style"];

const CHANNEL_TYPES: ChannelVideoType[] = ["auto", "long", "short"];
const CHANNEL_TYPE_OPTIONS = CHANNEL_TYPES.map((value) => ({
  value,
  label: CHANNEL_TYPE_LABELS[value],
}));

/** The hint under the video type control: what it is for, or what saving the change does. */
function channelTypeHint(value: ChannelVideoType, changed: boolean): string {
  if (!changed) {
    return "Use this when the camera records sideways and VidAI detects the wrong format.";
  }
  return value === "auto"
    ? "Saving goes back to detecting each video's type from its A-roll."
    : `Saving makes this channel's videos ${videoTypeLabel(value)}, except ones you set yourself.`;
}

export interface ChannelEditorProps {
  channel: Channel;
  draft: Draft;
  onChange: (field: DraftField, value: string) => void;
  type: VideoType;
  onTypeChange: (type: VideoType) => void;
  saving: boolean;
  saveError: ApiError | null;
  /** True for a moment after a successful save. */
  justSaved: boolean;
  onSave: () => void;
  onRevert: () => void;
  otherChannels: Channel[];
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

export function ChannelEditor({
  channel,
  draft,
  onChange,
  type,
  onTypeChange,
  saving,
  saveError,
  justSaved,
  onSave,
  onRevert,
  otherChannels,
}: ChannelEditorProps) {
  const changed = changedFields(channel, draft);
  const dirty = changed.length > 0;
  const canSave = dirty && !hasInvalidSlotName(channel, draft);
  // The slot shown in each editor ("long.prompt" to 0 to 4), local to the screen.
  const [shown, setShown] = useState<Partial<Record<`${VideoType}.${ProfileField}`, number>>>({});
  const channelType = draftValue(channel, draft, "videoType") as ChannelVideoType;
  const channelTypeChanged = isFieldChanged(channel, draft, "videoType");

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-col gap-1.5 px-5 pt-4 pb-3">
        <h2 dir="auto" className="min-w-0 truncate text-md leading-8 font-semibold text-fg">
          {channel.name}
        </h2>
        <div className="flex items-baseline gap-3 text-sm">
          <span className="w-[72px] shrink-0 font-medium text-fg">Folder</span>
          <PathText path={channel.dir} className="min-w-0 flex-1 break-words" />
        </div>
        <p className="-mt-0.5 pl-[84px] text-xs text-fg-muted">
          Its videos are the folders inside it. An admin sets the name and the folder of a channel.
        </p>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <div className="flex h-6 items-center gap-3">
            <span className="w-[72px] shrink-0 text-sm font-medium text-fg" aria-hidden>
              Video type
            </span>
            <SegmentedControl<ChannelVideoType>
              aria-label="Channel video type"
              value={channelType}
              options={CHANNEL_TYPE_OPTIONS}
              onValueChange={(value) => {
                onChange("videoType", value);
              }}
            />
            {channelTypeChanged && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-accent-text">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                Edited
              </span>
            )}
          </div>
          <p
            className={cn(
              "flex min-h-4 items-start gap-1.5 text-xs [&_svg]:mt-px [&_svg]:size-3 [&_svg]:shrink-0",
              channelTypeChanged ? "text-accent-text" : "text-fg-muted",
            )}
          >
            {channelTypeChanged ? <Info /> : null}
            <span className="min-w-0 break-words">
              {channelTypeHint(channelType, channelTypeChanged)}
            </span>
          </p>
        </div>
        {!channel.available && (
          <Callout tone="warning" className="mt-1.5" title="Folder cannot be reached">
            {UNREACHABLE_TEXT} Its videos show again when the folder is back.
          </Callout>
        )}
      </div>

      <Tabs
        value={type}
        onValueChange={(value) => {
          onTypeChange(value as VideoType);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-end gap-3 border-b border-separator px-5">
          <TabsList className="border-b-0" aria-label="Video type">
            {TYPES.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TYPE_LABEL[t]}
                {isTypeChanged(channel, draft, t) && (
                  <>
                    <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                    <span className="sr-only">, unsaved changes</span>
                  </>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex-1" />
          <div className="flex h-8 items-center">
            <PromptTools
              type={type}
              slot={shown[`${type}.prompt`] ?? 0}
              currentPrompt={draftValue(
                channel,
                draft,
                slotField(type, "prompt", shown[`${type}.prompt`] ?? 0),
              )}
              otherTypePrompt={draftValue(
                channel,
                draft,
                slotField(
                  type === "long" ? "short" : "long",
                  "prompt",
                  shown[`${type}.prompt`] ?? 0,
                ),
              )}
              otherChannels={otherChannels}
              onReplace={(prompt) => {
                onChange(slotField(type, "prompt", shown[`${type}.prompt`] ?? 0), prompt);
              }}
            />
          </div>
        </div>
        <p className="px-5 pt-2.5 text-sm text-fg-muted">
          <span className="font-medium text-fg">Prompt</span>: how Claude edits this channel.{" "}
          <span className="font-medium text-fg">Style</span>: how its videos look. VidAI adds the
          video&apos;s folder names, type, product links and the style to the prompt automatically.
        </p>
        {TYPES.map((t) => (
          <TabsContent
            key={t}
            value={t}
            forceMount
            className="grid min-h-0 flex-1 overflow-y-auto grid-rows-[minmax(120px,3fr)_minmax(84px,1fr)] gap-3 px-5 pt-3 pb-4 data-[state=inactive]:hidden"
          >
            {PARTS.map((part) => (
              <SlotEditor
                key={part}
                channel={channel}
                draft={draft}
                type={t}
                part={part}
                slot={shown[`${t}.${part}`] ?? 0}
                onSlotChange={(slot) => {
                  setShown((current) => ({ ...current, [`${t}.${part}`]: slot }));
                }}
                onChange={onChange}
              />
            ))}
          </TabsContent>
        ))}
      </Tabs>

      <div className="flex h-[52px] shrink-0 items-center gap-3 border-t border-separator bg-subtle/60 px-5">
        <SaveStatus saveError={saveError} changes={describeFields(changed)} justSaved={justSaved} />
        <Button disabled={!dirty || saving} onClick={onRevert}>
          Revert
        </Button>
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              Save <Kbd keys={["mod", "S"]} />
            </span>
          }
        >
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={onSave}>
            Save
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function SaveStatus({
  saveError,
  changes,
  justSaved,
}: {
  saveError: ApiError | null;
  changes: string[];
  justSaved: boolean;
}) {
  let content: ReactNode;
  if (saveError) {
    content = (
      <span role="alert" className="flex min-w-0 items-start gap-1.5 text-danger">
        <CircleAlert className="mt-px" />
        <span className="line-clamp-2 min-w-0 break-words">
          {saveError.code === "conflict" ? "Not saved. " : "Not saved: "}
          {saveError.message}
        </span>
      </span>
    );
  } else if (changes.length > 0) {
    content = (
      <span className="flex min-w-0 items-center gap-2 text-fg">
        <span className="size-2 shrink-0 rounded-full bg-accent" aria-hidden />
        <span className="truncate">Unsaved changes to the {joinList(changes)}</span>
      </span>
    );
  } else if (justSaved) {
    content = (
      <span className="flex items-center gap-1.5 text-success">
        <Check />
        Saved
      </span>
    );
  } else {
    content = <span className="text-fg-subtle">All changes saved</span>;
  }
  return (
    <div
      aria-live="polite"
      className="flex min-w-0 flex-1 items-center text-sm [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {content}
    </div>
  );
}

const SLOT_COPY = {
  prompt: {
    label: "Prompt",
    placeholder:
      "Write how Claude should edit this channel's videos, or use Prompt Tools to start from the default prompt.",
  },
  style: {
    label: "Style",
    placeholder: "Colours, fonts, lower thirds, music: how this channel's videos look. Optional.",
  },
} as const;

/** One of the five prompts or styles of a type: a slot picker, its name and its text. */
function SlotEditor({
  channel,
  draft,
  type,
  part,
  slot,
  onSlotChange,
  onChange,
}: {
  channel: Channel;
  draft: Draft;
  type: VideoType;
  part: ProfileField;
  slot: number;
  onSlotChange: (slot: number) => void;
  onChange: (field: DraftField, value: string) => void;
}) {
  const id = useId();
  const { label, placeholder } = SLOT_COPY[part];
  const fieldLabel = `${TYPE_LABEL[type]} ${part}`;
  const textField = slotField(type, part, slot);
  const nameField = slotField(type, part, slot, true);
  const value = draftValue(channel, draft, textField);
  const name = draftValue(channel, draft, nameField);
  const nameProblem =
    slot > 0 && isFieldChanged(channel, draft, nameField) ? slotNameProblem(name) : null;
  const options = SLOT_INDEXES.map((i) => {
    const slotName = draftValue(channel, draft, slotField(type, part, i, true)).trim() || "Unnamed";
    const edited =
      isFieldChanged(channel, draft, slotField(type, part, i)) ||
      (i > 0 && isFieldChanged(channel, draft, slotField(type, part, i, true)));
    const empty = draftValue(channel, draft, slotField(type, part, i)).trim() === "";
    return {
      value: String(i),
      label: `${slotName}${empty ? " (empty)" : ""}${edited ? " (edited)" : ""}`,
    };
  });
  const changed =
    isFieldChanged(channel, draft, textField) ||
    (slot > 0 && isFieldChanged(channel, draft, nameField));
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex h-6 min-w-0 items-center gap-2">
        <label htmlFor={id} className="w-14 shrink-0 text-sm font-medium text-fg">
          {label}
        </label>
        <Select
          size="sm"
          className="min-w-0 flex-1"
          aria-label={`${fieldLabel} slot`}
          value={String(slot)}
          options={options}
          onValueChange={(next) => {
            onSlotChange(Number(next));
          }}
        />
        <Input
          size="sm"
          aria-label={`${label} name, ${TYPE_LABEL[type]}`}
          value={slot === 0 ? DEFAULT_SLOT_NAME : name}
          disabled={slot === 0}
          invalid={nameProblem !== null || undefined}
          dir="auto"
          wrapperClassName="min-w-0 flex-1"
          onChange={(event) => {
            onChange(nameField, event.target.value);
          }}
        />
      </div>
      {/* Notes on one line under the pickers, so the header never wraps or overflows. */}
      <div className="flex h-4 min-w-0 items-center gap-2 whitespace-nowrap">
        {nameProblem && (
          <span role="alert" className="truncate text-xs text-danger">
            {nameProblem}
          </span>
        )}
        {changed && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-accent-text">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            Edited
          </span>
        )}
        {part === "prompt" && value.trim() === "" && (
          <span className="truncate text-xs text-warning">
            {slot === 0
              ? `Empty: ${TYPE_LABEL[type]} videos of this channel cannot use the Default prompt`
              : "Empty: not offered when starting an edit"}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-fg-subtle tabular">
          {characterCount(value)}
        </span>
      </div>
      <Textarea
        id={id}
        mono
        aria-label={fieldLabel}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(textField, event.target.value);
        }}
        className="min-h-[78px] flex-1 resize-none rounded-lg px-3 py-2.5 leading-[19px] [tab-size:4]"
      />
    </div>
  );
}
