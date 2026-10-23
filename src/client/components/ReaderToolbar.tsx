import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react';
import type { Block, Job, Paper, Translation } from '../../shared/contracts';
import { paperTitle } from '../lib/paper';
import { pauseReasonNote } from '../lib/status';
import { IconChat } from './ChatIcons';
import { TranslationActivity } from './TranslationActivity';

export interface ReplacementRequest {
  modelId: string;
  oldTranslationExists: boolean;
}

/** The toggle for the question panel docked beside the reader. */
export interface ChatToggle {
  open: boolean;
  /** The panel's element id, for aria-controls. */
  controls: string;
  onToggle(): void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

export interface ReaderToolbarProps {
  paper: Paper | null;
  job: Job | null;
  selectedModelId: string;
  modelIds: readonly string[];
  canTranslate: boolean;
  disabledReason: string | null;
  replacement: ReplacementRequest | null;
  /** Said under the model choice, e.g. that the saved default cannot be used. */
  modelNotice?: string | null;
  onModelChange(modelId: string): void;
  onStart(modelId: string): void;
  onPause(jobId: string): void;
  onResume(jobId: string): void;
  onRetry?(jobId: string): void;
  onRequestReplacement(): void;
  onConfirmReplacement(modelId: string): void;
  onCancelReplacement(): void;
  /** What pressing the primary button sends, in plain words; shown beside the controls. */
  hint?: string | null;
  /** Opens the delete confirmation. Delete never sits among the primary buttons. */
  onRequestDelete?: () => void;
  chat?: ChatToggle;
  blocks?: readonly Block[];
  translations?: readonly Translation[];
  onReadPage?(page: number): void;
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

function jobLabel(job: Job | null): string {
  if (job === null || job.state === 'idle') return '번역 대기';
  switch (job.state) {
    case 'running':
      return '번역 중';
    case 'paused':
      return '번역 일시정지';
    case 'failed':
      return '번역 실패';
    case 'completed':
      return '번역 저장됨';
    case 'completed_with_gaps':
      return '일부 번역 확인 필요';
  }
}

function primaryLabel(job: Job | null): string {
  if (job === null || job.state === 'idle') return '번역 시작';
  switch (job.state) {
    case 'paused':
    case 'failed':
      return '이어 번역';
    case 'running':
      return '일시정지';
    case 'completed':
    case 'completed_with_gaps':
      return '저장된 번역';
  }
}

function primaryAction(job: Job | null): 'start' | 'pause' | 'resume' | 'saved' {
  if (job === null || job.state === 'idle') return 'start';
  if (job.state === 'paused' || job.state === 'failed') return 'resume';
  if (job.state === 'running') return 'pause';
  return 'saved';
}

function replacementTitle(paper: Paper | null): string {
  return paper === null ? '이 논문' : paperTitle(paper);
}

interface ReplacementDialogProps {
  paper: Paper | null;
  replacement: ReplacementRequest;
  canTranslate: boolean;
  onConfirm(): void;
  onCancel(): void;
}

function ReplacementDialog({ paper, replacement, canTranslate, onConfirm, onCancel }: ReplacementDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusableElements(dialog)[0];
    (first ?? dialog).focus();
    return () => {
      if (previousFocusRef.current !== null && previousFocusRef.current.isConnected) previousFocusRef.current.focus();
      previousFocusRef.current = null;
    };
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const elements = focusableElements(dialog);
    if (elements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onCancel]);

  return (
    <div className="dialog-scrim" role="presentation">
      <div
        ref={dialogRef}
        className="replacement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <p className="eyebrow">새로 번역</p>
        <h2 id={titleId}>{replacementTitle(paper)} 새로 번역</h2>
        <div className="replacement-dialog__copy">
          {replacement.oldTranslationExists ? <p><strong>기존 번역은 영구적으로 삭제됩니다.</strong></p> : null}
          <p><strong>한국어 쪽에 남긴 하이라이트·메모·필기도 모두 삭제됩니다.</strong></p>
          <p>원본 PDF와 원본 쪽의 하이라이트·메모·필기는 그대로 남습니다.</p>
          <p>이 작업은 ChatGPT 구독 사용량을 사용합니다.</p>
          <p>선택한 모델: <strong>{replacement.modelId}</strong></p>
          <p>현재 번역 작업이 진행 중이어도 이 논문을 새로 번역할 수 있습니다.</p>
        </div>
        <div className="replacement-dialog__actions">
          <button type="button" className="primary" onClick={onConfirm} disabled={!canTranslate || replacement.modelId.trim().length === 0}>
            새로 번역 시작
          </button>
          <button type="button" onClick={onCancel}>취소</button>
        </div>
      </div>
    </div>
  );
}

export function ReaderToolbar({
  paper,
  job,
  selectedModelId,
  modelIds,
  canTranslate,
  disabledReason,
  replacement,
  modelNotice = null,
  onModelChange,
  onStart,
  onPause,
  onResume,
  onRetry,
  onRequestReplacement,
  onConfirmReplacement,
  onCancelReplacement,
  hint = null,
  onRequestDelete,
  chat,
  blocks = [],
  translations = [],
  onReadPage,
}: ReaderToolbarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const action = primaryAction(job);
  const hasPaper = paper !== null;
  const primaryDisabled = !hasPaper || (action !== 'pause' && !canTranslate) || (action === 'start' && selectedModelId.trim().length === 0);
  const statusText = jobLabel(job);
  const title = paper === null ? '논문을 선택해 주세요' : paperTitle(paper);
  // Both counts are pages that hold something to translate; a references-only page is not one.
  const progress = job === null ? null : `번역할 ${job.totalTranslatableBlocks}쪽 중 ${job.completedBlocks}쪽 완료`;
  const page = job?.currentPage === null || job?.currentPage === undefined ? null : `${job.currentPage}쪽`;

  const handlePrimary = () => {
    switch (action) {
      case 'start':
        onStart(selectedModelId);
        break;
      case 'pause':
        if (job !== null) onPause(job.jobId);
        break;
      case 'resume':
        if (job !== null) onResume(job.jobId);
        break;
      case 'saved':
        break;
    }
  };

  const statusDetails: ReactNode[] = [<span key="state">{statusText}</span>];
  // A pause the reader did not ask for says why, or "이어 번역" gives no clue what it continues.
  const pauseNote = job?.state === 'paused' ? pauseReasonNote(job.pauseReason) : null;
  if (pauseNote !== null) statusDetails.push(<span key="reason">{pauseNote}</span>);
  if (progress !== null) statusDetails.push(<span key="progress">{progress}</span>);
  if (page !== null && job?.state === 'running') statusDetails.push(<span key="page">{page} 처리 중</span>);

  return (
    <>
      <section className="reader-toolbar" aria-label="번역 도구">
        <div className="reader-toolbar__main">
        <div className="reader-toolbar__summary">
          <p className="eyebrow">현재 논문</p>
          <h2 title={title}>{title}</h2>
          <div className="translation-progress" aria-live="polite">
            {statusDetails}
            {job !== null ? <span className="model-chip">모델 {job.modelId}</span> : null}
          </div>
        </div>
        <div className="reader-toolbar__controls">
          {modelIds.length > 0 || action !== 'saved' ? <label className="model-picker">
            <span>번역 모델</span>
            <select value={selectedModelId} onChange={(event) => onModelChange(event.target.value)} disabled={modelIds.length === 0}>
              {modelIds.length === 0 ? <option value="">사용 가능한 모델 없음</option> : null}
              {modelIds.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
            </select>
          </label> : null}
          {modelNotice !== null ? <p className="model-notice" role="status">{modelNotice}</p> : null}
          <div className="reader-toolbar__actions">
            {action !== 'saved' ? <button
              type="button"
              className={action === 'start' ? 'primary' : undefined}
              onClick={handlePrimary}
              disabled={primaryDisabled}
              aria-describedby={!canTranslate && disabledReason !== null ? 'translation-disabled-reason' : undefined}
            >
              {primaryLabel(job)}
            </button> : null}
            {job?.state === 'completed_with_gaps' && onRetry ? <button type="button" className="primary" disabled={!canTranslate}
              title="완료된 번역은 유지하고 누락된 문단만 같은 모델로 다시 번역합니다. ChatGPT 구독 사용량을 사용합니다."
              onClick={() => onRetry(job.jobId)}>누락된 번역 다시 시도</button> : null}
            <button type="button" onClick={onRequestReplacement} disabled={!hasPaper || job === null || selectedModelId.trim().length === 0}>
              새로 번역
            </button>
            {onRequestDelete !== undefined ? (
              <span className="toolbar-menu">
                <button type="button" aria-label="논문 메뉴" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
                  ⋯
                </button>
                {menuOpen ? (
                  <div className="toolbar-menu__list" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="toolbar-menu__danger"
                      onClick={() => {
                        setMenuOpen(false);
                        onRequestDelete();
                      }}
                    >
                      저장한 자료 삭제
                    </button>
                  </div>
                ) : null}
              </span>
            ) : null}
          </div>
          {chat !== undefined ? (
            // Its own group, set off from the translation actions (whose ⋯ menu ends them): it
            // opens the panel that docks on this side.
            <div className="reader-toolbar__panel">
              <button
                ref={chat.buttonRef}
                type="button"
                className="chat-toggle"
                aria-expanded={chat.open}
                aria-controls={chat.controls}
                onClick={chat.onToggle}
              >
                <IconChat />
                질문하기
              </button>
            </div>
          ) : null}
        </div>
        </div>
        {job !== null && ['running', 'paused', 'failed', 'completed_with_gaps'].includes(job.state) && onReadPage ? <TranslationActivity job={job} blocks={blocks} translations={translations} onReadPage={onReadPage} /> : null}
        {(action !== 'saved' || job?.state === 'completed_with_gaps') && action !== 'pause' && (hint !== null || (!canTranslate && disabledReason !== null)) ? (
          <div className="reader-toolbar__meta">
            {!canTranslate && disabledReason !== null ? <p id="translation-disabled-reason" className="toolbar-disabled-reason" role="status">{disabledReason}</p> : null}
            {hint !== null && (canTranslate || disabledReason === null) ? <p className="toolbar-hint">{job?.state === 'completed_with_gaps' ? '다시 시도하면 누락된 문단만 같은 모델로 전송하며 ChatGPT 구독 사용량을 사용합니다.' : hint}</p> : null}
          </div>
        ) : null}
      </section>
      {replacement !== null ? (
        <ReplacementDialog
          paper={paper}
          replacement={replacement}
          canTranslate={canTranslate}
          onConfirm={() => onConfirmReplacement(replacement.modelId)}
          onCancel={onCancelReplacement}
        />
      ) : null}
    </>
  );
}

export { jobLabel, primaryAction, primaryLabel };
