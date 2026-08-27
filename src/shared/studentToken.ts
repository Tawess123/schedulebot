import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Scoped access tokens for the "edit my own timetable" page.
 *
 * A student must never hold `WEB_SECRET` — that is full admin. Instead the bot
 * hands out a link carrying a token that names one student and expires. The
 * token is HMAC-signed with `WEB_SECRET` rather than stored, so it survives a
 * restart, needs no database, and cannot be forged without the secret.
 */

/** Who a token grants access to. */
export interface StudentTokenClaims {
  /** Student name, the key everything else is looked up by. */
  student: string;
  /** School the student belonged to when the link was issued. */
  school: string;
}

interface TokenPayload extends StudentTokenClaims {
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** Seven days: long enough to keep a link handy, short enough to age out. */
export const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Issue a token granting timetable access to one student. */
export function signStudentToken(
  secret: string,
  claims: StudentTokenClaims,
  ttlSeconds: number = DEFAULT_TOKEN_TTL_SECONDS,
): string {
  const payload: TokenPayload = {
    student: claims.student,
    school: claims.school,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/**
 * Verify a token and return who it is for, or `null` for anything wrong —
 * malformed, tampered with, or expired. Callers must treat `null` as a refusal
 * and never fall back to a default identity.
 */
export function verifyStudentToken(
  secret: string,
  token: string,
): StudentTokenClaims | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(secret, body), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as TokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.student !== 'string' || !payload.student) return null;
  if (typeof payload.school !== 'string' || !payload.school) return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= Date.now()) return null;

  return { student: payload.student, school: payload.school };
}
