/** Class names shared by Button and IconButton. */
import type { ButtonSize, ButtonVariant } from "./Button";

export const buttonBase =
  "focus-ring relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium select-none transition-[background-color,box-shadow,color] duration-100 disabled:opacity-45 [&_svg]:shrink-0";

export const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg shadow-control enabled:hover:bg-accent-hover enabled:active:bg-accent-active disabled:bg-muted disabled:text-fg-muted disabled:opacity-100 disabled:shadow-none",
  secondary:
    "bg-control text-fg shadow-control enabled:hover:bg-control-hover enabled:active:bg-control-active disabled:bg-muted disabled:text-fg-muted disabled:opacity-100 disabled:shadow-none",
  ghost: "text-fg enabled:hover:bg-hover enabled:active:bg-pressed",
  danger:
    "bg-danger-solid text-white shadow-control enabled:hover:bg-danger-hover enabled:active:bg-danger-active disabled:bg-muted disabled:text-fg-muted disabled:opacity-100 disabled:shadow-none",
};

export const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-sm [&_svg]:size-3.5",
  md: "h-7 px-3 text-base [&_svg]:size-4",
  lg: "h-8 px-4 text-md [&_svg]:size-4",
};
