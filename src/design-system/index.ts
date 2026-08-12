/**
 * Design system barrel.
 *
 * Components import primitives from `@/design-system`, never from individual
 * files, so the surface stays deliberate and reviewable.
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Wordmark, type WordmarkProps } from './Wordmark';
