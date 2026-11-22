import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import type { Resource } from "@/lib/store";
import type { AdminSettings } from "@/lib/types";
import { useAction, useRegisterGuard, type Action } from "@/features/settings";
import { parseWhole, RANGES, type NumberKey, type RangedKey } from "./rules";

export interface SettingsDraft {
  settings: Resource<AdminSettings>;
  /** The text a field shows: what is being typed, else the saved value. */
  text: (key: NumberKey) => string;
  setText: (key: NumberKey, text: string) => void;
  /** A ranged field whose text is not a whole number in its range. */
  invalid: (key: NumberKey) => boolean;
  dirtyKeys: NumberKey[];
  dirty: boolean;
  /** Something typed is not a valid number: Save is not offered. */
  hasInvalid: boolean;
  save: Action<[]>;
  revert: () => void;
  reload: () => void;
}

/**
 * The editable numbers of one admin page as a draft over the settings in the store: a change
 * stays in the page until Save, the unsaved-changes guard of the Admin frame asks about it, and a
 * saved change replaces the store's settings with the server's answer (already clamped), so a field
 * shows what the server kept. Only the keys of `keys` are ever sent.
 */
export function useSettingsDraft(
  keys: readonly NumberKey[],
  describe: { name: string; label: (key: NumberKey) => string },
): SettingsDraft {
  const api = useApi();
  const store = useAppStoreApi();
  const settings = useAppState((s) => s.adminSettings);
  const saved = settings.data;
  const [drafts, setDrafts] = useState<Partial<Record<NumberKey, string>>>({});

  useEffect(() => {
    void store.getState().loadAdminSettings();
  }, [store]);

  const rangeOf = (key: NumberKey) => (key in RANGES ? RANGES[key as RangedKey] : null);

  const invalid = (key: NumberKey) => {
    const draft = drafts[key];
    const range = rangeOf(key);
    return draft !== undefined && range !== null && parseWhole(draft, range) === null;
  };

  const dirtyKeys = useMemo(
    () =>
      saved
        ? keys.filter((key) => {
            const draft = drafts[key];
            return draft !== undefined && draft.trim() !== String(saved[key]);
          })
        : [],
    [keys, drafts, saved],
  );
  const hasInvalid = dirtyKeys.some(invalid) || keys.some(invalid);

  const save = useAction(async () => {
    if (!saved || hasInvalid) throw new Error("Fix the highlighted fields first.");
    const patch: Partial<AdminSettings> = {};
    for (const key of dirtyKeys) patch[key] = Number(drafts[key]);
    const result = await api.adminUpdateSettings(patch);
    store.getState().setAdminSettings(result);
    setDrafts({});
  });

  const revert = useCallback(() => {
    setDrafts({});
    save.clearError();
    // `save.clearError` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.clearError]);

  useRegisterGuard({
    isDirty: () => dirtyKeys.length > 0,
    save: async () => !hasInvalid && (await save.run()),
    discard: revert,
    describe: () => ({ name: describe.name, changes: dirtyKeys.map(describe.label) }),
  });

  return {
    settings,
    text: (key) => drafts[key] ?? (saved ? String(saved[key]) : ""),
    setText: (key, text) => {
      setDrafts((current) => ({ ...current, [key]: text }));
    },
    invalid,
    dirtyKeys,
    dirty: dirtyKeys.length > 0,
    hasInvalid,
    save,
    revert,
    reload: () => void store.getState().loadAdminSettings(),
  };
}
