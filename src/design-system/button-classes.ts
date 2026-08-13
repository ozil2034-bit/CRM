import { cn } from '@/lib/utils/cn';
import type { ButtonSize, ButtonVariant } from './Button';

/*
 * Charcoal carries primary actions; gold appears only as a hairline on the
 * secondary variant. Corners are barely rounded and shadows are absent — the
 * specification asks for restraint with cards, borders, rounded boxes and
 * shadows, so weight comes from typography and space instead.
 */
export const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-ink-900 text-white hover:bg-ink-800 active:bg-ink-900 disabled:bg-ink-300 disabled:text-white',
  secondary:
    'bg-white text-ink-900 ring-1 ring-inset ring-ink-200 hover:ring-gold-400 hover:bg-sand-50 disabled:text-ink-300 disabled:ring-ink-100 disabled:bg-white',
  ghost:
    'bg-transparent text-ink-700 hover:bg-sand-100 hover:text-ink-900 disabled:text-ink-300 disabled:bg-transparent',
  danger:
    'bg-danger text-white hover:brightness-110 active:brightness-95 disabled:bg-ink-300 disabled:text-white',
};

export const SIZE_CLASSES: Record<ButtonSize, string> = {
  // Heights meet the 44px touch-target floor from size `md` upward (§45).
  sm: 'h-9 px-3 text-xs gap-1.5',
  md: 'h-11 px-5 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

/**
 * The button's visual classes, for elements that must not be `<button>`.
 *
 * A navigation control is an anchor: it should be openable in a new tab and
 * announced as a link. Nesting a `<Link>` inside a `<button>` is invalid HTML,
 * so links wear the style instead of borrowing the element.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return cn(
    'inline-flex items-center justify-center rounded-sm font-medium',
    'transition-colors duration-[--duration-fast] ease-[--ease-out]',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    extra,
  );
}
