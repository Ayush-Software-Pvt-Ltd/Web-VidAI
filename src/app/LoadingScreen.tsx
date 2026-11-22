import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui";

/** An answer that comes sooner than this shows no spinner at all (no flash). */
const SPINNER_DELAY_MS = 250;

/** A calm centred spinner that only appears when the answer is slow. */
export function LoadingScreen({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, SPINNER_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="flex h-full items-center justify-center bg-window text-fg-subtle">
      {visible && <Spinner size={20} label={label} />}
    </div>
  );
}
