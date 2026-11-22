/**
 * The unsaved-changes guard of Settings. An editor with a draft registers itself; every way of
 * leaving it (another channel, another section, Done, Esc, the browser's Back) goes through
 * `attempt`, which asks Stay / Discard / Save first when the draft has changes.
 */
import { createContext, useContext, useEffect, useRef } from "react";

export interface Guardable {
  isDirty: () => boolean;
  /** Saves the draft; resolves to `false` when saving failed (the editor shows why). */
  save: () => Promise<boolean>;
  discard: () => void;
  /** What has changes, for the dialog: the channel name and the changed parts. */
  describe: () => { name: string; changes: string[] };
}

export interface GuardContextValue {
  register: (guardable: Guardable | null) => void;
  /**
   * Runs `action` now, or after the user saved or discarded the changes. `onStay` runs when the
   * user chooses Stay or closes the question instead (undo what already happened, if anything).
   */
  attempt: (action: () => void, onStay?: () => void) => void;
  /** Whether the registered editor has unsaved changes right now. */
  isDirty: () => boolean;
  /** True while the guard dialog is open. */
  asking: boolean;
}

export const GuardContext = createContext<GuardContextValue>({
  register: () => {},
  attempt: (action) => {
    action();
  },
  isDirty: () => false,
  asking: false,
});

export function useGuard(): GuardContextValue {
  return useContext(GuardContext);
}

/** Registers the current editor for as long as it is mounted. */
export function useRegisterGuard(guardable: Guardable): void {
  const { register } = useGuard();
  const ref = useRef(guardable);
  useEffect(() => {
    ref.current = guardable;
  });
  useEffect(() => {
    register({
      isDirty: () => ref.current.isDirty(),
      save: () => ref.current.save(),
      discard: () => {
        ref.current.discard();
      },
      describe: () => ref.current.describe(),
    });
    return () => {
      register(null);
    };
  }, [register]);
}
