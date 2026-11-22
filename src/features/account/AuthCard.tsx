import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The card of the pages that stand alone in the window: sign in, first setup and the notice that
 * the server cannot be reached. It sits in the middle of the page on the window background.
 */
export function AuthCard({
  icon,
  tone = "accent",
  title,
  children,
  actions,
  footnote,
}: {
  icon: ReactNode;
  tone?: "accent" | "warning";
  title: string;
  children: ReactNode;
  /** Buttons at the bottom right; the default action last. */
  actions?: ReactNode;
  /**
   * Quiet text at the bottom left, next to the buttons. It never truncates: when it does not fit
   * next to the buttons it takes its own line above them.
   */
  footnote?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="w-[460px] max-w-full animate-pop-in rounded-xl bg-elevated shadow-dialog"
    >
      <div className="px-7 pt-7 pb-6">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5",
              tone === "accent"
                ? "bg-accent-soft text-accent-text"
                : "bg-warning-soft text-warning",
            )}
          >
            {icon}
          </div>
          <h1 id={titleId} className="min-w-0 text-lg font-semibold text-fg">
            {title}
          </h1>
        </div>
        <div className="mt-4 text-base text-pretty text-fg-muted">{children}</div>
      </div>
      {(actions || footnote) && (
        <div className="flex min-h-[56px] flex-wrap items-center gap-x-4 gap-y-2 rounded-b-xl border-t border-separator bg-subtle/60 px-7 py-3">
          <div className="grow text-sm text-fg-muted">{footnote}</div>
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
    </section>
  );
}

/** The page behind an `AuthCard`: the window background with the card centred and scrollable. */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-window px-6 py-6">
      {children}
    </main>
  );
}
