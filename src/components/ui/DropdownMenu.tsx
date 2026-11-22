import { Check, ChevronRight } from "lucide-react";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { createContext, use, useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { returnFocus } from "./focusReturn";

/**
 * A menu opened from a button. Compose:
 * `<DropdownMenu><DropdownMenuTrigger asChild><IconButton .../></DropdownMenuTrigger>
 *   <DropdownMenuContent><DropdownMenuItem icon={...} onSelect={...}>Open</DropdownMenuItem>...`
 */
/** Whether the open menu is modal; decides where focus goes after a click outside. */
const ModalContext = createContext(true);

export function DropdownMenu({ modal = true, ...props }: ComponentProps<typeof RadixMenu.Root>) {
  return (
    <ModalContext value={modal}>
      <RadixMenu.Root modal={modal} {...props} />
    </ModalContext>
  );
}
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuGroup = RadixMenu.Group;
export const DropdownMenuRadioGroup = RadixMenu.RadioGroup;
export const DropdownMenuSub = RadixMenu.Sub;

const itemBase =
  "relative flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-base text-fg outline-none select-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg [&_svg]:size-4 [&_svg]:shrink-0";

const contentBase =
  "z-50 min-w-[200px] animate-pop-in overflow-hidden rounded-lg bg-elevated p-1 shadow-popover";

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "end",
  onCloseAutoFocus,
  onInteractOutside,
  ...props
}: ComponentProps<typeof RadixMenu.Content>) {
  const modal = use(ModalContext);
  // Like Radix: after a click outside a non-modal menu, focus stays where the user clicked.
  const leftByClickOutside = useRef(false);
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(contentBase, className)}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          const original = event.detail.originalEvent;
          const rightClick = original instanceof PointerEvent && original.button === 2;
          if (!modal || rightClick) leftByClickOutside.current = true;
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const outside = leftByClickOutside.current;
          leftByClickOutside.current = false;
          const content = event.currentTarget;
          const triggerId =
            content instanceof Element ? content.getAttribute("aria-labelledby") : null;
          const trigger = triggerId ? document.getElementById(triggerId) : null;
          if (event.defaultPrevented || !trigger) return;
          // Give focus back to the trigger here instead of in Radix, so that it shows no focus
          // ring and no tooltip after a mouse choice (see focusReturn.ts).
          event.preventDefault();
          if (!outside) returnFocus(trigger);
        }}
        {...props}
      />
    </RadixMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends ComponentProps<typeof RadixMenu.Item> {
  icon?: ReactNode;
  /** Shortcut hint at the right, for example "⌘O". */
  shortcut?: string;
  destructive?: boolean;
}

export function DropdownMenuItem({
  icon,
  shortcut,
  destructive,
  className,
  children,
  ...props
}: DropdownMenuItemProps) {
  return (
    <RadixMenu.Item
      className={cn(
        itemBase,
        destructive &&
          "text-danger data-[highlighted]:bg-danger-solid data-[highlighted]:text-white",
        className,
      )}
      {...props}
    >
      {icon && <span className="flex w-4 justify-center opacity-80">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="ml-4 text-sm opacity-60">{shortcut}</span>}
    </RadixMenu.Item>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixMenu.RadioItem>) {
  return (
    <RadixMenu.RadioItem className={cn(itemBase, "pl-7", className)} {...props}>
      <RadixMenu.ItemIndicator className="absolute left-2 flex">
        <Check />
      </RadixMenu.ItemIndicator>
      {children}
    </RadixMenu.RadioItem>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixMenu.CheckboxItem>) {
  return (
    <RadixMenu.CheckboxItem className={cn(itemBase, "pl-7", className)} {...props}>
      <RadixMenu.ItemIndicator className="absolute left-2 flex">
        <Check />
      </RadixMenu.ItemIndicator>
      {children}
    </RadixMenu.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof RadixMenu.Label>) {
  return (
    <RadixMenu.Label
      className={cn("px-2 pt-1.5 pb-1 text-xs font-medium text-fg-subtle", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof RadixMenu.Separator>) {
  return (
    <RadixMenu.Separator className={cn("mx-1 my-1 h-px bg-separator", className)} {...props} />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixMenu.SubTrigger>) {
  return (
    <RadixMenu.SubTrigger
      className={cn(itemBase, "data-[state=open]:bg-hover", className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight className="opacity-60" />
    </RadixMenu.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof RadixMenu.SubContent>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.SubContent sideOffset={2} className={cn(contentBase, className)} {...props} />
    </RadixMenu.Portal>
  );
}
