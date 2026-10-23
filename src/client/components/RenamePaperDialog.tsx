import { useEffect, useId, useRef, useState, type JSX } from 'react';
import type { Paper } from '../../shared/contracts';
import { extractError } from '../lib/api';
import { paperTitle } from '../lib/paper';

export function RenamePaperDialog({ paper, onCancel, onSave }: {
  paper: Paper;
  onCancel(): void;
  onSave(displayTitle: string | null): Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState(paperTitle(paper));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  async function save(title: string | null): Promise<void> {
    if (saving) return;
    setSaving(true); setError(null);
    try { await onSave(title); }
    catch (cause) { setError(extractError(cause).message); }
    finally { setSaving(false); }
  }
  return <div className="dialog-scrim" role="presentation">
    <div className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} ref={dialogRef} tabIndex={-1}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) onCancel(); }
        if (event.key !== 'Tab') return;
        const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') ?? []);
        const first = elements[0]; const last = elements.at(-1);
        if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <h2 id={`${id}-title`}>제목 변경</h2>
      <p className="rename-dialog__original"><span>원래 제목</span>{paper.title?.trim() || paper.paperKey}</p>
      <form onSubmit={(event) => { event.preventDefault(); if (value.trim().length > 0) void save(value.trim()); }}>
        <label htmlFor={`${id}-input`}>보관함에 표시할 제목</label>
        <input ref={inputRef} id={`${id}-input`} value={value} maxLength={300} required disabled={saving}
          onChange={(event) => setValue(event.target.value)} aria-describedby={`${id}-hint`}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} />
        <p id={`${id}-hint`} className="rename-dialog__hint">PDF와 번역, 메모는 그대로 유지됩니다.</p>
        {error ? <p className="rename-dialog__error" role="alert">{error}</p> : null}
        <div className="rename-dialog__actions">
          <button type="button" onClick={() => void save(null)} disabled={saving || !paper.displayTitle}>원래 제목으로</button>
          <button type="button" onClick={onCancel} disabled={saving}>취소</button>
          <button type="submit" className="primary" disabled={saving || value.trim().length === 0}>{saving ? '저장 중…' : '저장'}</button>
        </div>
      </form>
    </div>
  </div>;
}
