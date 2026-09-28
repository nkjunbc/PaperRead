import type { AppError, ErrorCode } from '../../shared/contracts';
import { AppErrorException } from '../store/errors';

/** HTTP status for each contract error code (spec §4). */
const STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  NETWORK: 502,
  TOO_LARGE: 400,
  UNSUPPORTED_PDF: 400,
  SOURCE_CHANGED: 409,
  AUTH_REQUIRED: 401,
  SUBSCRIPTION_REQUIRED: 403,
  QUOTA: 429,
  MODEL_UNAVAILABLE: 503,
  BUSY: 409,
  INVALID_TRANSLATION: 502,
  STORAGE: 500,
  UNSAFE_RUNTIME: 403,
  INTERNAL: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

/** An HTTP status that must override the code's default (e.g. forgery → 403). */
export class HttpError extends Error {
  constructor(readonly status: number, readonly error: AppError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'HttpError';
  }
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, { code: 'INVALID_INPUT', message, retryable: false });
}

export function unsupportedMedia(message: string): HttpError {
  return new HttpError(415, { code: 'INVALID_INPUT', message, retryable: false });
}

/** Normalise anything thrown inside a handler into {status, AppError}. */
export function toHttp(cause: unknown): { status: number; error: AppError } {
  if (cause instanceof HttpError) return { status: cause.status, error: cause.error };
  if (cause instanceof AppErrorException) return { status: statusFor(cause.error.code), error: cause.error };
  const candidate = cause as Partial<AppError>;
  if (typeof candidate?.code === 'string' && candidate.code in STATUS) {
    const error: AppError = {
      code: candidate.code as ErrorCode,
      message: typeof candidate.message === 'string' ? candidate.message : String(candidate.code),
      retryable: candidate.retryable === true,
    };
    return { status: statusFor(error.code), error };
  }
  return {
    status: 500,
    // The raw cause text never reaches the client: it can carry paths or paper text.
    error: { code: 'INTERNAL', message: '로컬 서비스에서 처리할 수 없는 오류가 발생했습니다.', retryable: false },
  };
}
