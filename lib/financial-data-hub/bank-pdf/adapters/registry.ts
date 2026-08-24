/**
 * FDH-5 — PDF adapter registry (spec section 26): the SAME parser-registry
 * architecture R7's CSV registry uses, extended for a second
 * `document_format` rather than a parallel structure — direct analogue of
 * `bank-csv/adapters/registry.ts`.
 */

import { AU_PDF_ADAPTERS } from './auAdapters';
import { IN_PDF_ADAPTERS } from './inAdapters';
import type { PdfBankAdapter } from './types';

export const PDF_BANK_ADAPTER_REGISTRY: PdfBankAdapter[] = [...AU_PDF_ADAPTERS, ...IN_PDF_ADAPTERS];

export function getPdfAdapterById(id: string): PdfBankAdapter | null {
  return PDF_BANK_ADAPTER_REGISTRY.find((a) => a.id === id) ?? null;
}
