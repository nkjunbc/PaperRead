import type { AppError, ErrorCode } from '../../shared/contracts';

/** An Error carrying a contract AppError. `message` is `CODE: text` so callers can match on the code. */
export class AppErrorException extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'AppErrorException';
    this.error = error;
  }
}

export function appError(code: ErrorCode, message: string, retryable = false): AppErrorException {
  return new AppErrorException({ code, message, retryable });
}

export function storageError(message: string, cause?: unknown): AppErrorException {
  const detail = cause instanceof Error ? `${message}: ${cause.message}` : message;
  return appError('STORAGE', detail, true);
}

export function invalidInput(message: string): AppErrorException {
  return appError('INVALID_INPUT', message, false);
}

export function notFound(message: string): AppErrorException {
  return appError('NOT_FOUND', message, false);
}

export function busy(message: string): AppErrorException {
  return appError('BUSY', message, true);
}
