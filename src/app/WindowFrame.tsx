/**
 * The page layout every screen uses: an optional sidebar column and a content column with a
 * 52 px top bar. VidAI runs in a browser tab, so there is no window chrome: nothing is kept for
 * window buttons and nothing drags a window.
 */
import { useRef, type ReactNode } from "react";
import { useTopBarTokens } from "@/app/topBar";

export const TOP_BAR_HEIGHT = 52;

export interface WindowFrameProps {
  /** Sidebar body. Omit for a full-width layout. */
  sidebar?: ReactNode;
  /** Pinned to the bottom of the sidebar. */
  sidebarFooter?: ReactNode;
  /**
   * Content of the top bar above the main column. Its content can adapt to a narrow bar with the
   * `topbar-max-<N>:` variants (`TOP_BAR_BREAKPOINTS`), for example `topbar-max-820:hidden`.
   */
  topBar?: ReactNode;
  /** Main column body. */
  children: ReactNode;
  /** A panel at the right of the main column, for example the activity panel. */
  inspector?: ReactNode;
}

export function WindowFrame({
  sidebar,
  sidebarFooter,
  topBar,
  children,
  inspector,
}: WindowFrameProps) {
  const topBarRef = useRef<HTMLElement>(null);
  const topBarTokens = useTopBarTokens(topBarRef);
  return (
    <div className="relative flex h-full min-h-0 bg-window">
      {sidebar !== undefined && (
        <aside className="flex w-[236px] shrink-0 flex-col max-[900px]:w-[212px] border-r border-separator bg-sidebar">
          <div className="min-h-0 flex-1 pt-2">{sidebar}</div>
          {sidebarFooter && (
            <div className="shrink-0 border-t border-separator p-2">{sidebarFooter}</div>
          )}
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header
          ref={topBarRef}
          data-topbar={topBarTokens}
          className="flex h-[52px] shrink-0 items-center gap-3 border-b border-separator px-4"
        >
          {topBar}
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">{children}</div>
          {inspector}
        </div>
      </main>
    </div>
  );
}
