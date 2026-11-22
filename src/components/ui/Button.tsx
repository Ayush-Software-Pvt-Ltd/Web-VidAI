import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { buttonBase, buttonSizes, buttonVariants } from "./buttonStyles";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the icon and blocks clicks; the width does not change. */
  loading?: boolean;
  /** Leading icon, for example `<Play />` from lucide-react. */
  icon?: ReactNode;
  /** Trailing icon, for example a chevron. */
  iconRight?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const busyStyles: Record<ButtonVariant, string> = {
  primary: "disabled:bg-accent disabled:text-accent-fg disabled:opacity-80 disabled:shadow-control",
  secondary: "disabled:bg-control disabled:text-fg disabled:opacity-80 disabled:shadow-control",
  ghost: "disabled:opacity-80",
  danger:
    "disabled:bg-danger-solid disabled:text-white disabled:opacity-80 disabled:shadow-control",
};

const spinnerSize: Record<ButtonSize, number> = { sm: 12, md: 14, lg: 14 };

/** The standard push button. Pass `type="submit"` explicitly inside forms. */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  className,
  children,
  disabled,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        buttonBase,
        buttonVariants[variant],
        buttonSizes[size],
        // Busy, not unavailable: a button keeps its own colour under the spinner.
        loading && busyStyles[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={spinnerSize[size]} /> : icon}
      {children}
      {iconRight}
    </button>
  );
}
