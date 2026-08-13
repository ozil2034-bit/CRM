import { useId } from 'react';
import { cn } from '@/lib/utils/cn';

export interface ToggleProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * A checkbox with a 44px touch target.
 *
 * The visible mark is small; the label and its padding form the hit area, so it
 * remains comfortable on a tablet at the rail.
 */
export function Toggle({ label, checked, onChange, disabled, className }: ToggleProps) {
  const id = useId();

  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex min-h-11 cursor-pointer items-center gap-3 py-2 text-sm text-ink-700',
        disabled && 'cursor-not-allowed text-ink-300',
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 shrink-0 accent-[--color-gold-600]"
      />
      <span>{label}</span>
    </label>
  );
}
