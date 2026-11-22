/** The Stay / Discard / Save dialog of the unsaved-changes guard (see `guardContext.ts`). */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Dialog } from "@/components/ui";
import { type Guardable, GuardContext } from "./guardContext";

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

export function GuardProvider({ children }: { children: ReactNode }) {
  const guardable = useRef<Guardable | null>(null);
  const [pending, setPending] = useState<{
    action: () => void;
    onStay?: () => void;
    name: string;
    changes: string[];
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const register = useCallback((g: Guardable | null) => {
    guardable.current = g;
  }, []);

  const attempt = useCallback((action: () => void, onStay?: () => void) => {
    const g = guardable.current;
    if (g?.isDirty()) {
      setPending({ action, ...(onStay ? { onStay } : {}), ...g.describe() });
    } else {
      action();
    }
  }, []);

  const isDirty = useCallback(() => guardable.current?.isDirty() ?? false, []);

  const value = useMemo(
    () => ({ register, attempt, isDirty, asking: pending !== null }),
    [register, attempt, isDirty, pending],
  );

  function stay() {
    if (!pending) return;
    setPending(null);
    pending.onStay?.();
  }

  async function save() {
    if (!pending) return;
    setSaving(true);
    const ok = (await guardable.current?.save()) ?? true;
    setSaving(false);
    setPending(null);
    if (ok) pending.action();
    else pending.onStay?.();
  }

  function discard() {
    if (!pending) return;
    guardable.current?.discard();
    setPending(null);
    pending.action();
  }

  return (
    <GuardContext value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !saving) stay();
        }}
        dismissible={!saving}
        size="sm"
        title={pending ? `Save changes to “${pending.name}”?` : ""}
        description={
          pending && pending.changes.length > 0
            ? `You changed the ${joinList(pending.changes)}. They are lost unless you save them.`
            : "Your changes are lost unless you save them."
        }
        footer={
          <>
            <Button className="mr-auto" disabled={saving} onClick={discard}>
              Discard Changes
            </Button>
            <Button disabled={saving} onClick={stay}>
              Stay
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      />
    </GuardContext>
  );
}
