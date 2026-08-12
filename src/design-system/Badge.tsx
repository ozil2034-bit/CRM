import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'gold';

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}

/*
 * Status marks are text-first: a soft tint and a colour, no border and no pill
 * outline. Reservation and dress statuses appear in dense lists, and a page of
 * outlined pills reads as clutter rather than information.
 */
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-sand-100 text-ink-700',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  gold: 'bg-gold-300/35 text-gold-700',
};

export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-xs px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
