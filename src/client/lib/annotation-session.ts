import type { AnnotationInput, AppError, Highlight } from '../../shared/contracts';
import { MAX_ANNOTATION_RECTS } from '../../shared/contracts';
import { extractError } from './api';

/** The part of the API client the annotations of one paper use. */
export interface AnnotationClient {
  listHighlights(paperKey: string): Promise<Highlight[]>;
  createHighlight(paperKey: string, input: AnnotationInput): Promise<Highlight>;
  createHighlights(paperKey: string, inputs: AnnotationInput[]): Promise<Highlight[]>;
  updateHighlight(paperKey: string, highlightId: string, input: { note?: string | null; color?: Highlight['color'] }): Promise<Highlight>;
  deleteHighlight(paperKey: string, highlightId: string): Promise<{ deleted: true }>;
}

/** A viewport point a memo card opens beside. */
export interface CardAnchor {
  left: number;
  top: number;
}

/** The memo card: a new memo on a selection, or the memo of a saved record. */
export interface MemoCard {
  kind: 'new' | 'record';
  /** A new memo's selection, one input per page; the memo goes on the first. Empty for a record. */
  inputs: AnnotationInput[];
  /** The saved record the card shows; null for a new memo. */
  highlightId: string | null;
  /** Where a new card opens (the selection's right end); null opens it below its record. */
  anchor: CardAnchor | null;
  text: string;
  editing: boolean;
  /** A save or delete is waiting for the service: the card is locked until it answers. */
  saving: boolean;
  error: string | null;
}

export interface AnnotationState {
  paperKey: string | null;
  highlights: Highlight[];
  /** Highlighter sweeps sent to the service and not answered yet: drawn, not yet records. */
  pending: AnnotationInput[];
  card: MemoCard | null;
  notice: string;
  /** Every pen stroke erased in this session, newest last; an undo brings the newest back. */
  erased: Highlight[];
  restoring: boolean;
}

/** Why a selection that marks more lines of a page than a record holds is not saved. */
export const TOO_MANY_LINES = `한 쪽에서 한 번에 표시할 수 있는 줄은 ${MAX_ANNOTATION_RECTS}줄까지입니다. 나눠서 선택해 주세요.`;

/** Notices that stay until the next one replaces them; every other notice fades. */
export const LASTING_NOTICES: readonly string[] = ['저장 중…', '저장하지 못했습니다.', TOO_MANY_LINES];

const EMPTY: AnnotationState = { paperKey: null, highlights: [], pending: [], card: null, notice: '', erased: [], restoring: false };

/** True when the card holds writing the reader has not saved. */
export function cardDirty(card: MemoCard | null, highlights: Highlight[]): boolean {
  if (card === null || !card.editing) return false;
  const saved = card.kind === 'record' ? (highlights.find((h) => h.highlightId === card.highlightId)?.note ?? '') : '';
  return card.text !== saved;
}

/** A record or input on the Korean side; one without a surface is on the original. */
const korean = (item: AnnotationInput): boolean => item.surface === 'translation';

/** The input that re-creates a record exactly as it was, for undoing an erase. */
function inputOf(highlight: Highlight): AnnotationInput {
  const { highlightId: _id, paperKey: _key, createdAt: _created, updatedAt: _updated, ...input } = highlight;
  return input;
}

/**
 * The highlights, memos and pen strokes of the paper being read, and every change the reader
 * makes to them. Each answer is applied only to the paper it was asked for: an answer that
 * arrives after the reader moved to another paper is dropped, never shown on the new one, and
 * an answer about the Korean side after a new translation was confirmed is dropped as well.
 * Nothing is reported saved before the service has answered.
 */
export class AnnotationSession {
  private state: AnnotationState = EMPTY;
  private epoch = 0;
  /** Counts the new translations confirmed for the paper: the Korean side each one replaced. */
  private translation = 0;
  private loads = 0;
  private readonly erasing = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: AnnotationClient, private readonly onError: (cause: unknown) => void) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): AnnotationState => this.state;

  private set(change: Partial<AnnotationState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  private setCard(change: Partial<MemoCard>): void {
    if (this.state.card !== null) this.set({ card: { ...this.state.card, ...change } });
  }

  /** Run `request` for the current paper; `done`/`failed` run only if that paper is still read. */
  private send<T>(request: (paperKey: string) => Promise<T>, done: (value: T) => void, failed: (cause: unknown) => void): void {
    const paperKey = this.state.paperKey;
    if (paperKey === null) return;
    const epoch = this.epoch;
    request(paperKey).then(
      (value) => { if (this.epoch === epoch) done(value); },
      (cause) => { if (this.epoch === epoch) failed(cause); },
    );
  }

  /** Like `send`, for a request about one side of the paper. An answer about the Korean side that
   * comes after a new translation was confirmed goes to `dropped` instead. */
  private sendOn<T>(onKorean: boolean, request: (paperKey: string) => Promise<T>, done: (value: T) => void, failed: (cause: unknown) => void, dropped: () => void = () => {}): void {
    const translation = this.translation;
    const current = () => !onKorean || this.translation === translation;
    this.send(request, (value) => (current() ? done(value) : dropped()), (cause) => (current() ? failed(cause) : dropped()));
  }

  private onKorean(highlightId: string): boolean {
    return this.state.highlights.some((h) => h.highlightId === highlightId && korean(h));
  }

  /** Read `paperKey` (null: no paper). Everything still in flight for the previous one is dropped. */
  enter(paperKey: string | null): void {
    this.epoch += 1;
    this.erasing.clear();
    this.set({ ...EMPTY, paperKey });
    this.reload();
  }

  /**
   * A new translation of `paperKey` was confirmed: it takes the Korean side with it. Its records,
   * the sweeps there still on their way, a card on it (even one being written) and its erased
   * strokes go at once, and an answer about that side still to come is dropped, a reading of the
   * records included; read them again once the service has started the new translation. The
   * original's side stays as it is.
   */
  dropTranslation(paperKey: string): void {
    if (this.state.paperKey !== paperKey) return;
    this.translation += 1;
    this.loads += 1;
    const { card, notice } = this.state;
    const cardOnKorean = card !== null && (card.kind === 'new' ? card.inputs.some(korean) : this.onKorean(card.highlightId!));
    const pending = this.state.pending.filter((input) => !korean(input));
    const kept = cardOnKorean ? null : card;
    // "Saving" stays only while something on the original is still on its way.
    const saving = pending.length > 0 || kept?.saving === true;
    this.set({
      highlights: this.state.highlights.filter((h) => !korean(h)),
      pending,
      card: kept,
      erased: this.state.erased.filter((h) => !korean(h)),
      notice: notice === '저장 중…' && !saving ? '' : notice,
    });
  }

  /** Read the records again, e.g. after a new translation removed the Korean-side ones. */
  reload(): void {
    const load = ++this.loads;
    this.send(
      (paperKey) => this.client.listHighlights(paperKey),
      (highlights) => {
        if (load !== this.loads) return;
        const card = this.state.card;
        const gone = card?.kind === 'record' && !highlights.some((h) => h.highlightId === card.highlightId);
        this.set({ highlights, card: gone ? null : card });
      },
      (cause) => { if (load === this.loads) this.onError(cause); },
    );
  }

  private append(created: Highlight[]): Highlight[] {
    const fresh = created.filter((record) => !this.state.highlights.some((h) => h.highlightId === record.highlightId));
    return [...this.state.highlights, ...fresh];
  }

  private replace(updated: Highlight): Highlight[] {
    return this.state.highlights.map((h) => (h.highlightId === updated.highlightId ? updated : h));
  }

  /** Refuses a selection that marks more lines of a page than a record holds: nothing of it is
   * sent, and the reader is told why and what to do instead. True when it was refused. */
  private refuseTooMany(inputs: AnnotationInput[]): boolean {
    if (inputs.every((input) => input.rects.length <= MAX_ANNOTATION_RECTS)) return false;
    this.set({ notice: TOO_MANY_LINES });
    const refusal: AppError = { code: 'INVALID_INPUT', message: TOO_MANY_LINES, retryable: false };
    this.onError(refusal);
    return true;
  }

  /** Save highlighter sweeps or a pen stroke at once; drawn as pending until the service answers. */
  create(inputs: AnnotationInput[]): void {
    if (this.state.paperKey === null || inputs.length === 0 || this.refuseTooMany(inputs)) return;
    this.set({ pending: [...this.state.pending, ...inputs], notice: '저장 중…' });
    const settle = () => this.state.pending.filter((input) => !inputs.includes(input));
    this.sendOn(
      inputs.some(korean),
      (paperKey) => this.client.createHighlights(paperKey, inputs),
      (created) => this.set({ highlights: this.append(created), pending: settle(), notice: inputs[0].kind === 'ink' ? '필기를 저장했습니다.' : '하이라이트를 저장했습니다.' }),
      (cause) => {
        this.set({ pending: settle(), notice: '저장하지 못했습니다.' });
        this.onError(cause);
      },
    );
  }

  /** Open a card for a new memo on a selection (one input per page it crosses). */
  startMemo(inputs: AnnotationInput[], anchor: CardAnchor | null): void {
    if (this.state.paperKey === null || inputs.length === 0 || this.refuseTooMany(inputs) || !this.mayReplaceCard()) return;
    this.set({ card: { kind: 'new', inputs, highlightId: null, anchor, text: '', editing: true, saving: false, error: null } });
  }

  /** Open the card of a saved record; a highlight without a memo opens ready for writing one. A
   * memo belongs to a highlight: a pen stroke's card never offers one. */
  open(highlightId: string, anchor: CardAnchor | null): void {
    const record = this.state.highlights.find((h) => h.highlightId === highlightId);
    if (record === undefined || this.state.card?.highlightId === highlightId || !this.mayReplaceCard()) return;
    this.set({ card: { kind: 'record', inputs: [], highlightId, anchor, text: record.note ?? '', editing: record.note === null && record.kind !== 'ink', saving: false, error: null } });
  }

  private mayReplaceCard(): boolean {
    const card = this.state.card;
    if (card?.saving) return false;
    if (cardDirty(card, this.state.highlights)) {
      this.set({ notice: '작성 중인 메모를 먼저 저장하거나 닫아주세요.' });
      return false;
    }
    return true;
  }

  editMemo(): void {
    const card = this.state.card;
    if (card === null || card.kind !== 'record' || card.saving) return;
    const record = this.state.highlights.find((h) => h.highlightId === card.highlightId);
    if (record?.kind === 'ink') return;
    this.setCard({ editing: true, text: record?.note ?? '', error: null });
  }

  setMemoText(text: string): void {
    const card = this.state.card;
    if (card === null || !card.editing || card.saving) return;
    this.setCard({ text });
  }

  closeCard(): void {
    if (this.state.card?.saving) return;
    this.set({ card: null });
  }

  /** Save the card's memo. A failure keeps the writing in the card and unlocks it. */
  saveMemo(): void {
    const card = this.state.card;
    if (card === null || !card.editing || card.saving || this.state.paperKey === null) return;
    const note = card.text.trim().length === 0 ? null : card.text;
    if (card.kind === 'new') {
      if (note === null) return;
      const [first, ...rest] = card.inputs;
      const inputs = [{ ...first, note }, ...rest];
      this.lock();
      this.sendOn(
        inputs.some(korean),
        (paperKey) => this.client.createHighlights(paperKey, inputs),
        (created) => this.set({ highlights: this.append(created), card: null, notice: '메모를 저장했습니다.' }),
        (cause) => this.unlock(cause),
      );
      return;
    }
    const highlightId = card.highlightId!;
    if (this.state.highlights.find((h) => h.highlightId === highlightId)?.kind === 'ink') return;
    this.lock();
    this.sendOn(
      this.onKorean(highlightId),
      (paperKey) => this.client.updateHighlight(paperKey, highlightId, { note }),
      (updated) => this.set({ highlights: this.replace(updated), card: null, notice: note === null ? '메모를 삭제했습니다.' : '메모를 저장했습니다.' }),
      (cause) => this.unlock(cause),
    );
  }

  /** Remove the memo of the open record; its highlight or stroke stays. */
  deleteMemo(): void {
    const card = this.state.card;
    if (card === null || card.kind !== 'record' || card.saving) return;
    const highlightId = card.highlightId!;
    this.lock();
    this.sendOn(
      this.onKorean(highlightId),
      (paperKey) => this.client.updateHighlight(paperKey, highlightId, { note: null }),
      (updated) => this.set({ highlights: this.replace(updated), card: null, notice: '메모를 삭제했습니다.' }),
      (cause) => this.unlock(cause),
    );
  }

  /** Delete the open record itself, from its own card only. */
  deleteRecord(): void {
    const card = this.state.card;
    if (card === null || card.kind !== 'record' || card.saving) return;
    const highlightId = card.highlightId!;
    const ink = this.state.highlights.find((h) => h.highlightId === highlightId)?.kind === 'ink';
    this.lock();
    this.sendOn(
      this.onKorean(highlightId),
      (paperKey) => this.client.deleteHighlight(paperKey, highlightId),
      () => this.set({ highlights: this.state.highlights.filter((h) => h.highlightId !== highlightId), card: null, notice: ink ? '필기를 삭제했습니다.' : '하이라이트를 삭제했습니다.' }),
      (cause) => this.unlock(cause),
    );
  }

  /** Change the colour of the open record. */
  recolor(color: Highlight['color']): void {
    const card = this.state.card;
    if (card === null || card.kind !== 'record' || card.saving) return;
    const highlightId = card.highlightId!;
    this.lock();
    this.sendOn(
      this.onKorean(highlightId),
      (paperKey) => this.client.updateHighlight(paperKey, highlightId, { color }),
      (updated) => {
        this.set({ highlights: this.replace(updated), notice: '색을 바꿨습니다.' });
        this.setCard({ saving: false });
      },
      (cause) => this.unlock(cause),
    );
  }

  private lock(): void {
    this.setCard({ saving: true, error: null });
    this.set({ notice: '저장 중…' });
  }

  private unlock(cause: unknown): void {
    this.setCard({ saving: false, error: extractError(cause).message });
    this.set({ notice: '저장하지 못했습니다.' });
  }

  /** The eraser removes pen strokes only; highlights and memos are deleted from their card. A
   * stroke that carries a memo (an older version allowed one) is left to its card as well. */
  erase(highlightId: string): void {
    const record = this.state.highlights.find((h) => h.highlightId === highlightId);
    if (record === undefined || record.kind !== 'ink' || (record.note ?? null) !== null || this.erasing.has(highlightId)) return;
    this.erasing.add(highlightId);
    this.sendOn(
      korean(record),
      (paperKey) => this.client.deleteHighlight(paperKey, highlightId),
      () => {
        this.erasing.delete(highlightId);
        const card = this.state.card?.highlightId === highlightId ? null : this.state.card;
        this.set({ highlights: this.state.highlights.filter((h) => h.highlightId !== highlightId), erased: [...this.state.erased, record], card, notice: '필기를 지웠습니다.' });
      },
      (cause) => {
        this.erasing.delete(highlightId);
        this.onError(cause);
      },
      () => this.erasing.delete(highlightId),
    );
  }

  /** Bring back the stroke erased last. */
  undoErase(): void {
    const last = this.state.erased.at(-1);
    if (last === undefined || this.state.restoring) return;
    this.set({ restoring: true });
    this.sendOn(
      korean(last),
      (paperKey) => this.client.createHighlight(paperKey, inputOf(last)),
      (restored) => this.set({ highlights: this.append([restored]), erased: this.state.erased.filter((h) => h !== last), restoring: false, notice: '지운 필기를 복원했습니다.' }),
      (cause) => {
        this.set({ restoring: false });
        this.onError(cause);
      },
      // No other undo starts while this one is on its way: the flag is still this one's.
      () => this.set({ restoring: false }),
    );
  }

  /** Let a fading notice go, unless another one replaced it meanwhile. */
  clearNotice(notice: string): void {
    if (this.state.notice === notice) this.set({ notice: '' });
  }
}
