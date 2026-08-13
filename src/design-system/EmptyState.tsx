import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export interface EmptyStateProps {
  readonly title: string;
  readonly hint?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * What a screen shows when the boutique has not entered anything yet.
 *
 * Production starts empty and stays empty until real data is entered — no demo
 * records, no illustrative figures. So the empty state has to carry its weight:
 * it names what is missing and offers the action that fixes it.
 */
export function EmptyState({ title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-20 text-center', className)}>
      <span aria-hidden="true" className="rule-gold w-12" />
      <p className="display mt-6 text-xl text-ink-900">{title}</p>
      {hint && <p className="mt-2 max-w-sm text-sm text-ink-500">{hint}</p>}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}
