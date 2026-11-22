/**
 * The unsaved edits of one channel, as overrides on top of the saved channel. Only fields the
 * user touched are in the draft; a field counts as changed while its text differs from the
 * saved one, so typing a change and then undoing it by hand makes the channel clean again.
 * The channel's video type setting is kept as its value (`auto`, `long` or `short`).
 * The name, folder and owner are the admin's, so they are not in a draft.
 * `buildUpdate` makes the server's `ChannelUpdate`: a field that did not change is `null` (left
 * as it is), a changed profile is sent whole.
 */
import {
  CHANNEL_SLOTS,
  MAX_SLOT_NAME_CHARS,
  type Channel,
  type ChannelSlot,
  type ChannelUpdate,
  type ChannelVideoType,
  type VideoType,
} from "@/lib/types";
import { TYPE_LABEL } from "../text";

export type ProfileField = "prompt" | "style";
/** A slot's text (`long.prompt.2`) or, for slots 1 to 4, its name (`long.prompt.2.name`). */
export type SlotField =
  `${VideoType}.${ProfileField}.${number}` | `${VideoType}.${ProfileField}.${number}.name`;
export type DraftField = "videoType" | SlotField;
export type Draft = Partial<Record<DraftField, string>>;

const TYPES: readonly VideoType[] = ["long", "short"];
const PARTS: readonly ProfileField[] = ["prompt", "style"];

export const SLOT_INDEXES: readonly number[] = Array.from({ length: CHANNEL_SLOTS }, (_, i) => i);

export const SLOT_FIELDS: readonly SlotField[] = TYPES.flatMap((type) =>
  PARTS.flatMap((part) =>
    SLOT_INDEXES.flatMap((slot) => [
      slotField(type, part, slot),
      ...(slot > 0 ? [slotField(type, part, slot, true)] : []),
    ]),
  ),
);

export function slotField(
  type: VideoType,
  part: ProfileField,
  slot: number,
  name = false,
): SlotField {
  return name ? `${type}.${part}.${slot}.name` : `${type}.${part}.${slot}`;
}

function slotsOf(channel: Channel, type: VideoType, part: ProfileField): ChannelSlot[] {
  return part === "prompt" ? channel[type].prompts : channel[type].styles;
}

export function savedValue(channel: Channel, field: DraftField): string {
  if (field === "videoType") return channel.videoType;
  const [type, part, slot, name] = field.split(".") as [VideoType, ProfileField, string, string?];
  const saved = slotsOf(channel, type, part)[Number(slot)];
  return (name ? saved?.name : saved?.text) ?? "";
}

export function draftValue(channel: Channel, draft: Draft, field: DraftField): string {
  return draft[field] ?? savedValue(channel, field);
}

export function isFieldChanged(channel: Channel, draft: Draft, field: DraftField): boolean {
  const value = draft[field];
  if (value === undefined) return false;
  return field.endsWith(".name")
    ? value.trim() !== savedValue(channel, field)
    : value !== savedValue(channel, field);
}

/** Why a slot name cannot be saved (the same rule as the backend), or `null`. */
export function slotNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give it a name.";
  if (Array.from(trimmed).length > MAX_SLOT_NAME_CHARS) {
    return `Use at most ${MAX_SLOT_NAME_CHARS} characters.`;
  }
  return null;
}

export function changedFields(channel: Channel, draft: Draft): DraftField[] {
  return (["videoType", ...SLOT_FIELDS] as DraftField[]).filter((f) =>
    isFieldChanged(channel, draft, f),
  );
}

/** True while a changed slot name cannot be saved. */
export function hasInvalidSlotName(channel: Channel, draft: Draft): boolean {
  return SLOT_FIELDS.some(
    (f) =>
      f.endsWith(".name") &&
      isFieldChanged(channel, draft, f) &&
      slotNameProblem(draftValue(channel, draft, f)) !== null,
  );
}

export function isTypeChanged(channel: Channel, draft: Draft, type: VideoType): boolean {
  return SLOT_FIELDS.some((f) => f.startsWith(`${type}.`) && isFieldChanged(channel, draft, f));
}

/** The `updateChannel` update for the changes, or `null` when there is nothing to save. */
export function buildUpdate(channel: Channel, draft: Draft): ChannelUpdate | null {
  const update: ChannelUpdate = { videoType: null, long: null, short: null };
  if (isFieldChanged(channel, draft, "videoType")) {
    update.videoType = draftValue(channel, draft, "videoType") as ChannelVideoType;
  }
  for (const type of TYPES) {
    if (!isTypeChanged(channel, draft, type)) continue;
    const slots = (part: ProfileField) =>
      slotsOf(channel, type, part).map((saved, i) => ({
        name:
          i === 0 ? saved.name : draftValue(channel, draft, slotField(type, part, i, true)).trim(),
        text: draftValue(channel, draft, slotField(type, part, i)),
      }));
    update[type] = { prompts: slots("prompt"), styles: slots("style") };
  }
  const nothing = update.videoType === null && update.long === null && update.short === null;
  return nothing ? null : update;
}

/** After a save: drops the fields whose text is now saved, keeps what changed meanwhile. */
export function afterSave(draft: Draft, sent: Draft): Draft {
  const next: Draft = {};
  for (const [field, value] of Object.entries(draft) as [DraftField, string][]) {
    if (sent[field] !== value) next[field] = value;
  }
  return next;
}

/** "video type", "Long 16:9 prompt": the changed parts in plain words. */
export function describeFields(fields: DraftField[]): string[] {
  const parts = fields.map((field) => {
    if (field === "videoType") return "video type";
    const [type, part] = field.split(".") as [VideoType, ProfileField];
    return `${TYPE_LABEL[type]} ${part}`;
  });
  return [...new Set(parts)];
}
