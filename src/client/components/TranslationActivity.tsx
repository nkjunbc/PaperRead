import { useEffect, useState } from 'react';
import type { Block, Job, Paper, Translation } from '../../shared/contracts';
import { isTranslated, selectTranslations } from '../../shared/translations';
import type { ApiClient } from '../lib/api';
import { paperTitle } from '../lib/paper';
import { pauseReasonNote } from '../lib/status';

/** Only complete results on the job's model make a page available to read; one made with an
 * older prompt still counts, and a later failed attempt does not take it back. */
export function translationPageStates(blocks: readonly Block[], translations: readonly Translation[], job: Job) {
  const results = selectTranslations(blocks, translations, job.modelId);
  const pages = new Map<number, Block[]>();
  for (const block of blocks) {
    if (!block.translatable) continue;
    const page = block.regions[0]?.page ?? 1;
    pages.set(page, [...(pages.get(page) ?? []), block]);
  }
  return [...pages].sort(([a], [b]) => a - b).map(([page, items]) => {
    const complete = items.every(b => isTranslated(b, results.get(b.blockId)));
    const failed = items.some(b => results.get(b.blockId)?.status === 'failed');
    const state = complete ? 'done' : job.state === 'running' && job.currentPage === page ? 'active' : failed ? 'failed' : 'waiting';
    const label = state === 'done' ? '번역 완료' : state === 'active' ? '처리 중' : state === 'failed' ? '확인 필요' : '번역 대기';
    return { page, state, label };
  });
}

export function TranslationActivity({ job, blocks, translations, onReadPage }: {
  job: Job; blocks: readonly Block[]; translations: readonly Translation[]; onReadPage(page: number): void;
}) {
  const pages = translationPageStates(blocks, translations, job);
  const firstReady = pages.find(p => p.state === 'done');
  const isRunning = job.state === 'running';
  const total = Math.max(1, job.totalTranslatableBlocks);
  return <div className="translation-activity">
    <div className="translation-activity__line">
      <progress aria-label="번역 완료 쪽" max={total} value={Math.min(total, job.completedBlocks)} />
      <p>{isRunning ? (firstReady ? '완료된 쪽부터 읽을 수 있습니다. 홈으로 이동해도 번역은 계속됩니다.' : '첫 번역을 준비하고 있습니다. 그동안 원본을 읽거나 메모를 남겨 보세요.') : job.state === 'completed_with_gaps' ? '번역하지 못한 쪽은 원본으로 표시합니다. 완료된 번역은 유지하고 누락된 문단만 다시 시도할 수 있습니다.' : '완료된 번역은 저장되어 있습니다. 이어 번역하면 남은 쪽을 처리합니다.'}</p>
      {firstReady ? <button type="button" onClick={() => onReadPage(firstReady.page)}>완료된 번역 읽기</button> : null}
    </div>
    <div className="translation-activity__pages" aria-label="쪽별 번역 상태">
      {pages.map(p => <button key={p.page} type="button" className={`translation-page is-${p.state}`} title={`${p.page}쪽 · ${p.label}`} aria-label={`${p.page}쪽 · ${p.label}`} onClick={() => onReadPage(p.page)}>
        <span>{p.page}</span><span className="translation-page__mark" aria-hidden="true">{p.state === 'done' ? '✓' : p.state === 'active' ? '···' : p.state === 'failed' ? '!' : '—'}</span>
      </button>)}
    </div>
  </div>;
}

export function BackgroundTranslation({ paper, initialJob, client, onOpen }: { paper: Paper; initialJob: Job; client: ApiClient; onOpen(): void }) {
  const [job, setJob] = useState(initialJob);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => { setJob(initialJob); setUnavailable(false); }, [initialJob]);
  useEffect(() => {
    if (job.state !== 'running') return;
    let cancelled = false;
    let timer: number;
    async function poll() {
      try {
        const result = await client.job(job.jobId);
        if (!cancelled) { setJob(result.job); setUnavailable(false); }
      } catch { if (!cancelled) setUnavailable(true); }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job.jobId, job.state, client]);
  const state = unavailable ? '진행 상태를 다시 확인하고 있습니다' : job.state === 'running' ? '번역 중' : job.state === 'completed' ? '번역 완료' : job.state === 'paused' ? `번역 일시정지 · ${pauseReasonNote(job.pauseReason) ?? '이어 번역할 수 있습니다'}` : job.state === 'completed_with_gaps' ? '일부 번역 확인 필요' : '번역 상태 확인 필요';
  return <aside className="background-translation" aria-label="번역 작업">
    <div><p className="background-translation__state" role="status">{state} · {job.completedBlocks}/{job.totalTranslatableBlocks}쪽</p><p>{paperTitle(paper)}</p></div>
    <button type="button" onClick={onOpen}>논문으로 돌아가기</button>
  </aside>;
}
