/**
 * Financial Data Hub — FDH-3 upload-session request validation.
 */

import { z } from 'zod';
import { FDH_ALLOWED_UPLOAD_MIME_TYPES, FDH_DOCUMENT_TYPES, FDH_SOURCE_TYPES } from '../constants/enums';
import { FDH_MAX_FILE_SIZE_BYTES } from '../domain/fileValidation';
import { fdhCountryCode, fdhCurrencyCode, fdhUuid } from './primitives';

/**
 * Creating an upload session. `document_type` is REQUIRED here (unlike the
 * underlying `fdh_statement_uploads.document_type`, which stays nullable for
 * a future auto-classification path) — spec section 36's upload screen asks
 * the user what they are uploading before the file is even chosen, and
 * FDH-3 implements no auto-classification.
 */
export const fdhCreateUploadSessionSchema = z
  .object({
    document_type: z.enum(FDH_DOCUMENT_TYPES),
    source_type: z.enum(FDH_SOURCE_TYPES).default('other'),
    institution_id: fdhUuid.nullish(),
    country_code: fdhCountryCode,
    currency_code: fdhCurrencyCode.nullish(),
    declared_mime_type: z.enum(FDH_ALLOWED_UPLOAD_MIME_TYPES),
    declared_file_size_bytes: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    const max = FDH_MAX_FILE_SIZE_BYTES[v.declared_mime_type];
    if (v.declared_file_size_bytes > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declared_file_size_bytes'],
        message: `file exceeds the ${Math.round(max / (1024 * 1024))}MB limit for ${v.declared_mime_type}`,
      });
    }
  });

export type FdhCreateUploadSessionInput = z.infer<typeof fdhCreateUploadSessionSchema>;
