import { useCallback, useEffect, useId, useRef, type JSX, type RefObject } from 'react';
import type { AppError, Connection, LoginAttempt } from '../../shared/contracts';
import { subscriptionUsageLines } from '../lib/status';

export interface AccountPanelProps {
  connection: Connection;
  loginAttempt: LoginAttempt | null;
  loginUrl: string | null;
  error: AppError | null;
  busy?: boolean;
  onStartLogin(): void;
  onCancelLogin(loginId: string): void;
  onLogout(): void;
  /** Set false while the containing account popover is closed. */
  open?: boolean;
  /** Called by Escape after the panel has no pending login to cancel. */
  onClose?: () => void;
  /** Element that should regain focus when the panel closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.hidden);
}

function connectionMessage(status: Connection['status']): string {
  switch (status) {
    case 'missing':
      return 'Codex CLI를 찾을 수 없습니다. 공식 Codex CLI를 설치한 뒤 다시 확인해 주세요.';
    case 'signed_out':
      return 'Codex 구독에 로그인해야 번역을 시작할 수 있습니다.';
    case 'subscription':
      return 'Codex 구독에 연결되어 있습니다.';
    case 'api_key':
      return 'API 키 방식 연결이 감지되었습니다. PaperRead는 API 키를 수집하거나 사용하지 않습니다.';
    case 'unavailable':
      return 'Codex 연결을 지금 사용할 수 없습니다. 잠시 후 다시 확인해 주세요.';
  }
}

function attemptMessage(attempt: LoginAttempt): string {
  switch (attempt.status) {
    case 'pending':
      return 'Codex 로그인 진행 중';
    case 'completed':
      return '로그인 완료';
    case 'cancelled':
      return '로그인 취소';
    case 'expired':
      return '로그인 요청 만료';
    case 'failed':
      return '로그인 실패';
  }
}

function errorMessage(error: AppError): string {
  switch (error.code) {
    case 'AUTH_REQUIRED':
      return 'Codex 로그인 상태를 확인해 주세요.';
    case 'SUBSCRIPTION_REQUIRED':
      return '번역에는 Codex 구독이 필요합니다.';
    case 'QUOTA':
      return 'Codex 구독 한도를 초과했습니다. 한도가 다시 열릴 때까지 기다려 주세요.';
    case 'MODEL_UNAVAILABLE':
      return '선택한 모델을 지금 사용할 수 없습니다. 다른 모델을 선택해 주세요.';
    case 'NETWORK':
      return '로컬 서비스에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
    case 'UNSAFE_RUNTIME':
      return '안전하지 않은 번역 실행 환경이라 작업을 시작하지 않았습니다.';
    case 'BUSY':
      return '다른 번역 작업이 진행 중입니다.';
    case 'INVALID_INPUT':
      return '입력한 내용을 확인해 주세요.';
    case 'STORAGE':
      return 'PaperRead에 자료를 저장하지 못했습니다.';
    default:
      return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
}

function terminalAttemptTone(status: LoginAttempt['status']): 'success' | 'warning' | 'error' | 'info' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'cancelled' || status === 'expired') return 'warning';
  return 'info';
}

function connectionTone(status: Connection['status']): 'connected' | 'attention' {
  return status === 'subscription' ? 'connected' : 'attention';
}

export function AccountPanel({
  connection,
  loginAttempt,
  loginUrl,
  error,
  busy = false,
  onStartLogin,
  onCancelLogin,
  onLogout,
  open = true,
  onClose,
  returnFocusRef,
}: AccountPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const pending = loginAttempt?.status === 'pending';
  const canStartLogin = connection.status === 'missing' || connection.status === 'signed_out' || connection.status === 'unavailable';

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusableElements(panel)[0];
    (first ?? panel).focus();
    return () => {
      const returnTarget = returnFocusRef?.current ?? previousFocusRef.current;
      if (returnTarget !== null && returnTarget.isConnected) returnTarget.focus();
      previousFocusRef.current = null;
    };
  }, [open, returnFocusRef]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (pending && loginAttempt !== null && !busy) {
          onCancelLogin(loginAttempt.loginId);
        } else {
          onClose?.();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const elements = focusableElements(panel);
      if (elements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [busy, loginAttempt, onCancelLogin, onClose, pending],
  );

  const showLoginButton = !pending && canStartLogin;
  const showLogoutButton = connection.status === 'subscription' || connection.status === 'api_key';

  return (
    <section
      ref={panelRef}
      className="account-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      hidden={!open}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="account-panel__header">
        <div>
          <p className="eyebrow">계정</p>
          <h2 id={titleId}>PaperRead 연결</h2>
        </div>
        <span className={`connection-badge connection-badge--${connectionTone(connection.status)}`}>
          {connection.status === 'subscription' ? '구독 연결됨' : connection.status === 'signed_out' ? 'Codex 로그인 필요' : '확인 필요'}
        </span>
      </div>

      <p className="account-panel__connection">{connectionMessage(connection.status)}</p>
      {connection.status === 'subscription' && subscriptionUsageLines(connection.limits).length > 0 ? (
        <ul className="account-panel__usage" aria-label="구독 사용량">
          {subscriptionUsageLines(connection.limits).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {loginAttempt !== null ? (
        <div className={`account-panel__attempt account-panel__attempt--${terminalAttemptTone(loginAttempt.status)}`} role="status">
          <strong>{attemptMessage(loginAttempt)}</strong>
          {loginAttempt.status === 'pending' ? (
            <>
              <span>공식 Codex 로그인 페이지에서 인증을 마치면 이 화면으로 돌아옵니다.</span>
              {loginUrl !== null ? (
                <a href={loginUrl} target="_blank" rel="noopener noreferrer">
                  Codex 로그인 열기
                </a>
              ) : null}
              <button type="button" onClick={() => onCancelLogin(loginAttempt.loginId)} disabled={busy}>
                로그인 취소
              </button>
            </>
          ) : null}
          {loginAttempt.error !== null ? <span>{errorMessage(loginAttempt.error)}</span> : null}
        </div>
      ) : null}

      {error !== null ? (
        <p className="account-panel__error" role="alert">
          {errorMessage(error)}
          {error.retryable ? ' 다시 시도할 수 있습니다.' : ''}
        </p>
      ) : null}

      <div className="account-panel__actions">
        {showLoginButton ? (
          <button type="button" className="primary" onClick={onStartLogin} disabled={busy}>
            Codex로 로그인
          </button>
        ) : null}
        {showLogoutButton ? (
          <button type="button" onClick={onLogout} disabled={busy} aria-describedby={`${titleId}-logout-note`}>
            PaperRead에서만 로그아웃
          </button>
        ) : null}
      </div>
      {showLogoutButton ? (
        <p id={`${titleId}-logout-note`} className="account-panel__note">
          PaperRead의 연결 상태만 지웁니다. 다른 곳에서 사용하는 Codex 로그인은 유지됩니다.
        </p>
      ) : null}
    </section>
  );
}

export { connectionMessage, errorMessage };
