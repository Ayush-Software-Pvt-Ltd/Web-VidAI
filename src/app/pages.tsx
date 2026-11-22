/**
 * The pages with their own feature folders: Admin, Timeline and Disk Cleanup. The shell imports
 * them from here only. Each is a lazy import, loaded when it is first opened, and they share one
 * fallback (a spinner that only appears when loading is slow). The file exports components only.
 */
import { lazy, Suspense } from "react";
import { LoadingScreen } from "./LoadingScreen";

/** What `TimelineView` receives: the video whose timeline is open (SPEC section 11). */
export interface TimelineViewProps {
  videoId: string;
}

const LazyAdminView = lazy(() =>
  import("@/features/admin").then((m) => ({ default: m.AdminView })),
);
const LazyTimelineView = lazy(() =>
  import("@/features/timeline").then((m) => ({ default: m.TimelineView })),
);
const LazyDiskCleanupPage = lazy(() =>
  import("@/features/disk").then((m) => ({ default: m.DiskCleanupPage })),
);

function PageFallback() {
  return <LoadingScreen label="Loading" />;
}

/** The Admin area; it reads the open section from the store (`adminSection`) and has its own frame. */
export function AdminView() {
  return (
    <Suspense fallback={<PageFallback />}>
      <LazyAdminView />
    </Suspense>
  );
}

/** The timeline of one video. */
export function TimelineView({ videoId }: TimelineViewProps) {
  return (
    <Suspense fallback={<PageFallback />}>
      <LazyTimelineView videoId={videoId} />
    </Suspense>
  );
}

/** The Disk Cleanup page. */
export function DiskCleanupPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <LazyDiskCleanupPage />
    </Suspense>
  );
}
