import { useEffect, useId, useState, type JSX } from 'react';
import type { Connection } from '../../shared/contracts';
import { preferredModelFallback } from '../lib/status';

export interface ModelPreferencesProps {
  connection: Connection;
  busy?: boolean;
  onSave(modelId: string | null): Promise<void>;
  onRefresh(): Promise<void>;
}

/** Account-menu settings. Changes affect the next translation/question, never saved work. */
export function ModelPreferences({ connection, busy = false, onSave, onRefresh }: ModelPreferencesProps): JSX.Element {
  const selectId = useId();
  const [draft, setDraft] = useState(connection.preferredModelId ?? '');
  const [action, setAction] = useState<'save' | 'refresh' | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => { setDraft(connection.preferredModelId ?? ''); }, [connection.preferredModelId]);
  const disabled = busy || action !== null;
  const unavailable = draft !== '' && !connection.modelIds.includes(draft);
  const changed = draft !== (connection.preferredModelId ?? '');
  const fallback = preferredModelFallback(connection);
  const checked = connection.modelsCheckedAt ? new Date(connection.modelsCheckedAt) : null;
  const checkedText = checked !== null && Number.isFinite(checked.getTime())
    ? checked.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

  async function run(next: 'save' | 'refresh'): Promise<void> {
    if (disabled) return;
    setAction(next);
    setFeedback(null);
    try {
      if (next === 'save') await onSave(draft || null);
      else await onRefresh();
      setFeedback({ text: next === 'save' ? '기본 모델을 저장했습니다.' : '공식 모델 목록을 다시 확인했습니다.', error: false });
    } catch {
      setFeedback({ text: next === 'save' ? '기본 모델을 저장하지 못했습니다. 다시 시도해 주세요.' : '모델 목록을 확인하지 못했습니다. 연결 상태를 확인해 주세요.', error: true });
    } finally { setAction(null); }
  }

  return <section className="model-preferences" aria-labelledby={`${selectId}-heading`}>
    <div className="model-preferences__heading">
      <h3 id={`${selectId}-heading`}>기본 모델</h3>
      <button type="button" onClick={() => { void run('refresh'); }} disabled={disabled}>
        {action === 'refresh' ? '확인 중…' : '목록 새로고침'}
      </button>
    </div>
    <label htmlFor={selectId}>새 번역과 질문에 사용할 모델</label>
    <div className="model-preferences__controls">
      <select id={selectId} value={draft} onChange={event => { setDraft(event.target.value); setFeedback(null); }} disabled={disabled || connection.status !== 'subscription'}>
        <option value="">자동 선택</option>
        {unavailable ? <option value={draft} disabled>{draft} · 현재 사용 불가</option> : null}
        {connection.modelIds.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
      <button type="button" onClick={() => { void run('save'); }} disabled={disabled || !changed || unavailable}>
        {action === 'save' ? '저장 중…' : '저장'}
      </button>
    </div>
    {fallback !== null ? <p className="model-preferences__notice" role="status">{fallback} 지금 쓰는 모델: {connection.defaultModelId}</p> : null}
    {connection.status === 'subscription' && connection.modelIds.length === 0 ? <p className="model-preferences__notice" role="status">현재 사용할 수 있는 모델이 없습니다.</p> : null}
    <p className="model-preferences__note">로그인할 때 공식 목록을 다시 확인합니다.</p>
    {checkedText ? <p className="model-preferences__checked">목록 확인 · <time dateTime={connection.modelsCheckedAt!}>{checkedText}</time></p> : null}
    {feedback ? <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'model-preferences__error' : 'model-preferences__feedback'}>{feedback.text}</p> : null}
  </section>;
}
