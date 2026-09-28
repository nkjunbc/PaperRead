import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { forbidden, unsupportedMedia } from './errors';

/** Header carrying the credential minted when the service started. */
export const TOKEN_HEADER = 'x-paperread-token';

/** Only the loopback host is a legitimate origin for this personal, local app. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostname(value: string): string | null {
  // Strip an optional port; keep bracketed IPv6 intact.
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value.trim());
  return match === null ? null : match[1].toLowerCase();
}

/** True when a Host header names the loopback interface. */
export function isLoopbackHost(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const host = hostname(value);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

/**
 * True when an Origin header names a loopback http(s) origin.
 *
 * Parsed with the URL parser rather than a prefix test, so
 * `http://127.0.0.1.evil.example` and `http://localhost.evil.example` do not
 * pass by string similarity.
 */
export function isLoopbackOrigin(value: string | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A tab opened before the service last started still holds the previous startup credential;
 * reloading the page hands it the current one. */
const STALE_CREDENTIAL = '요청 자격이 맞지 않아 거절했습니다. 이 화면을 연 뒤 서비스가 다시 시작되었다면 페이지를 새로 고친 뒤 다시 시도해 주세요.';

/**
 * Gate every state-changing request (spec R08).
 *
 * Three independent conditions must hold, because each blocks a different
 * forgery path from a page the user merely visited:
 *  1. `Host` names loopback — defeats DNS rebinding onto this port.
 *  2. `Origin`, when present, names loopback — defeats a cross-site fetch.
 *     A *missing* Origin is not accepted for state changes: browsers always
 *     send it for CORS-relevant requests, so its absence means the caller is
 *     not the app page.
 *  3. The request carries the credential minted at startup and handed only to
 *     the local client entry page — defeats a no-CORS form/`<img>` submission,
 *     which cannot set a custom header at all.
 *
 * JSON content type is required too, so a simple cross-site form post is
 * rejected before the body is ever read.
 */
export function assertLocalRequest(request: IncomingMessage, token: string, mutating: boolean): void {
  if (!isLoopbackHost(request.headers.host)) {
    throw forbidden('로컬 요청이 아닙니다. 이 서비스는 이 PC에서만 사용할 수 있습니다.');
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
    throw forbidden('외부 사이트에서 보낸 요청은 처리하지 않습니다.');
  }
  if (!mutating) return;

  if (typeof origin !== 'string' || !isLoopbackOrigin(origin)) {
    throw forbidden('로컬 화면에서 보낸 요청만 상태를 바꿀 수 있습니다.');
  }
  const provided = request.headers[TOKEN_HEADER];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string' || !constantTimeEquals(value, token)) {
    throw forbidden(STALE_CREDENTIAL);
  }
  const contentType = request.headers['content-type'];
  if (typeof contentType === 'string' && contentType.length > 0) {
    const media = contentType.split(';')[0].trim().toLowerCase();
    if (media !== 'application/json') {
      throw unsupportedMedia('상태 변경 요청은 application/json만 허용합니다.');
    }
  }
}

/**
 * Require only the startup credential — no Origin or JSON rule — for a read that
 * reveals per-session state (a login attempt in progress). Browsers omit Origin on a
 * same-origin GET, so the full state-change gate cannot apply; the credential alone
 * still keeps a foreign page from polling the attempt.
 */
export function assertCredentialHeader(request: IncomingMessage, token: string): void {
  const provided = request.headers[TOKEN_HEADER];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string' || !constantTimeEquals(value, token)) {
    throw forbidden(STALE_CREDENTIAL);
  }
}
