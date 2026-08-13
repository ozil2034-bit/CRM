import type { BadgeTone } from '@/design-system';
import type { DressStatus } from '@/domain/dress';

/**
 * Status colours.
 *
 * Kept out of the component files so both the gallery card and the table can
 * share it without either exporting a non-component (which breaks Fast Refresh).
 */
export const STATUS_TONE: Record<DressStatus, BadgeTone> = {
  Available: 'success',
  Reserved: 'info',
  'Out with Customer': 'info',
  'In Cleaning': 'warning',
  'In Alteration': 'warning',
  'Under Repair': 'warning',
  Retired: 'neutral',
};
