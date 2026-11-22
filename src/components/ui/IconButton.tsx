import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import type { ButtonVariant } from "./Button";
import { buttonVariants } from "./buttonStyles";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  /** Hide the tooltip (the label stays the accessible name). */
  noTooltip?: boolean;
  /** Pressed state for toggle buttons. */
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

const sizes = {
  sm: "size-6 [&_svg]:size-3.5",
  md: "size-7 [&_svg]:size-4",
  lg: "size-8 [&_svg]:size-[18px]",
};

/** A square button with only an icon. Always has a label (aria-label and tooltip). */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  loading = false,
  noTooltip = false,
  pressed,
  className,
  disabled,
  type = "button",
  ref,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "focus-ring inline-flex shrink-0 items-center justify-center rounded-md text-fg-muted transition-[background-color,color] duration-100 disabled:opacity-45 enabled:hover:text-fg [&_svg]:shrink-0",
        buttonVariants[variant],
        variant === "ghost" && "shadow-none",
        pressed && "bg-pressed text-fg",
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 12 : 14} /> : icon}
    </button>
  );
  return noTooltip ? button : <Tooltip content={label}>{button}</Tooltip>;
}
