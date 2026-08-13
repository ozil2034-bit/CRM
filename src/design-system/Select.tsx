import { forwardRef, useId, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'id'
> {
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly error?: string | undefined;
  readonly hint?: string;
  readonly className?: string;
}

/** Matches Field's underline treatment so a form reads as one system. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, error, hint, className, ...rest },
  ref,
) {
  const id = useId();

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="label-caps">
        {label}
      </label>

      <select
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        className={cn(
          'h-11 w-full border-0 border-b bg-transparent px-0 pb-1 text-base text-ink-900',
          'focus:outline-none focus:ring-0',
          'transition-colors duration-[--duration-fast]',
          error ? 'border-danger' : 'border-ink-200 focus:border-gold-500',
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {hint && !error && <p className="text-xs text-ink-400">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});
