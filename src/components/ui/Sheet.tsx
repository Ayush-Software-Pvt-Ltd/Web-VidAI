import * as RadixDialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";
import { quietFocusReturn } from "./focusReturn";
import { type DialogProps, PanelBody } from "./Dialog";

/**
 * A macOS-style modal sheet: slides down from the top of the window, below the title bar.
 * Used for Start Editing, Re-Edit and Render Final 4K. Same props as `Dialog`.
 */
export function Sheet({
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
  const widths = { sm: "w-[420px]", md: "w-[540px]", lg: "w-[700px]" };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-overlay" />
        <RadixDialog.Content
          onCloseAutoFocus={quietFocusReturn()}
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          className={cn(
            "fixed top-[52px] left-1/2 z-50 flex max-h-[calc(100vh/var(--page-zoom,1)_-_80px)] max-w-[calc(100vw/var(--page-zoom,1)_-_48px)] -translate-x-1/2 animate-slide-up flex-col overflow-hidden rounded-xl bg-elevated shadow-dialog outline-none",
            widths[size],
            className,
          )}
        >
          <PanelBody title={title} description={description} footer={footer}>
            {children}
          </PanelBody>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
