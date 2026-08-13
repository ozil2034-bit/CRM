import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

export interface TextAreaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className' | 'id'
> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly className?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, className, rows = 4, ...rest },
  ref,
) {
  const id = useId();

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="label-caps">
        {label}
      </label>

      <textarea
        ref={ref}
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(
          'w-full resize-y border-0 border-b bg-transparent px-0 pb-1 text-base text-ink-900',
          'placeholder:text-ink-300 focus:outline-none focus:ring-0',
          error ? 'border-danger' : 'border-ink-200 focus:border-gold-500',
        )}
        {...rest}
      />

      {hint && !error && <p className="text-xs text-ink-400">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});
