// Maps a database error from the SMSF entity-level functions and triggers (migrations 0289, 0290) to an HTTP status, a stable
// machine code and plain wording. The database is the authority for the itemised-OR-net-only rule; this layer only translates.
export interface SmsfApiError {
  status: number;
  errorCode?: string;
  message: string;
}

const CODE_PREFIX = /^(ENTITY_[A-Z_]+):\s*/;

export function smsfRpcError(error: { message: string; code?: string | null }): SmsfApiError {
  const raw = error.message ?? 'Request failed';
  const m = raw.match(CODE_PREFIX);
  const message = raw.replace(CODE_PREFIX, '').replace(/^smsf:\s*/, '');
  if (m) return { status: 409, errorCode: m[1], message };
  switch (error.code) {
    case '42501':
      return { status: 403, message };
    case 'P0002':
      return { status: 404, message };
    case 'PGRST116':
      // no row visible to this household: the same answer as a row that does not exist (non-enumerating)
      return { status: 404, message: 'Not found' };
    case '55000':
    case '23505':
      return { status: 409, message };
    case '22023':
    case '23514':
      return { status: 422, message };
    default:
      return { status: 400, message };
  }
}
