/**
 * Settings, Channels: the user's channels (reorder) and the editor of the selected channel with
 * its draft, Save, Revert, Ctrl+S and the unsaved-changes guard. An admin adds, renames and removes
 * channels, so this page has no New Channel and no Remove.
 */
import { Tv } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState, ScrollArea, Spinner, toast } from "@/components/ui";
import { toApiError, type ApiError } from "@/lib/errors";
import { pluralize } from "@/lib/format";
import type { Channel, VideoType } from "@/lib/types";
import { useAppState, useAppStoreApi, usePlatform } from "@/lib/appEnv";
import { isShortcut } from "@/lib/platform";
import { selectChannels } from "@/lib/store";
import { useGuard, useRegisterGuard } from "../guardContext";
import { ChannelEditor } from "./ChannelEditor";
import { ChannelList } from "./ChannelList";
import {
  afterSave,
  buildUpdate,
  changedFields,
  describeFields,
  hasInvalidSlotName,
  type Draft,
} from "./draft";
import { moveItem } from "./reorder";

const SAVED_FLASH_MS = 2500;

/** The saved channels in a pending order (ids missing from the order keep their place at the end). */
function inOrder(channels: readonly Channel[], order: string[] | null): readonly Channel[] {
  if (!order) return channels;
  const byId = new Map(channels.map((c) => [c.id, c]));
  const ordered = order.map((id) => byId.get(id)).filter((c) => c !== undefined);
  return [...ordered, ...channels.filter((c) => !order.includes(c.id))];
}

export function ChannelsSection({
  initialChannelId = null,
  initialVideoType = null,
}: {
  /** Open with this channel selected (for example from the Start sheet's empty prompt warning). */
  initialChannelId?: string | null;
  /** Open on the Long 16:9 or Short 9:16 tab. */
  initialVideoType?: VideoType | null;
} = {}) {
  const store = useAppStoreApi();
  const { platform } = usePlatform();
  const { attempt, asking } = useGuard();
  const saved = useAppState(selectChannels);
  const loaded = useAppState((s) => s.workspace.data !== null);
  const loading = useAppState(
    (s) => s.workspace.status === "idle" || s.workspace.status === "loading",
  );

  const [order, setOrder] = useState<string[] | null>(null);
  const channels = inOrder(saved, order);
  const [selectedId, setSelectedId] = useState<string | null>(initialChannelId);
  const current = channels.find((c) => c.id === selectedId) ?? channels[0] ?? null;

  const [draft, setDraft] = useState<{ id: string | null; values: Draft }>({
    id: null,
    values: {},
  });
  const values = current && draft.id === current.id ? draft.values : {};
  const changed = current ? changedFields(current, values) : [];
  const dirty = changed.length > 0;

  const [type, setType] = useState<VideoType>(initialVideoType ?? "long");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => {
      setJustSaved(false);
    }, SAVED_FLASH_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [justSaved]);

  // ---- Draft, Save, Revert -------------------------------------------------------------------

  const discard = () => {
    setDraft({ id: null, values: {} });
    setSaveError(null);
  };

  const save = async (): Promise<boolean> => {
    if (!current) return true;
    const sent = values;
    // The editor shows which name is wrong.
    if (hasInvalidSlotName(current, sent)) return false;
    const update = buildUpdate(current, sent);
    if (!update) {
      discard();
      return true;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await store.getState().updateChannel(current.id, update);
      setDraft((d) => (d.id === current.id ? { id: d.id, values: afterSave(d.values, sent) } : d));
      setJustSaved(true);
      return true;
    } catch (error) {
      setSaveError(toApiError(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  useRegisterGuard({
    isDirty: () => dirty,
    save,
    discard,
    describe: () => ({ name: current?.name ?? "", changes: describeFields(changed) }),
  });

  // Ctrl+S (Cmd+S on a Mac) saves.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => {
      if (dirty && !saving && !asking) void save();
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isShortcut(event, platform, "s")) {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [platform]);

  const select = (id: string) => {
    if (id === current?.id) return;
    attempt(() => {
      setSelectedId(id);
      setSaveError(null);
      setJustSaved(false);
    });
  };

  // ---- Reorder ---------------------------------------------------------------------------------

  const move = (id: string, to: number) => {
    const ids = channels.map((c) => c.id);
    const next = moveItem(ids, ids.indexOf(id), to);
    setOrder(next);
    store
      .getState()
      .reorderChannels(next)
      .catch((error: unknown) => {
        toast.error("The new order was not saved", toApiError(error).message);
      })
      .finally(() => {
        setOrder((o) => (o === next ? null : o));
      });
  };

  // ---- Layout ----------------------------------------------------------------------------------

  if (!loaded && loading) {
    return (
      <div className="flex h-full items-center justify-center text-fg-subtle">
        <Spinner size={18} label="Loading channels" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="flex w-[264px] shrink-0 flex-col border-r border-separator bg-subtle/50">
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pt-3 pb-4">
          <h2 className="flex h-6 items-center px-2 text-xs font-medium text-fg-subtle">
            {saved.length > 0 ? pluralize(saved.length, "Channel") : "Channels"}
          </h2>
          {channels.length > 0 && (
            <ChannelList
              channels={channels}
              selectedId={current?.id ?? null}
              dirtyId={dirty && current ? current.id : null}
              onSelect={select}
              onMove={move}
            />
          )}
        </ScrollArea>
      </div>

      <div className="min-w-0 flex-1">
        {current ? (
          <ChannelEditor
            key={current.id}
            channel={current}
            draft={values}
            onChange={(field, value) => {
              setDraft((d) => ({
                id: current.id,
                values: { ...(d.id === current.id ? d.values : {}), [field]: value },
              }));
              setSaveError(null);
              setJustSaved(false);
            }}
            type={type}
            onTypeChange={setType}
            saving={saving}
            saveError={saveError}
            justSaved={justSaved}
            onSave={() => void save()}
            onRevert={discard}
            otherChannels={saved.filter((c) => c.id !== current.id)}
          />
        ) : (
          <EmptyState
            className="h-full"
            icon={<Tv />}
            title="No channels yet"
            description="An admin adds channels for you."
          />
        )}
      </div>
    </div>
  );
}
