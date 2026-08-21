/**
 * Financial Data Hub — original-filename sanitisation contract.
 *
 * A user-supplied filename is attacker-controlled input that later phases will
 * store and log. Path separators, traversal sequences and control characters
 * are REJECTED rather than stripped, so a caller cannot smuggle a path through
 * by double-encoding or by relying on a lossy cleaner.
 *
 * This value is purgeable (a filename frequently carries the account holder's
 * name) and is excluded from the admin operational-metadata allowlist in
 * `constants/adminBoundary.ts`.
 */

import { z } from 'zod';

const PATH_SEPARATOR = /[/\\]/;

/**
 * C0 controls and DEL. Written as a character-code predicate rather than a
 * regular expression so the control characters never appear literally in this
 * source file (where an editor or a diff tool could silently mangle them).
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const fdhSanitisedFilename = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !PATH_SEPARATOR.test(s), {
    message: 'filename must not contain a path separator',
  })
  .refine((s) => !containsControlCharacter(s), {
    message: 'filename must not contain control characters',
  })
  .refine((s) => !s.includes('..'), {
    message: 'filename must not contain a traversal sequence',
  });
