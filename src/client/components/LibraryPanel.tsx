import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
import type { Paper } from '../../shared/contracts';

export interface LibraryPanelProps {
  papers: readonly Paper[];
  selectedPaperKey: string | null;
  deleteConfirmation: string | null;
  onOpen(paperKey: string): void;
  onRequestDelete(paperKey: string): void;
  onCancelDelete(): void;
  onConfirmDelete(paperKey: string): void;
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

export function sortSavedPapers(papers: readonly Paper[]): Paper[] {
  return [...papers].sort((left, right) => {
    const rightTime = Date.parse(right.createdAt);
    const leftTime = Date.parse(left.createdAt);
    if (Number.isFinite(rightTime) && Number.isFinite(leftTime) && rightTime !== leftTime) return rightTime - leftTime;
    if (right.createdAt !== left.createdAt) return right.createdAt < left.createdAt ? -1 : 1;
    return left.paperKey.localeCompare(right.paperKey);
  });
}

function paperTitle(paper: Paper): string {
  return paper.title?.trim() || paper.paperKey;
}

/** The stored time as a date the reader can scan; the raw string when it is not a time. */
function formatStoredDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 저장`;
}

function paperStatus(paper: Paper): string {
  switch (paper.status) {
    case 'fetching':
      return '원본 가져오는 중';
    case 'extracting':
      return '본문 분석 중';
    case 'ready':
      return '읽을 수 있음';
    case 'partial':
      return '일부만 읽을 수 있음';
    case 'unsupported':
      return '읽을 수 없음';
    case 'failed':
      return '가져오기 실패';
  }
}

export interface DeleteDialogProps {
  paper: Paper | undefined;
  paperKey: string;
  onCancel(): void;
  onConfirm(): void;
}

export function DeleteDialog({ paper, paperKey, onCancel, onConfirm }: DeleteDialogProps): JSX.Element {
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
        className="delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <p className="eyebrow">자료 관리</p>
        <h2 id={titleId}>이 자료를 삭제하시겠습니까?</h2>
        <p>{paper === undefined ? paperKey : paperTitle(paper)}</p>
        <p className="delete-dialog__warning">저장된 PDF, 번역, 하이라이트, 메모가 PaperRead에서 삭제됩니다.</p>
        <div className="delete-dialog__actions">
          <button type="button" className="danger" onClick={onConfirm}>삭제 확인</button>
          <button type="button" onClick={onCancel}>취소</button>
        </div>
      </div>
    </div>
  );
}

export function LibraryPanel({
  papers,
  selectedPaperKey,
  deleteConfirmation,
  onOpen,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: LibraryPanelProps): JSX.Element {
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const sorted = sortSavedPapers(papers);
  const confirmationPaper = deleteConfirmation === null ? undefined : papers.find((paper) => paper.paperKey === deleteConfirmation);

  return (
    <>
      <section className="library-panel" aria-labelledby="library-panel-title">
        <div className="library-panel__header">
          <div>
            <p className="eyebrow">보관함</p>
            <h2 id="library-panel-title">저장한 논문</h2>
          </div>
          <span className="library-count">{papers.length}편</span>
        </div>
        {sorted.length === 0 ? (
          <p className="library-empty">아직 저장한 논문이 없습니다.</p>
        ) : (
          <ul className="library-list">
            {sorted.map((paper) => {
              const title = paperTitle(paper);
              const isSelected = selectedPaperKey === paper.paperKey;
              const menuOpen = menuKey === paper.paperKey;
              return (
                <li key={paper.paperKey} className={`library-card${isSelected ? ' is-selected' : ''}`}>
                  <button
                    type="button"
                    className="library-card__open"
                    onClick={() => onOpen(paper.paperKey)}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <span className="library-card__title">{title}</span>
                    <span className="library-card__meta">
                      {paper.arxivId}v{paper.version} · {paperStatus(paper)}
                      {paper.pageCount !== null ? ` · ${paper.pageCount}쪽` : ''}
                    </span>
                    <span className="library-card__date">{formatStoredDate(paper.createdAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="library-card__menu-button"
                    aria-label="자료 메뉴"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuKey(menuOpen ? null : paper.paperKey)}
                  >
                    …
                  </button>
                  {menuOpen ? (
                    <div className="library-card__menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuKey(null);
                          onRequestDelete(paper.paperKey);
                        }}
                      >
                        자료 삭제
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {deleteConfirmation !== null ? (
        <DeleteDialog
          paper={confirmationPaper}
          paperKey={deleteConfirmation}
          onCancel={onCancelDelete}
          onConfirm={() => onConfirmDelete(deleteConfirmation)}
        />
      ) : null}
    </>
  );
}

export { paperTitle, paperStatus };
