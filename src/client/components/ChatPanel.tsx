import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react';
import type { AppError, ChatMessage, Connection, Conversation, Paper } from '../../shared/contracts';
import { extractError, type ApiClient } from '../lib/api';
import {
  CHAT_SEND_HINT,
  POLL_START,
  QUESTION_LIMIT,
  SUGGESTIONS,
  answerAnnouncement,
  chatBlockedReason,
  chatErrorText,
  composerKeyAction,
  conversationModel,
  effectiveModel,
  followAfterScroll,
  imeOwnsKey,
  insertQuote,
  isPinnedToBottom,
  lastAssistant,
  needsAccount,
  nextPoll,
  pollInTrouble,
  questionCounter,
  questionCounterLabel,
  questionParts,
  retryQuestion,
  withSuggestion,
  type ChatBlock,
} from '../lib/chat';
import { IconArrowDown, IconClose, IconPlus, IconRetry, IconSend, IconStop } from './ChatIcons';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';

/** The calls the panel makes. Always invoked as methods of the client, never detached. */
export type ChatClient = Pick<ApiClient, 'getConversation' | 'askQuestion' | 'cancelAnswer' | 'clearConversation'>;

/** A passage to quote into the next question; a new `id` quotes again. */
export interface ChatQuote {
  id: number;
  text: string;
}

export interface PendingQuestion {
  question: string;
  retry: boolean;
}

/** A "맨 아래로" glide that never reports reaching the bottom stops counting as one after this. */
const JUMP_GIVE_UP_MS = 1_200;

// ----------------------------------------------------------------- messages

/**
 * A quoted passage in a sent question. Long passages are cut to a few lines to keep the
 * transcript readable, with a toggle to read the rest — the part the question is about may be
 * at the end.
 */
function QuoteBlock({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLQuoteElement | null>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const quote = ref.current;
    if (quote === null || expanded) return;
    const measure = () => setClamped(quote.scrollHeight > quote.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(quote);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="msg__quote-wrap">
      <blockquote ref={ref} id={id} className={`msg__quote${expanded ? ' is-expanded' : ''}`}>
        {text}
      </blockquote>
      {clamped || expanded ? (
        <button type="button" className="msg__quote-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((open) => !open)}>
          {expanded ? '인용 접기' : '인용 전체 보기'}
        </button>
      ) : null}
    </div>
  );
}

function QuestionBubble({ text, pending = false }: { text: string; pending?: boolean }): JSX.Element {
  return (
    <article className={`msg msg--question${pending ? ' is-pending' : ''}`} aria-label="내 질문">
      {questionParts(text).map((part, index) =>
        part.kind === 'quote' ? (
          <QuoteBlock key={index} text={part.text} />
        ) : (
          <p key={index} className="msg__text">
            {part.text}
          </p>
        ),
      )}
    </article>
  );
}

function Preparing(): JSX.Element {
  return (
    <p className="typing">
      <span className="typing__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>답변을 준비하는 중</span>
    </p>
  );
}

interface AnswerProps {
  message: ChatMessage;
  /** Only the last answer can be asked again. */
  canRetry: boolean;
  retryDisabled: boolean;
  /** This answer is being asked again right now; the old failure makes way for the wait. */
  retrying: boolean;
  onRetry(): void;
  onOpenAccount(): void;
}

function Answer({ message, canRetry, retryDisabled, retrying, onRetry, onOpenAccount }: AnswerProps): JSX.Element {
  const answering = message.status === 'answering';
  const hasText = message.text.trim().length > 0;
  const error = message.status === 'failed' ? message.error : null;
  const ended = message.status === 'failed' || message.status === 'canceled';
  const accountAction = needsAccount(error);
  return (
    <article className={`msg msg--answer is-${message.status}`} aria-label="답변" aria-busy={answering || retrying}>
      {hasText ? <Markdown text={message.text} caret={answering} /> : answering ? <Preparing /> : null}
      {ended && retrying ? <Preparing /> : null}
      {ended && !retrying ? (
        <div className={`msg__notice${message.status === 'failed' ? ' msg__notice--error' : ''}`}>
          <p>{message.status === 'failed' ? (error === null ? '답변을 받지 못했습니다.' : chatErrorText(error)) : hasText ? '답변을 중간에 멈췄습니다.' : '답변을 멈췄습니다.'}</p>
          {/* No empty action row: a notice without actions keeps its words the full width. */}
          {accountAction || canRetry ? (
            <div className="msg__notice-actions">
              {accountAction ? (
                <button type="button" onClick={onOpenAccount}>
                  계정 메뉴 열기
                </button>
              ) : null}
              {canRetry ? (
                <button type="button" className="msg__retry" onClick={onRetry} disabled={retryDisabled}>
                  <IconRetry />
                  다시 시도
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {!answering && hasText ? (
        <footer className="msg__meta">
          {message.modelId !== null ? <span className="msg__model">{message.modelId}</span> : null}
          <CopyButton text={message.text} label="답변 복사" />
        </footer>
      ) : null}
    </article>
  );
}

/** A poll hands back fresh objects every time; an answer that did not change is not redrawn. */
const MemoAnswer = memo(Answer, (before, after) => {
  const a = before.message;
  const b = after.message;
  return (
    a.messageId === b.messageId &&
    a.text === b.text &&
    a.status === b.status &&
    a.modelId === b.modelId &&
    a.error?.code === b.error?.code &&
    a.error?.message === b.error?.message &&
    a.error?.retryable === b.error?.retryable &&
    before.canRetry === after.canRetry &&
    before.retryDisabled === after.retryDisabled &&
    before.retrying === after.retrying &&
    before.onRetry === after.onRetry &&
    before.onOpenAccount === after.onOpenAccount
  );
});

// --------------------------------------------------------------------- view

export interface ChatViewProps {
  conversation: Conversation | null;
  /** The first read of the conversation is still in flight. */
  loading: boolean;
  /** The last read failed; shown in place of the conversation when there is none yet. */
  loadError: AppError | null;
  blocked: ChatBlock | null;
  modelIds: readonly string[];
  modelId: string;
  draft: string;
  sending: PendingQuestion | null;
  stopping: boolean;
  askError: AppError | null;
  /** Several reads of an answer being written went unanswered in a row; retries go on. */
  reconnecting?: boolean;
  confirmingClear: boolean;
  /** The reader is at the latest message; otherwise a "맨 아래로" button shows. */
  pinned: boolean;
  announcement: string;
  onModelChange(modelId: string): void;
  onDraftChange(value: string): void;
  onSend(value: string): void;
  onStop(): void;
  onRetry(): void;
  onRequestClear(): void;
  onConfirmClear(): void;
  onCancelClear(): void;
  onClose(): void;
  onOpenAccount(): void;
  onDismissError(): void;
  onReload(): void;
  onSuggestion(text: string): void;
  onJumpToBottom(): void;
  onListScroll?(): void;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  listRef?: RefObject<HTMLDivElement | null>;
  contentRef?: RefObject<HTMLDivElement | null>;
  closeRef?: RefObject<HTMLButtonElement | null>;
  newRef?: RefObject<HTMLButtonElement | null>;
  cancelClearRef?: RefObject<HTMLButtonElement | null>;
}

/** The question panel as drawn: everything it shows comes in through props. */
export function ChatView(props: ChatViewProps): JSX.Element {
  const { conversation, loading, loadError, blocked, modelIds, modelId, draft, sending, stopping, askError, confirmingClear, pinned, announcement } = props;
  const reconnecting = props.reconnecting === true;
  const composerId = useId();
  const counterId = useId();
  const hintId = useId();
  const confirmId = useId();
  const promptId = useId();
  const answering = conversation?.answering === true;
  const messages = conversation?.messages ?? [];
  const empty = messages.length === 0 && sending === null;
  const counter = questionCounter(draft.length);
  const counterLabel = questionCounterLabel(draft.length);
  const trimmed = draft.trim();
  const canSend = blocked === null && !answering && sending === null && modelId !== '' && trimmed.length > 0 && draft.length <= QUESTION_LIMIT;
  const retryable = retryQuestion(conversation) !== null;
  const lastIndex = messages.length - 1;
  // A failed read while a conversation is on screen: it stays readable, the notice says why it may be stale.
  const staleError = conversation !== null ? loadError : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || imeOwnsKey({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;
    event.preventDefault();
    event.stopPropagation();
    if (confirmingClear) props.onCancelClear();
    else props.onClose();
  };

  return (
    <div className="chat" onKeyDown={onKeyDown}>
      <header className="chat__header">
        <h2 className="chat__title">이 논문에 질문</h2>
        <div className="chat__tools">
          <select className="chat__model" aria-label="답변 모델" title="답변 모델" value={modelId} disabled={modelIds.length === 0} onChange={(event) => props.onModelChange(event.target.value)}>
            {modelIds.length === 0 ? <option value="">사용 가능한 모델 없음</option> : null}
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button
            ref={props.newRef}
            type="button"
            className="chat__new"
            onClick={confirmingClear ? props.onCancelClear : props.onRequestClear}
            disabled={messages.length === 0 || answering || sending !== null}
            aria-expanded={confirmingClear}
            aria-controls={confirmingClear ? confirmId : undefined}
            title={answering ? '답변이 끝나거나 멈춘 뒤 새 대화를 시작할 수 있습니다.' : '새 대화'}
          >
            <IconPlus />
            <span className="chat__new-label">새 대화</span>
          </button>
          <button ref={props.closeRef} type="button" className="chat__icon-button" aria-label="질문 패널 닫기" onClick={props.onClose}>
            <IconClose size={18} />
          </button>
        </div>
        {confirmingClear ? (
          // Floats under the header, so opening it moves nothing in the conversation.
          <div id={confirmId} className="chat__confirm" role="group" aria-labelledby={promptId}>
            <p id={promptId}>지금까지의 대화를 지우고 새로 시작할까요?</p>
            <div className="chat__confirm-actions">
              <button type="button" className="chat__confirm-clear" onClick={props.onConfirmClear}>
                지우기
              </button>
              <button ref={props.cancelClearRef} type="button" onClick={props.onCancelClear}>
                취소
              </button>
            </div>
          </div>
        ) : null}
      </header>

      <div className="chat__body">
        <div ref={props.listRef} className="chat__scroll" tabIndex={0} aria-label="대화 내용" onScroll={props.onListScroll}>
          <div ref={props.contentRef} className="chat__content">
            {loading && conversation === null ? (
              <p className="chat__loading" role="status">
                대화를 불러오는 중입니다.
              </p>
            ) : loadError !== null && conversation === null ? (
              <div className="chat__load-error" role="alert">
                <p>{chatErrorText(loadError)}</p>
                <button type="button" onClick={props.onReload}>
                  다시 불러오기
                </button>
              </div>
            ) : empty ? (
              <div className="chat-empty">
                <p className="chat-empty__lead">논문 전문을 읽은 모델이 답합니다. 읽다가 막힌 부분을 물어보세요.</p>
                <ul className="chat-empty__list" aria-label="질문 예시">
                  {SUGGESTIONS.map((suggestion) => (
                    <li key={suggestion}>
                      <button type="button" className="chat-empty__chip" disabled={blocked !== null} onClick={() => props.onSuggestion(suggestion)}>
                        {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="chat-empty__tip">한국어 지면에서 문장을 선택하면 질문에 인용할 수 있습니다.</p>
              </div>
            ) : (
              <div className="chat__messages">
                {messages.map((message, index) =>
                  message.role === 'user' ? (
                    <QuestionBubble key={message.messageId} text={message.text} />
                  ) : (
                    <MemoAnswer
                      key={message.messageId}
                      message={message}
                      canRetry={index === lastIndex && retryable}
                      retryDisabled={blocked !== null || sending !== null}
                      retrying={index === lastIndex && sending?.retry === true}
                      onRetry={props.onRetry}
                      onOpenAccount={props.onOpenAccount}
                    />
                  ),
                )}
                {sending !== null && !sending.retry ? (
                  <>
                    <QuestionBubble text={sending.question} pending />
                    <article className="msg msg--answer is-answering" aria-label="답변" aria-busy="true">
                      <Preparing />
                    </article>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
        {!pinned ? (
          <button type="button" className="chat__jump" onClick={props.onJumpToBottom}>
            <IconArrowDown />
            맨 아래로
          </button>
        ) : null}
      </div>

      <footer className="chat__footer">
        {reconnecting ? (
          <p className="chat__notice" role="status">
            로컬 서비스에 연결하지 못했습니다. 다시 연결을 시도하는 중입니다.
          </p>
        ) : null}
        {staleError !== null ? (
          <div className="chat__error" role="alert">
            <p>{chatErrorText(staleError)}</p>
            <button type="button" onClick={props.onReload}>
              다시 불러오기
            </button>
          </div>
        ) : null}
        {askError !== null ? (
          <div className="chat__error" role="alert">
            <p>{chatErrorText(askError)}</p>
            {needsAccount(askError) ? (
              <button type="button" onClick={props.onOpenAccount}>
                계정 메뉴 열기
              </button>
            ) : null}
            <button type="button" className="chat__icon-button chat__icon-button--small" aria-label="오류 알림 닫기" onClick={props.onDismissError}>
              <IconClose size={14} />
            </button>
          </div>
        ) : null}
        <form
          className={`chat__composer${blocked !== null ? ' is-disabled' : ''}${counter?.over === true ? ' is-invalid' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            props.onSend(draft);
          }}
        >
          <label htmlFor={composerId} className="sr-only">
            논문에 대한 질문
          </label>
          <textarea
            ref={props.composerRef}
            id={composerId}
            rows={1}
            value={draft}
            placeholder={blocked === null ? '이 논문에 대해 물어보세요' : '지금은 질문할 수 없습니다'}
            disabled={blocked !== null}
            aria-describedby={`${counter !== null ? `${counterId} ` : ''}${hintId}`}
            aria-invalid={counter?.over === true ? true : undefined}
            onChange={(event) => props.onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              const action = composerKeyAction({
                key: event.key,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              });
              if (action !== 'send') return;
              event.preventDefault();
              // Read the element, not the last render: the IME may have just committed a syllable.
              props.onSend(event.currentTarget.value);
            }}
          />
          <div className="chat__composer-bar">
            {counter !== null ? (
              <span id={counterId} className={`chat__counter${counter.over ? ' is-over' : ''}`}>
                {counterLabel}
              </span>
            ) : null}
            {answering ? (
              <button type="button" className="chat__send is-stop" aria-label="답변 멈추기" onClick={props.onStop} disabled={stopping}>
                <IconStop />
              </button>
            ) : (
              <button type="submit" className="chat__send" aria-label="질문 보내기" disabled={!canSend}>
                <IconSend size={17} />
              </button>
            )}
          </div>
        </form>
        {blocked !== null ? (
          <p id={hintId} className="chat__blocked" role="status">
            <span>{blocked.message}</span>
            {blocked.action === 'account' ? (
              <button type="button" onClick={props.onOpenAccount}>
                계정 메뉴 열기
              </button>
            ) : null}
          </p>
        ) : (
          <p id={hintId} className="chat__hint">
            {CHAT_SEND_HINT}
          </p>
        )}
      </footer>

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- container

export interface ChatPanelProps {
  client: ChatClient;
  paperKey: string;
  paper: Paper | null;
  connection: Connection | null;
  canMutate: boolean;
  /** The model chosen in the reader toolbar; the panel follows it until the reader picks one
   * here, or the conversation was already answered with an offered model. */
  preferredModelId: string;
  open: boolean;
  quote: ChatQuote | null;
  onClose(): void;
  onOpenAccount(): void;
  /** The service reported a sign-in problem; the page's connection state may be stale. */
  onConnectionStale?(): void;
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The question panel with its state: reads the conversation when opened, re-reads it every
 * 300 ms only while an answer is being written and the panel is open, and sends questions.
 * Mounted per paper (keyed by paperKey), so nothing of one paper's conversation outlives it.
 */
export function ChatPanel({ client, paperKey, paper, connection, canMutate, preferredModelId, open, quote, onClose, onOpenAccount, onConnectionStale }: ChatPanelProps): JSX.Element {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [reloads, setReloads] = useState(0);
  const [draft, setDraft] = useState('');
  const [chosenModel, setChosenModel] = useState('');
  const [sending, setSending] = useState<PendingQuestion | null>(null);
  const [stopping, setStopping] = useState(false);
  const [askError, setAskError] = useState<AppError | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  /** Bumped when the composer's end should come into view once the new draft is laid out. */
  const [reveal, setReveal] = useState(0);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const newRef = useRef<HTMLButtonElement | null>(null);
  const cancelClearRef = useRef<HTMLButtonElement | null>(null);
  /** Follow new text down while the reader is at the bottom; stop once they scroll up. */
  const stick = useRef(true);
  /** A "맨 아래로" glide under way: its own scroll events do not unpin the list. */
  const jumping = useRef<number | null>(null);
  /** Moves with every change the reader makes; a read started before it is stale. */
  const epoch = useRef(0);
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const revealed = useRef(0);
  const seen = useRef<{ messageId: string; status: ChatMessage['status'] } | null>(null);

  const modelIds = connection?.modelIds ?? [];
  const modelId = effectiveModel(chosenModel, preferredModelId, modelIds, conversationModel(conversation));
  const blocked = chatBlockedReason({ canMutate, connection, paper });
  const answering = conversation?.answering === true;

  const onConnectionStaleRef = useRef(onConnectionStale);
  onConnectionStaleRef.current = onConnectionStale;
  // The actions read the latest state from here, so their identity stays put across polls and
  // a finished answer is not redrawn every 300 ms.
  const latest = useRef({ blocked, answering, modelId, conversation });
  latest.current = { blocked, answering, modelId, conversation };

  // ------------------------------------------------------------- reading

  // Read the conversation each time the panel opens (and on "다시 불러오기").
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const mine = epoch.current;
    void client
      .getConversation(paperKey)
      .then(({ conversation: next }) => {
        if (cancelled || mine !== epoch.current) return;
        setConversation(next);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled && mine === epoch.current) setLoadError(extractError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, paperKey, open, reloads]);

  // While an answer is being written, and only while the panel is open, keep re-reading it. A
  // missed read is retried a little later each time; after a few in a row the reader is told.
  useEffect(() => {
    if (!open || !answering) return;
    let cancelled = false;
    let timer: number | undefined;
    let poll = POLL_START;
    const tick = async () => {
      const mine = epoch.current;
      let ok = false;
      try {
        const { conversation: next } = await client.getConversation(paperKey);
        if (cancelled) return;
        if (mine === epoch.current) setConversation(next);
        setLoadError(null);
        ok = true;
      } catch {
        if (cancelled) return;
      }
      poll = nextPoll(poll, ok);
      setReconnecting(pollInTrouble(poll));
      if (!cancelled) timer = window.setTimeout(() => void tick(), poll.delay);
    };
    timer = window.setTimeout(() => void tick(), poll.delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setReconnecting(false);
    };
  }, [client, paperKey, open, answering]);

  // Announce a finished answer once, and refresh the account state after a sign-in failure.
  useEffect(() => {
    const last = lastAssistant(conversation);
    const said = answerAnnouncement(seen.current, last);
    seen.current = last === null ? null : { messageId: last.messageId, status: last.status };
    if (said !== null) setAnnouncement((current) => (current === said ? `${said}.` : said));
    if (said !== null && last !== null && needsAccount(last.error)) onConnectionStaleRef.current?.();
  }, [conversation]);

  // ----------------------------------------------------------- scrolling

  const toBottom = useCallback(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, []);

  const endJump = useCallback(() => {
    if (jumping.current === null) return;
    window.clearTimeout(jumping.current);
    jumping.current = null;
  }, []);

  const onListScroll = useCallback(() => {
    const list = listRef.current;
    if (list === null) return;
    const follow = followAfterScroll(isPinnedToBottom(list.scrollHeight, list.scrollTop, list.clientHeight), jumping.current !== null);
    if (follow.jumpDone) endJump();
    stick.current = follow.pinned;
    setPinned(follow.pinned);
  }, [endJump]);

  useLayoutEffect(() => {
    if (stick.current) toBottom();
    else onListScroll();
  }, [conversation, sending, loading, toBottom, onListScroll]);

  // Text reflows as the panel slides open, fonts arrive and formulas are typeset.
  useEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [toBottom, loading]);

  // The list keeps a gutter for its scrollbar; the content gives that width back on its right,
  // so its text ends where the header's and the composer's controls do.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const measure = () => {
      const gutter = Math.min(16, Math.max(0, list.offsetWidth - list.clientWidth));
      list.style.setProperty('--chat-gutter', `${gutter}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // A glide ends when the browser says so, whatever the positions on the way reported.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const onEnd = () => {
      if (jumping.current === null) return;
      endJump();
      onListScroll();
    };
    list.addEventListener('scrollend', onEnd);
    return () => {
      list.removeEventListener('scrollend', onEnd);
      endJump();
    };
  }, [endJump, onListScroll]);

  const jumpToBottom = useCallback(() => {
    const list = listRef.current;
    stick.current = true;
    setPinned(true);
    if (list === null) return;
    // The button goes away once the list is at the bottom; the list itself takes the focus.
    list.focus({ preventScroll: true });
    if (reducedMotion()) {
      toBottom();
      return;
    }
    endJump();
    jumping.current = window.setTimeout(() => {
      jumping.current = null;
      onListScroll();
    }, JUMP_GIVE_UP_MS);
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [endJump, onListScroll, toBottom]);

  // --------------------------------------------------------------- focus

  const focusComposer = useCallback(() => {
    const composer = composerRef.current;
    if (composer !== null && !composer.disabled) {
      composer.focus({ preventScroll: true });
      const end = composer.value.length;
      composer.setSelectionRange(end, end);
      composer.scrollTop = composer.scrollHeight;
    } else {
      closeRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setConfirmingClear(false);
      return;
    }
    stick.current = true;
    const frame = window.requestAnimationFrame(() => {
      toBottom();
      focusComposer();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, focusComposer, toBottom]);

  // A quoted passage lands in the composer, ready for the question under it.
  useEffect(() => {
    if (quote === null) return;
    setDraft((current) => insertQuote(current, quote.text));
    setReveal((count) => count + 1);
    // Only a new quote (id) is applied; the same one is never applied twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id]);

  useEffect(() => {
    if (confirmingClear) cancelClearRef.current?.focus();
  }, [confirmingClear]);

  // The composer grows with its text up to about eight lines (CSS max-height), then scrolls. A
  // quote or suggestion that just landed is brought into view here, after the new text is laid
  // out — never before, or the caret would sit below the visible lines.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (composer === null) return;
    composer.style.height = 'auto';
    composer.style.height = `${composer.scrollHeight}px`;
    if (reveal !== revealed.current) {
      revealed.current = reveal;
      focusComposer();
    }
  }, [draft, open, reveal, focusComposer]);

  // ------------------------------------------------------------- actions

  const ask = useCallback(
    async (raw: string, retry: boolean) => {
      const { blocked: reason, answering: busy, modelId: model } = latest.current;
      const question = raw.trim();
      if (question.length === 0 || raw.length > QUESTION_LIMIT || reason !== null || busy || sendingRef.current || model === '') return;
      sendingRef.current = true;
      epoch.current += 1;
      const mine = epoch.current;
      stick.current = true;
      setPinned(true);
      setSending({ question, retry });
      setAskError(null);
      // A new question settles a pending "새 대화" confirmation: the conversation goes on.
      setConfirmingClear(false);
      if (!retry) setDraft('');
      try {
        const { conversation: next } = await client.askQuestion(paperKey, retry ? { question, modelId: model, retry: true } : { question, modelId: model });
        if (mine === epoch.current) setConversation(next);
      } catch (cause) {
        const failure = extractError(cause);
        setAskError(failure);
        // The question is not lost: it goes back into an empty composer.
        if (!retry) setDraft((current) => (current.trim().length === 0 ? raw : current));
        if (needsAccount(failure)) onConnectionStaleRef.current?.();
        if (failure.code === 'BUSY') setReloads((count) => count + 1);
      } finally {
        sendingRef.current = false;
        setSending(null);
      }
    },
    [client, paperKey],
  );

  // The send and retry buttons are disabled (or go away) the moment they are used; the focus
  // moves to the composer first instead of falling to the page, where Escape does nothing.
  const send = useCallback(
    (value: string) => {
      if (document.activeElement !== composerRef.current) focusComposer();
      void ask(value, false);
    },
    [ask, focusComposer],
  );

  const retry = useCallback(() => {
    const question = retryQuestion(latest.current.conversation);
    if (question === null) return;
    focusComposer();
    void ask(question, true);
  }, [ask, focusComposer]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    epoch.current += 1;
    setStopping(true);
    focusComposer();
    try {
      const { conversation: next } = await client.cancelAnswer(paperKey);
      setConversation(next);
    } catch (cause) {
      setAskError(extractError(cause));
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [client, paperKey, focusComposer]);

  const clear = useCallback(async () => {
    setConfirmingClear(false);
    epoch.current += 1;
    // The confirmation is about to go away with the focus in it.
    focusComposer();
    try {
      const { conversation: next } = await client.clearConversation(paperKey);
      setConversation(next);
      setAskError(null);
      stick.current = true;
    } catch (cause) {
      setAskError(extractError(cause));
    }
    focusComposer();
  }, [client, paperKey, focusComposer]);

  // A suggestion is added under what the reader already wrote (a quoted passage stays).
  const suggest = useCallback((text: string) => {
    setDraft((current) => withSuggestion(current, text));
    setReveal((count) => count + 1);
  }, []);

  const cancelClear = useCallback(() => {
    // Back to the button that asked, not to "close the panel" one Enter away.
    newRef.current?.focus();
    setConfirmingClear(false);
  }, []);

  const dismissError = useCallback(() => {
    focusComposer();
    setAskError(null);
  }, [focusComposer]);

  return (
    <ChatView
      conversation={conversation}
      loading={loading}
      loadError={loadError}
      blocked={blocked}
      modelIds={modelIds}
      modelId={modelId}
      draft={draft}
      sending={sending}
      stopping={stopping}
      askError={askError}
      reconnecting={reconnecting}
      confirmingClear={confirmingClear}
      pinned={pinned}
      announcement={announcement}
      onModelChange={setChosenModel}
      onDraftChange={setDraft}
      onSend={send}
      onStop={() => void stop()}
      onRetry={retry}
      onRequestClear={() => setConfirmingClear(true)}
      onConfirmClear={() => void clear()}
      onCancelClear={cancelClear}
      onClose={onClose}
      onOpenAccount={onOpenAccount}
      onDismissError={dismissError}
      onReload={() => {
        setLoading(true);
        setReloads((count) => count + 1);
      }}
      onSuggestion={suggest}
      onJumpToBottom={jumpToBottom}
      onListScroll={onListScroll}
      composerRef={composerRef}
      listRef={listRef}
      contentRef={contentRef}
      closeRef={closeRef}
      newRef={newRef}
      cancelClearRef={cancelClearRef}
    />
  );
}

export default ChatPanel;
