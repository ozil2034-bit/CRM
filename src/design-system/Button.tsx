import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

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

/*
 * Charcoal carries primary actions; gold appears only as a hairline on the
 * secondary variant. Corners are barely rounded and shadows are absent — the
 * specification asks for restraint with cards, borders, rounded boxes and
 * shadows, so weight comes from typography and space instead.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-ink-900 text-white hover:bg-ink-800 active:bg-ink-900 disabled:bg-ink-300 disabled:text-white',
  secondary:
    'bg-white text-ink-900 ring-1 ring-inset ring-ink-200 hover:ring-gold-400 hover:bg-sand-50 disabled:text-ink-300 disabled:ring-ink-100 disabled:bg-white',
  ghost:
    'bg-transparent text-ink-700 hover:bg-sand-100 hover:text-ink-900 disabled:text-ink-300 disabled:bg-transparent',
  danger:
    'bg-danger text-white hover:brightness-110 active:brightness-95 disabled:bg-ink-300 disabled:text-white',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  // Heights meet the 44px touch-target floor from size `md` upward (§45).
  sm: 'h-9 px-3 text-xs gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

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
