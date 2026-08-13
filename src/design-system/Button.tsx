import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { SIZE_CLASSES, VARIANT_CLASSES } from './button-classes';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /**
   * Renders a spinner and blocks interaction.
   *
   * Every mutation in this application must expose a loading state, and a
   * button that stays clickable while a write is in flight is how duplicate
   * payments get created (specification §54).
   */
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
  readonly leadingIcon?: ReactNode;
  readonly className?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leadingIcon,
    disabled,
    children,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading;

  return (
    <button
      ref={ref}
      // Defaults to "button": an unlabelled submit inside a form is a common
      // source of accidental double submission.
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-medium',
        'transition-colors duration-[--duration-fast] ease-[--ease-out]',
        'disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leadingIcon}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg
      className="size-4 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
