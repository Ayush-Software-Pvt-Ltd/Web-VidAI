import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { returnFocus } from "./focusReturn";
import { fieldBase } from "./Input";

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Second line in the menu (not shown in the trigger). */
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  /** Accessible name when there is no visible <label>. */
  "aria-label"?: string;
  /** The id of a hint or refusal under the control, linked to it for assistive technology. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  id?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Leading icon in the trigger. */
  icon?: ReactNode;
  className?: string;
  /** Extra classes of the shown value (for example to take it out of the layout in a narrow bar). */
  valueClassName?: string;
  /** Extra items under the options, for example a "Refresh" item. */
  footer?: ReactNode;
}

/** A popup select (macOS pop-up button). Values must be non-empty strings. */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  size = "md",
  disabled,
  icon,
  className,
  valueClassName,
  footer,
  id,
  ...aria
}: SelectProps<V>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <RadixSelect.Root
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        ref={triggerRef}
        id={id}
        aria-label={aria["aria-label"]}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"] || undefined}
        className={cn(
          fieldBase,
          "inline-flex w-auto min-w-[120px] items-center gap-1.5 bg-control text-left shadow-control hover:bg-control-hover data-[placeholder]:text-fg-subtle [&_svg]:shrink-0",
          size === "sm"
            ? "h-6 pr-1.5 pl-2 text-sm [&_svg]:size-3.5"
            : "h-7 pr-2 pl-2.5 text-base [&_svg]:size-4",
          className,
        )}
      >
        {icon && <span className="flex text-fg-muted">{icon}</span>}
        <span className={cn("min-w-0 flex-1 truncate", valueClassName)}>
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="flex text-fg-subtle">
          <ChevronDown />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          onCloseAutoFocus={(event) => {
            // Instead of Radix: no focus ring and no tooltip after a mouse choice.
            event.preventDefault();
            if (triggerRef.current) returnFocus(triggerRef.current);
          }}
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] animate-pop-in overflow-hidden rounded-lg bg-elevated p-1 shadow-popover"
        >
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex cursor-default flex-col rounded-md py-1 pr-2 pl-7 text-base text-fg outline-none select-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg [&[data-highlighted]_.select-description]:text-accent-fg/80"
              >
                <RadixSelect.ItemIndicator className="absolute top-[7px] left-2 flex [&_svg]:size-3.5">
                  <Check />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                {option.description && (
                  <span className="select-description text-sm text-fg-muted">
                    {option.description}
                  </span>
                )}
              </RadixSelect.Item>
            ))}
            {footer && (
              <>
                <RadixSelect.Separator className="mx-1 my-1 h-px bg-separator" />
                {footer}
              </>
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
