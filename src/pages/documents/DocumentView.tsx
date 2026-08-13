/**
 * Renders whichever document a snapshot describes.
 *
 * A small router rather than a conditional document: each template is a
 * separate component with its own layout, and this chooses between them. That
 * keeps the branching in one obvious place instead of scattered through three
 * documents' markup.
 */

import type { DocumentSnapshot } from '@/domain/document';
import { TaxInvoice } from '@/print/TaxInvoice';
import { RentalAgreement } from '@/print/RentalAgreement';
import { PaymentReceipt } from '@/print/PaymentReceipt';

export interface DocumentViewProps {
  readonly document: DocumentSnapshot;
  readonly logoUrl: string | null;
  readonly photoUrls: Readonly<Record<string, string>>;
  readonly voidReason?: string;
}

export function DocumentView({ document, logoUrl, photoUrls, voidReason = '' }: DocumentViewProps) {
  const props = { document, logoUrl, photoUrls, voidReason };

  switch (document.documentType) {
    case 'Rental Agreement':
      return <RentalAgreement {...props} />;
    case 'Payment Receipt':
      return <PaymentReceipt {...props} />;
    case 'Tax Invoice':
      return <TaxInvoice {...props} />;
  }
}
