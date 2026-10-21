import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { refuseUnlessFinancialImportAllowed } from '@/lib/entitlements/financialDataImport';
import { replaceSourceDocumentFile } from '@/lib/services/investment-intelligence/sourceDocumentReplacement';

// Document2 (4) WP-B (F5/F6/F14, 20-10-2026) -- controlled replacement copy of a statement whose raw file was deleted.
//
// Statement files are temporary by design. This attaches a new copy to the SAME logical document (same row, same owner, same
// history) instead of refusing it as a duplicate or creating a second document. See sourceDocumentReplacement.ts for the
// full contract. Reprocessing the attached copy is the ordinary, already-idempotent `POST .../process` call (the screen
// makes both calls), so no duplicate holdings, transactions or net worth can result.
//
// WP-H (21-10-2026): before the file reference is switched, the copy is checked against what the old statement retained
// (provider, document type, period, folios, schemes, owner). Optional form fields:
//   password             the document password, used only to read the copy for that check (never stored or logged)
//   confirmDifferences   comma-separated codes of confirmable differences the person has seen and accepted; a rejection
//                        (a different statement) can never be confirmed
// Answers: 422 replacement_identity_conflict (different statement, with the plain-words reasons), 409
// replacement_needs_confirmation (the differences to show, then resend with confirmDifferences), 422
// password_required_for_check / wrong_password_for_check.
//
// Premium: attaching a file is new extraction work, gated exactly like the first upload. Refused before the body is read.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const importDenied = await refuseUnlessFinancialImportAllowed(user.id, 'ii.source_document.replacement');
  if (importDenied) return importDenied;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!form || !(file instanceof File)) return bad('Choose the statement file to attach.', 422, 'missing_file');
  const passwordField = form.get('password');
  const password = typeof passwordField === 'string' && passwordField.length > 0 ? passwordField : undefined;
  const confirmField = form.get('confirmDifferences');
  const confirmedDifferences = typeof confirmField === 'string' ? confirmField.split(',').map((c) => c.trim()).filter((c) => /^[a-z_]{1,60}$/.test(c)) : [];

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await replaceSourceDocumentFile({ userId: user.id, sourceDocumentId: id, filename: file.name, mimeType: file.type, bytes, password, confirmedDifferences });
  if (!result.ok) {
    return Response.json(
      {
        error: result.code,
        message: result.message,
        ...(result.existingDocumentId ? { existing_document_id: result.existingDocumentId } : {}),
        ...(result.identity ? { identity: result.identity } : {}),
      },
      { status: result.httpStatus },
    );
  }
  return ok({
    sourceDocumentId: result.sourceDocumentId,
    status: result.status,
    checksumChanged: result.checksumChanged,
    previousFilename: result.previousFilename,
    scanPending: result.scanPending,
    identity: result.identity,
  });
}
