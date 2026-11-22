/**
 * The model picker of an API option (SPEC sections 7a and 9, Settings, Harness + API Keys): a
 * pop-up button that opens a searchable list of the models the option's service offers at its
 * address, fetched live (the list itself is `ModelListPopup`). It shows the loading and failed
 * states of that request, a model that is no longer offered, and a Refresh action. It is OpenCode
 * Go's model field; the other two options take a typed id (`ApiModelField`).
 */
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { returnFocus } from "@/components/ui/focusReturn";
import { fieldBase } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useAppState } from "@/lib/appEnv";
import type { ApiModel, ApiOption } from "@/lib/types";
import { ModelListPopup } from "./ModelListPopup";
import { roomBelow } from "./modelListPlacement";

export function ModelCombobox({
  option,
  value,
  onChange,
  disabled = false,
  id,
  className,
}: {
  /** The API option whose list this is. */
  option: ApiOption;
  /** The chosen model id, `null` when none is chosen. */
  value: string | null;
  onChange: (model: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const models = useAppState((s) => s.apiModels[option]);
  const loadModels = useAppState((s) => s.loadApiModels);
  const [open, setOpen] = useState(false);
  // The trigger's width when the list opened: the list is as wide (at least 300).
  const [triggerWidth, setTriggerWidth] = useState(0);
  // The height the list may take below the trigger, `null` when it may open above instead.
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const list = useMemo(() => models.data?.models ?? [], [models.data]);
  const fetched = models.data?.fetchedAt != null;
  const chosen = value === null ? null : (list.find((m) => m.id === value) ?? null);
  // Only a list fetched for this address can say that a model is gone.
  const gone = value !== null && fetched && chosen === null;

  // The first time the picker opens without a fetched list, it asks the service.
  useEffect(() => {
    if (open && !fetched && models.status !== "loading") void loadModels(option, true);
    // Only when it opens: a failed request is retried with Try Again, not in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (model: ApiModel) => {
    setOpen(false);
    if (model.id !== value) onChange(model.id);
  };

  const label = value === null ? "Choose a model" : chosen ? chosen.displayName : value;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next && triggerRef.current) {
            // Scrolls the field up first, so the list opens below it and covers nothing above.
            setMaxHeight(roomBelow(triggerRef.current));
            setTriggerWidth(triggerRef.current.getBoundingClientRect().width);
          }
        }}
      >
        <Popover.Trigger asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-invalid={gone || undefined}
            className={cn(
              fieldBase,
              "inline-flex h-7 min-w-0 items-center gap-2 pr-2 pl-2.5 text-left text-base data-[state=open]:border-accent [&_svg]:size-4 [&_svg]:shrink-0",
            )}
          >
            <span className={cn("min-w-0 flex-1 truncate", value === null && "text-fg-muted")}>
              {label}
            </span>
            {chosen && (
              <span className="max-w-[45%] min-w-0 shrink truncate font-mono text-sm text-fg-muted">
                {chosen.id}
              </span>
            )}
            <ChevronDown className="text-fg-subtle" />
          </button>
        </Popover.Trigger>
        <ModelListPopup
          models={models}
          value={value}
          width={triggerWidth}
          maxHeight={maxHeight}
          onChoose={choose}
          onRefresh={() => void loadModels(option, true)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (triggerRef.current) returnFocus(triggerRef.current);
          }}
        />
      </Popover.Root>
      {gone && (
        <p role="status" className="flex gap-1.5 text-sm text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The service no longer offers {value} at this address. Choose another model; edits on
            this option cannot start until you do.
          </span>
        </p>
      )}
    </div>
  );
}
