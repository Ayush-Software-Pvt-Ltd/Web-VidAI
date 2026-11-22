/**
 * The action buttons of a video (SPEC sections 8 and 16), shared by the library rows and the
 * activity panel so both use the same wording, icons and progress. Which buttons show comes only
 * from `video.actions` (the server decides); the actions that belong in a row's menu are left out
 * (`menuActionsOf`). The button whose command is in flight shows a spinner and the video's other
 * buttons are disabled until it settles, so nothing can be started twice by a double click.
 */
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { VideoView } from "@/lib/types";
import {
  ACTION_SPECS,
  actionLabel,
  buttonActionsOf,
  usePendingJobAction,
  useRunJobAction,
} from "./actions";

export interface JobActionButtonsProps {
  video: VideoView;
  /** Icon-only buttons (narrow list). */
  compact?: boolean;
  /** Give the main action the accent colour (the activity panel; rows stay calm). */
  emphasis?: boolean;
  /** `false` takes the buttons out of the tab order (rows that do not hold the list's tab stop). */
  tabbable?: boolean;
  className?: string;
}

export function JobActionButtons({
  video,
  compact = false,
  emphasis = false,
  tabbable = true,
  className,
}: JobActionButtonsProps) {
  const run = useRunJobAction();
  const pending = usePendingJobAction(video.id);
  const actions = buttonActionsOf(video);
  if (actions.length === 0) return null;
  const primary = emphasis
    ? (actions.find((a) => ACTION_SPECS[a].tone === "primary") ?? null)
    : null;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {actions.map((action) => {
        const common = {
          loading: pending === action,
          disabled: pending !== null && pending !== action,
          tabIndex: tabbable ? 0 : -1,
          onClick: () => {
            run(video, action);
          },
        };
        const spec = ACTION_SPECS[action];
        const label = actionLabel(video, action);
        const icon = <spec.icon />;
        const quiet = spec.tone === "quiet" && !emphasis;
        // In the activity panel Archive is a quiet icon at the end, so the main actions keep one row.
        const iconOnly = compact || (emphasis && action === "archive");
        return iconOnly ? (
          <IconButton
            key={action}
            className={compact ? undefined : "ml-auto"}
            label={label}
            icon={icon}
            variant={quiet ? "ghost" : "secondary"}
            size="sm"
            {...common}
          />
        ) : (
          <Button
            key={action}
            size="sm"
            variant={action === primary ? "primary" : quiet ? "ghost" : "secondary"}
            icon={icon}
            className={quiet ? "text-accent-text" : undefined}
            {...common}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
