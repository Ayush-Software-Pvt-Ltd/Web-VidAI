import * as RadixTabs from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Tabs root: `<Tabs value onValueChange>` with `TabsList`, `TabsTrigger`, `TabsContent` inside. */
export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn("flex shrink-0 items-end gap-4 border-b border-separator", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        "focus-ring relative -mb-px inline-flex h-8 items-center gap-1.5 rounded-t-sm border-b-2 border-transparent px-0.5 text-base font-medium text-fg-muted transition-colors duration-100 hover:text-fg disabled:opacity-45 data-[state=active]:border-accent data-[state=active]:text-fg [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn("outline-none", className)} {...props} />;
}
