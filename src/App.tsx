import { lazy, Suspense } from "react";
import { Toaster, TooltipProvider } from "@/components/ui";
import { Shell } from "./app/Shell";

/** Dev-only primitives gallery, reachable with `?gallery=1` (never in a production build). */
const Gallery = lazy(() => import("./app/Gallery"));

function showGallery(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).has("gallery");
}

export function App() {
  return (
    <TooltipProvider>
      {showGallery() ? (
        <Suspense fallback={null}>
          <Gallery />
        </Suspense>
      ) : (
        <Shell />
      )}
      <Toaster />
    </TooltipProvider>
  );
}
