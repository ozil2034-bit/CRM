import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export interface FieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'id'
> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly className?: string;
  readonly trailing?: ReactNode;
}

/**
 * A labelled text input.
 *
 * The underline treatment rather than a boxed border is deliberate: the
 * specification asks for restraint with borders and rounded boxes, and a column
 * of outlined boxes is the visual signature of a generic admin form. Gold marks
 * focus; charcoal carries the value.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className, trailing, ...rest },
  ref,
) {
  const id = useId();
  const describedBy: string[] = [];
  if (hint) describedBy.push(`${id}-hint`);
  if (error) describedBy.push(`${id}-error`);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="label-caps">
        {label}
      </label>

      <div className="relative">
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy.length > 0 ? describedBy.join(' ') : undefined}
          className={cn(
            'h-11 w-full border-0 border-b bg-transparent px-0 pb-1 text-base text-ink-900',
            'placeholder:text-ink-300',
            'focus:outline-none focus:ring-0',
            'transition-colors duration-[--duration-fast]',
            error ? 'border-danger focus:border-danger' : 'border-ink-200 focus:border-gold-500',
            trailing ? 'pe-10' : undefined,
          )}
          {...rest}
        />
        {trailing && <span className="absolute inset-y-0 end-0 flex items-center">{trailing}</span>}
      </div>

      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-ink-400">
          {hint}
        </p>
      )}

      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
