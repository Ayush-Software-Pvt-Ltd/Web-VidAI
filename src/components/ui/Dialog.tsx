import { X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { quietFocusReturn } from "./focusReturn";
import { IconButton } from "./IconButton";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One line under the title; also the accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned. Put the default action last. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Prevents closing by Esc and outside clicks, for example while saving. */
  dismissible?: boolean;
  className?: string;
}

const widths = { sm: "w-[400px]", md: "w-[520px]", lg: "w-[680px]" };

/** Shared chrome of Dialog and Sheet: header, scrolling body, footer. */
export function PanelBody({
  title,
  description,
  children,
  footer,
  onClose,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex items-start gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <RadixDialog.Title className="text-md font-semibold text-fg">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="mt-0.5 text-base text-fg-muted">
              {description}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
        </div>
        {onClose && (
          <IconButton
            label="Close"
            icon={<X />}
            size="sm"
            noTooltip
            onClick={onClose}
            className="-mt-0.5 -mr-1.5"
          />
        )}
      </div>
      {children !== undefined && (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
      )}
      {footer && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-separator bg-subtle/60 px-5 py-3">
          {footer}
        </div>
      )}
    </>
  );
}

/** A centered modal dialog. Esc and outside clicks close it unless `dismissible` is false. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  className,
}: DialogProps) {
  const block = (e: Event) => {
    if (!dismissible) e.preventDefault();
  };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-overlay" />
        <RadixDialog.Content
          onCloseAutoFocus={quietFocusReturn()}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh/var(--page-zoom,1)_-_64px)] max-w-[calc(100vw/var(--page-zoom,1)_-_48px)] -translate-x-1/2 -translate-y-1/2 animate-pop-in flex-col overflow-hidden rounded-xl bg-elevated shadow-dialog outline-none",
            widths[size],
            className,
          )}
        >
          <PanelBody
            title={title}
            description={description}
            footer={footer}
            onClose={dismissible ? () => onOpenChange(false) : undefined}
          >
            {children}
          </PanelBody>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
