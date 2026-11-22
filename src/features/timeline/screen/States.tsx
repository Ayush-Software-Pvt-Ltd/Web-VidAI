import type { ReactNode } from "react";
import { ArrowLeft, FileQuestion, FilmIcon, TriangleAlert } from "lucide-react";
import { Button, EmptyState, Spinner } from "@/components/ui";
import type { ProjectViolation } from "@/lib/types";

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center bg-window px-6">{children}</div>;
}

export function LoadingState() {
  return (
    <Frame>
      <div role="status" className="flex items-center gap-2 text-base text-fg-muted">
        <Spinner size={16} />
        Opening the timeline
      </div>
    </Frame>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="secondary" icon={<ArrowLeft />} onClick={onBack}>
      Back to Library
    </Button>
  );
}

/** The video does not exist, is not the user's, or the server could not answer: its own sentence. */
export function UnavailableState({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack: () => void;
  onRetry?: () => void;
}) {
  return (
    <Frame>
      <EmptyState
        icon={<FileQuestion />}
        title="This timeline cannot be opened"
        description={message}
        action={
          <div className="flex gap-2">
            <BackButton onBack={onBack} />
            {onRetry && <Button onClick={onRetry}>Try Again</Button>}
          </div>
        }
      />
    </Frame>
  );
}

export function NoProjectState({ onBack }: { onBack: () => void }) {
  return (
    <Frame>
      <EmptyState
        icon={<FilmIcon />}
        title="There is no project to show yet"
        description="The timeline appears here once VidAI has edited this video."
        action={<BackButton onBack={onBack} />}
      />
    </Frame>
  );
}

/** The project cannot be read at all: the rules it breaks, in the server's words, nothing plays. */
export function UnreadableState({
  violations,
  onBack,
}: {
  violations: readonly ProjectViolation[];
  onBack: () => void;
}) {
  return (
    <Frame>
      <div className="flex max-w-[520px] flex-col items-center gap-4 text-center">
        <TriangleAlert className="size-7 text-warning" aria-hidden />
        <div>
          <h2 className="text-md font-semibold text-fg">This project cannot be opened</h2>
          <p className="mt-1 text-base text-fg-muted">
            VidAI cannot read the project of this video. Run Re-Edit to build it again.
          </p>
        </div>
        {violations.length > 0 && (
          <ul className="w-full list-disc space-y-1 pl-5 text-left text-sm text-fg-muted">
            {violations.map((violation, index) => (
              <li key={`${violation.rule}-${violation.elementId ?? ""}-${index}`}>
                {violation.message}
              </li>
            ))}
          </ul>
        )}
        <BackButton onBack={onBack} />
      </div>
    </Frame>
  );
}
