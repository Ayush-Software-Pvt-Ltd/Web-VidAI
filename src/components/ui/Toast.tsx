import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import * as RadixToast from "@radix-ui/react-toast";
import { useSyncExternalStore, type ReactNode } from "react";
import { getToasts, subscribe, toast, type ToastTone } from "./toastStore";
import { cn } from "@/lib/cn";

const icons: Record<ToastTone, ReactNode> = {
  info: <Info className="text-accent" />,
  success: <CircleCheck className="text-success" />,
  error: <CircleAlert className="text-danger" />,
};

/** Renders the toasts; put once at the root of the app (done in `App.tsx`). */
export function Toaster() {
  const current = useSyncExternalStore(subscribe, getToasts, getToasts);
  return (
    <RadixToast.Provider swipeDirection="right">
      {current.map((item) => (
        <RadixToast.Root
          key={item.id}
          duration={item.durationMs}
          onOpenChange={(open) => {
            if (!open) toast.dismiss(item.id);
          }}
          className={cn(
            "flex w-[min(460px,calc(100vw/var(--page-zoom,1)_-_2rem))] animate-slide-up items-start gap-2.5 rounded-lg bg-elevated p-3 shadow-popover data-[swipe=end]:animate-fade-in [&_svg]:size-4 [&_svg]:shrink-0",
          )}
        >
          <span className="mt-px flex">{icons[item.tone]}</span>
          <div className="min-w-0 flex-1">
            <RadixToast.Title className="text-base font-medium text-pretty text-fg">
              {item.title}
            </RadixToast.Title>
            {item.description && (
              <RadixToast.Description className="mt-0.5 text-sm break-words text-fg-muted">
                {item.description}
              </RadixToast.Description>
            )}
            {item.action && (
              <RadixToast.Action altText={item.action.label} asChild>
                <button
                  type="button"
                  onClick={item.action.onClick}
                  className="focus-ring mt-1.5 rounded-sm text-sm font-medium text-accent-text hover:underline"
                >
                  {item.action.label}
                </button>
              </RadixToast.Action>
            )}
          </div>
          <RadixToast.Close
            aria-label="Dismiss"
            className="focus-ring -m-0.5 flex rounded-sm p-0.5 text-fg-subtle hover:bg-hover hover:text-fg [&_svg]:size-3.5"
          >
            <X />
          </RadixToast.Close>
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2 outline-none" />
    </RadixToast.Provider>
  );
}
