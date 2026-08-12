import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export type AlertTone = 'error' | 'warning' | 'info' | 'success';

export interface AlertProps {
  readonly tone?: AlertTone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/*
 * A rule on the leading edge rather than a filled panel. Tinted boxes stacked
 * on a white canvas read as clutter; a coloured edge carries the same signal at
 * a fraction of the visual weight.
 */
const TONE_CLASSES: Record<AlertTone, { edge: string; text: string }> = {
  error: { edge: 'border-danger', text: 'text-danger' },
  warning: { edge: 'border-warning', text: 'text-warning' },
  info: { edge: 'border-info', text: 'text-info' },
  success: { edge: 'border-success', text: 'text-success' },
};

export function Alert({ tone = 'error', title, children, className }: AlertProps) {
  const classes = TONE_CLASSES[tone];

  return (
    <div
      // Errors are announced; the rest are polite so a status change does not
      // interrupt someone mid-form.
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('border-s-2 ps-4 py-1', classes.edge, className)}
    >
      {title && <p className={cn('text-sm font-medium', classes.text)}>{title}</p>}
      <div className={cn('text-sm', title ? 'mt-0.5 text-ink-600' : classes.text)}>{children}</div>
    </div>
  );
}
