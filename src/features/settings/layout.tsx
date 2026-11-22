/** Building blocks shared by the Settings sections and the Admin pages: page, group, row, callout. */
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useId, type ReactNode } from "react";
import { ScrollArea } from "@/components/ui";
import { cn } from "@/lib/cn";

/** A scrolling settings page with a centered, readable column. */
export function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full" viewportClassName="px-8">
      <div className="mx-auto flex max-w-[680px] flex-col gap-7 pt-6 pb-10">{children}</div>
    </ScrollArea>
  );
}

/** A titled group of rows in a rounded box, with an optional quiet note under the box. */
export function Group({
  title,
  description,
  aside,
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Controls at the right of the title, for example a Refresh button. */
  aside?: ReactNode;
  /** A quiet note under the box, inset like the title. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex min-h-7 items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <h2 id={id} className="text-md font-semibold text-fg">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      <div className="flex flex-col divide-y divide-separator rounded-lg border border-border-container bg-surface">
        {children}
      </div>
      {/* The same inset as the heading above the box. */}
      {footer && <div className="px-1 text-sm text-fg-muted">{footer}</div>}
    </section>
  );
}

/** One row of a group: a label with an optional description at the left, a control at the right. */
export function Row({
  label,
  description,
  control,
  children,
  labelFor,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  /** Content under the label row, full width (for example a callout). */
  children?: ReactNode;
  /** Id of the control, so the label is clickable and names it. */
  labelFor?: string;
  className?: string;
}) {
  const Label = labelFor ? "label" : "div";
  return (
    <div className={cn("flex flex-col gap-2.5 px-4 py-3", className)}>
      <div className="flex min-h-7 items-center gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={labelFor} className="block text-base font-medium text-fg">
            {label}
          </Label>
          {description && <div className="mt-0.5 text-sm text-fg-muted">{description}</div>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

export type CalloutTone = "info" | "success" | "warning" | "danger";

const calloutTones: Record<CalloutTone, { box: string; icon: ReactNode }> = {
  info: { box: "bg-info-soft [&_.callout-icon]:text-info", icon: <Info /> },
  success: { box: "bg-success-soft [&_.callout-icon]:text-success", icon: <CircleCheck /> },
  warning: { box: "bg-warning-soft [&_.callout-icon]:text-warning", icon: <TriangleAlert /> },
  danger: { box: "bg-danger-soft [&_.callout-icon]:text-danger", icon: <CircleAlert /> },
};

/** A tinted message box: a refused change, a result, a warning. */
export function Callout({
  tone,
  title,
  children,
  action,
  className,
  live = false,
}: {
  tone: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons at the right. */
  action?: ReactNode;
  className?: string;
  /** Announce it (errors and results that appear after an action). */
  live?: boolean;
}) {
  const style = calloutTones[tone];
  return (
    <div
      role={live ? (tone === "danger" ? "alert" : "status") : undefined}
      className={cn("flex items-start gap-2.5 rounded-md px-3 py-2.5", style.box, className)}
    >
      <span className="callout-icon mt-px flex shrink-0 [&_svg]:size-4">{style.icon}</span>
      <div className="min-w-0 flex-1 text-sm text-fg">
        {title && <div className="font-medium">{title}</div>}
        {children && (
          <div className={cn("break-words", title ? "mt-0.5 text-fg-muted" : undefined)}>
            {children}
          </div>
        )}
      </div>
      {action && <div className="-my-0.5 flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
