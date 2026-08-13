import type { BadgeTone } from '@/design-system';
import type { ReservationStatus } from '@/domain/availability';
import type { FittingStatus } from '@/services/fittings.service';

/**
 * Status colours for reservations and fittings.
 *
 * Kept out of the component files so several screens can share them without
 * any component module exporting a non-component, which breaks Fast Refresh.
 *
 * The three states that end a booking are deliberately not all the same tone:
 * `Closed` is a neutral, successful ending, while `Cancelled` and `No-Show`
 * are outcomes an employee may need to spot at a glance in a long list.
 */
export const RESERVATION_STATUS_TONE: Record<ReservationStatus, BadgeTone> = {
  Inquiry: 'neutral',
  Reserved: 'info',
  'Fitting Scheduled': 'info',
  Fitted: 'info',
  'Picked Up': 'success',
  Returned: 'warning',
  Cancelled: 'danger',
  'No-Show': 'danger',
  Closed: 'neutral',
};

export const FITTING_STATUS_TONE: Record<FittingStatus, BadgeTone> = {
  Scheduled: 'info',
  Confirmed: 'success',
  Completed: 'neutral',
  Cancelled: 'danger',
  'No-Show': 'danger',
};
