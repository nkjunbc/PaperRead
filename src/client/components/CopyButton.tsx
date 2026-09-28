import { useEffect, useState, type JSX } from 'react';
import { IconCheck, IconCopy } from './ChatIcons';

export interface CopyButtonProps {
  text: string;
  /** What is copied, for assistive technology ("답변 복사", "코드 복사"). */
  label: string;
  className?: string;
}

/** Copies `text` as written (markdown included) and says so for a moment. */
export function CopyButton({ text, label, className }: CopyButtonProps): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1_600);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <>
      <button type="button" className={`copy-button${state === 'copied' ? ' is-done' : ''}${className === undefined ? '' : ` ${className}`}`} aria-label={label} onClick={() => void copy()}>
        {state === 'copied' ? <IconCheck /> : <IconCopy />}
        <span aria-hidden="true">{state === 'copied' ? '복사됨' : state === 'failed' ? '복사 실패' : '복사'}</span>
      </button>
      <span className="sr-only" role="status">
        {state === 'copied' ? '복사했습니다' : state === 'failed' ? '복사하지 못했습니다' : ''}
      </span>
    </>
  );
}
