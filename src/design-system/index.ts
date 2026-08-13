/**
 * Design system barrel.
 *
 * Components import primitives from `@/design-system`, never from individual
 * files, so the surface stays deliberate and reviewable.
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { buttonClasses } from './button-classes';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Wordmark, type WordmarkProps } from './Wordmark';
export { Field, type FieldProps } from './Field';
export { Alert, type AlertProps, type AlertTone } from './Alert';
export { Select, type SelectProps, type SelectOption } from './Select';
export { TextArea, type TextAreaProps } from './TextArea';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Toggle, type ToggleProps } from './Toggle';
