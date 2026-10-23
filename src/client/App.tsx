import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject, type CSSProperties } from 'react';
import type { AnnotationInput, AnnotationMode, AppError, Block, Connection, Highlight, Job, LoginAttempt, Paper, RestartTranslationRequest, Snapshot } from '../shared/contracts';
import { AccountPanel } from './components/AccountPanel';
import { AnnotationNotebook, AnnotationToolbar } from './components/AnnotationTools';
import { ModelPreferences } from './components/ModelPreferences';
import { PanelResizeHandle } from './components/PanelResizeHandle';
import { ChatBoundary } from './components/ChatBoundary';
import type { ChatQuote } from './components/ChatPanel';
import { FindBar } from './components/FindBar';
import { HighlightPopover } from './components/HighlightLayer';
import { KoreanPages, type SelectVia } from './components/KoreanPane';
import { BackgroundTranslation } from './components/TranslationActivity';
import { DeleteDialog, LibraryPanel } from './components/LibraryPanel';
import { RenamePaperDialog } from './components/RenamePaperDialog';
import { PdfPages } from './components/PdfPane';
import { ReaderToolbar, type ReplacementRequest } from './components/ReaderToolbar';
import { ApiClient, extractError, readToken } from './lib/api';
import type { EraserSize } from './lib/eraser';
import { keepsKeysToItself } from './lib/find';
import { blockPage, type Size } from './lib/geometry';
import { koreanPageFallbackHeight, koreanPageHeight } from './lib/korean-page';
import { intrinsicSize, loadPdf, type PDFDocumentProxy } from './lib/pdf';
import { connectionShortLabel, connectionTone, paperStatusLabel, pickDefaultModel, preferredModelFallback, saveModelChoice, translationBlockedReason } from './lib/status';
import {
  beginProgrammaticScroll,
  createLinkState,
  mapScrollPosition,
  onUserScroll,
  orderedAnchors,
  pageBoundaries,
  pageTop,
  positionInPages,
  scrollTopForDescendant,
  scrollTopForPosition,
  type PageBox,
  type PagePosition,
  type Pane,
  type ScrollAnchor,
} from './lib/sync';
import { CONTROL_LIMITS, clampSplit, clampZoom, isReadable, nextPage, onePaneBesideChat, paragraphJumpDelay, shouldPoll } from './lib/view';

const POLL_MS = 1_500;
const LOGIN_POLL_MS = 2_000;
const FALLBACK_INTRINSIC_SIZE: Size = { width: 640, height: 828 };
/** Where a confirmed restart waits until its answer is confirmed. Never holds login data. */
const PENDING_RESTART_KEY = 'paperread.pendingRestart';
/** Shown next to the button that performs the send; opening a paper sends nothing. */
const SEND_HINT = '번역 시작 시 논문 내용이 Codex로 전송되고 ChatGPT 구독 사용량을 사용합니다.';

/** The question panel's element, for the toolbar toggle's aria-controls. */
const CHAT_PANEL_ID = 'paper-chat';
/** How long the panel takes to slide open or shut (styles.css --chat-duration). */
const CHAT_TRANSITION_MS = 220;
/** Where the panel stops docking beside the reader and covers it as a sheet (styles.css). */
const CHAT_SHEET_QUERY = '(max-width: 999px)';

// The question panel (with its markdown and formula typesetting) loads the first time it opens.
const ChatPanel = lazy(() => import('./components/ChatPanel'));

const client = new ApiClient(readToken(document));

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Whether a media query matches now, kept up to date. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** A pane body the reader can see: laid out, and not the pane hidden in the one-pane layout. */
function paneVisible(body: HTMLElement | null): boolean {
  return body !== null && body.clientWidth > 0 && window.getComputedStyle(body).visibility === 'visible';
}

/** Whether text is selected inside `node`. */
function selectionWithin(node: HTMLElement | null): boolean {
  const selection = window.getSelection();
  return node !== null && selection !== null && !selection.isCollapsed && selection.rangeCount > 0 && node.contains(selection.getRangeAt(0).commonAncestorContainer);
}

interface PendingRestart extends RestartTranslationRequest {
  paperKey: string;
}

function readPendingRestart(): PendingRestart | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_RESTART_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<PendingRestart>;
    if (typeof value.paperKey !== 'string' || typeof value.modelId !== 'string' || typeof value.requestId !== 'string' || typeof value.expectedJobId !== 'string') {
      return null;
    }
    return { paperKey: value.paperKey, modelId: value.modelId, requestId: value.requestId, expectedJobId: value.expectedJobId };
  } catch {
    return null;
  }
}

function writePendingRestart(value: PendingRestart | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(PENDING_RESTART_KEY);
    else window.sessionStorage.setItem(PENDING_RESTART_KEY, JSON.stringify(value));
  } catch {
    /* storage may be unavailable; the request still goes out once */
  }
}

function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function leaderLabel(leader: Pane | null): string {
  if (leader === null) return '스크롤 연동 대기';
  return leader === 'source' ? '원본을 따라 이동 중' : '번역을 따라 이동 중';
}

export function App(): JSX.Element {
  const [input, setInput] = useState('');
  const [paperKey, setPaperKey] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [modelId, setModelId] = useState<string>('');
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [openHighlightId, setOpenHighlightId] = useState<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('select');
  const [annotationColor, setAnnotationColor] = useState<Highlight['color']>('yellow');
  const [eraserSize, setEraserSize] = useState<EraserSize>('medium');
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const [annotationNotice, setAnnotationNotice] = useState('');
  const [annotationBusyId, setAnnotationBusyId] = useState<string | null>(null);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [erasedInk, setErasedInk] = useState<Highlight[]>([]);
  const pendingErases = useRef(new Set<string>());
  const [restoringInk, setRestoringInk] = useState(false);
  const [annotationDirty, setAnnotationDirty] = useState(false);

  // Account: the popover, the app-issued login attempt, and its official address.
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginAttempt, setLoginAttempt] = useState<LoginAttempt | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<AppError | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const accountButtonRef = useRef<HTMLButtonElement | null>(null);

  // The question panel: open or shut, mounted from its first opening, and a passage to quote.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMounted, setChatMounted] = useState(false);
  const [chatQuote, setChatQuote] = useState<ChatQuote | null>(null);
  const chatButtonRef = useRef<HTMLButtonElement | null>(null);
  const chatDockRef = useRef<HTMLElement | null>(null);
  const quoteCount = useRef(0);
  const refitTimer = useRef<number | undefined>(undefined);
  // Below the sheet breakpoint the panel covers the reader; the covered reader is inert.
  const chatSheet = useMediaQuery(CHAT_SHEET_QUERY);
  const chatDocked = (chatOpen || notebookOpen) && !chatSheet;
  const readerRef = useRef<HTMLDivElement | null>(null);
  const [readerWidth, setReaderWidth] = useState<number | null>(null);
  const onePane = onePaneBesideChat(readerWidth, chatDocked);

  // Where focus goes when the account menu closes: the control that opened it, or — when that
  // was a question-panel control that went away meanwhile (signed in) — back into the panel.
  const accountOpener = useRef<{ element: HTMLElement | null; fromChat: boolean }>({ element: null, fromChat: false });
  const accountReturnRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current(): HTMLElement | null {
        const { element, fromChat } = accountOpener.current;
        if (element !== null && element.isConnected && !(element instanceof HTMLButtonElement && element.disabled)) return element;
        if (fromChat) {
          const dock = chatDockRef.current;
          return dock?.querySelector<HTMLElement>('textarea:not(:disabled)') ?? dock?.querySelector<HTMLElement>('.chat__icon-button') ?? chatButtonRef.current;
        }
        return accountButtonRef.current;
      },
    }),
    [],
  );

  // Replacement and deletion are confirmed in dialogs, never from a primary button.
  const [replacement, setReplacement] = useState<ReplacementRequest | null>(null);
  const [resetting, setResetting] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Paper | null>(null);
  const [backgroundTranslation, setBackgroundTranslation] = useState<{ paper: Paper; job: Job } | null>(null);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [split, setSplit] = useState(0.5);
  const [leader, setLeader] = useState<Pane | null>(null);
  const [narrowPane, setNarrowPane] = useState<Pane>('source');

  const pdfBody = useRef<HTMLDivElement | null>(null);
  const textBody = useRef<HTMLDivElement | null>(null);
  const pageNodes = useRef(new Map<number, HTMLDivElement>());
  const intrinsic = useRef(new Map<number, Size>());
  const snapshotRef = useRef<Snapshot | null>(null);
  const paperKeyRef = useRef<string | null>(null);
  // Every paper switch and every confirmed restart moves the epoch; an answer from an
  // older epoch is dropped instead of overwriting the state it no longer describes.
  const epoch = useRef(0);
  const [intrinsicVersion, setIntrinsicVersion] = useState(0);
  const [koreanHeights, setKoreanHeights] = useState<Map<number, number>>(() => new Map());
  const link = useRef(createLinkState(true));
  // Whether the pane that follows sits where the link put it. A paragraph click moves one pane
  // to a page top on purpose; until the reader scrolls again, nothing pulls it back in line.
  const aligned = useRef(true);
  // Each pane's place (page and share of it) just before a zoom change, put back once the new
  // zoom is laid out; null when no zoom change is waiting.
  const zoomAnchor = useRef<{ source: PagePosition | null; translation: PagePosition | null } | null>(null);
  // A click on Korean text in the one-pane layout, waiting out a possible double-click.
  const koreanJump = useRef<number | undefined>(undefined);

  const paper = snapshot?.paper ?? null;
  const job = snapshot?.job ?? null;
  const readable = paper !== null && isReadable(paper.status);
  const blockedReason = translationBlockedReason(connection, paper);
  const canTranslate = client.canMutate && blockedReason === null && !busy && !resetting;

  const fail = useCallback((cause: unknown) => setError(extractError(cause)), []);

  // ------------------------------------------------------------- connection

  const refreshConnection = useCallback(async () => {
    try {
      const value = await client.connection();
      setConnection(value);
      setModelId((current) => (current !== '' && value.modelIds.includes(current) ? current : (pickDefaultModel(value) ?? '')));
    } catch (cause) {
      fail(cause);
    }
  }, [fail]);

  // A model picked in the toolbar or the question panel is remembered as the app-wide default.
  const chooseModel = useCallback((id: string) => {
    setModelId(id);
    saveModelChoice(client, id).then(setConnection, fail);
  }, [fail]);

  const loadLibrary = useCallback(async () => {
    try {
      const { papers: stored } = await client.listPapers();
      setPapers(stored);
    } catch (cause) {
      fail(cause);
    }
  }, [fail]);

  useEffect(() => {
    void refreshConnection();
    void loadLibrary();
  }, [refreshConnection, loadLibrary]);

  // --------------------------------------------------------------- snapshot

  const applySnapshot = useCallback((next: Snapshot) => {
    const previous = snapshotRef.current;
    snapshotRef.current = next;
    setKoreanHeights((heights) => {
      return previous === null || previous.paper.paperKey !== next.paper.paperKey ? new Map() : heights;
    });
    setSnapshot(next);
    if (next.job?.state === 'running') setBackgroundTranslation({ paper: next.paper, job: next.job });
    else setBackgroundTranslation(current => current?.paper.paperKey === next.paper.paperKey ? null : current);
  }, []);

  const refresh = useCallback(
    async (key: string) => {
      const mine = epoch.current;
      try {
        const next = await client.snapshot(key);
        // A late answer for a paper that was left, or for the epoch before a restart, is stale.
        if (epoch.current !== mine || paperKeyRef.current !== key) return;
        applySnapshot(next);
      } catch (cause) {
        if (epoch.current === mine && paperKeyRef.current === key) fail(cause);
      }
    },
    [applySnapshot, fail],
  );

  // Poll only while acquisition or a translation job is genuinely in flight.
  useEffect(() => {
    if (paperKey === null || paper === null) return;
    if (!shouldPoll(paper.status, job?.state ?? null)) return;
    const timer = window.setInterval(() => void refresh(paperKey), POLL_MS);
    return () => window.clearInterval(timer);
  }, [paperKey, paper, job?.state, refresh]);

  // The library mirrors what is stored; it changes when a paper finishes arriving.
  useEffect(() => {
    if (paper === null) return;
    void loadLibrary();
  }, [paper?.status, loadLibrary]);

  // Load the PDF once the revision's bytes exist.
  useEffect(() => {
    if (paperKey === null || paper === null || !isReadable(paper.status)) return;
    const controller = new AbortController();
    void loadPdf(client.pdfUrl(paperKey), controller.signal)
      .then((loaded) => {
        setDoc(loaded);
        setPageCount(loaded.numPages);
      })
      .catch(() => {
        /* the bytes may still be arriving; the poll will retry */
      });
    return () => controller.abort();
  }, [paperKey, paper?.status]);

  // Read every page's native dimensions without rasterising it. Virtual Korean pages use
  // these same dimensions as measured pages and boundary calculations.
  useEffect(() => {
    intrinsic.current.clear();
    setKoreanHeights(new Map());
    setIntrinsicVersion((version) => version + 1);
    if (doc === null) return;
    let cancelled = false;
    void Promise.all(
      Array.from({ length: doc.numPages }, async (_, index) => [index + 1, intrinsicSize(await doc.getPage(index + 1))] as const),
    ).then((sizes) => {
      if (cancelled) return;
      for (const [page, size] of sizes) intrinsic.current.set(page, size);
      setIntrinsicVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // ------------------------------------------------------------ enter/leave

  /** Make `key` the paper being read, dropping every answer still in flight for the old one. */
  const enterPaper = useCallback((key: string) => {
    epoch.current += 1;
    paperKeyRef.current = key;
    snapshotRef.current = null;
    setPaperKey(key);
    setSnapshot(null);
    setDoc(null);
    setPageCount(0);
    setCurrentPage(1);
    setHighlights([]);
    setOpenHighlightId(null);
    setNarrowPane('source');
    setResetting(false);
    setReplacement(null);
    setChatOpen(false);
    setChatQuote(null);
    window.clearTimeout(koreanJump.current);
  }, []);

  /** Back to the library. Stored data stays; only this screen's view of it is dropped. */
  const leaveReader = useCallback(() => {
    epoch.current += 1;
    paperKeyRef.current = null;
    snapshotRef.current = null;
    setPaperKey(null);
    setSnapshot(null);
    setDoc(null);
    setPageCount(0);
    setCurrentPage(1);
    setHighlights([]);
    setOpenHighlightId(null);
    setResetting(false);
    setReplacement(null);
    setChatOpen(false);
    setChatQuote(null);
    window.clearTimeout(koreanJump.current);
  }, []);

  const openPaper = useCallback(async () => {
    const value = input.trim();
    if (value.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Opening a paper only downloads it; nothing is sent to the translator.
      const { paper: opened } = await client.openPaper(value);
      enterPaper(opened.paperKey);
      setInput('');
      await refresh(opened.paperKey);
      void loadLibrary();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }, [input, enterPaper, refresh, loadLibrary, fail]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const uploadPaper = useCallback(async (file: File) => {
    setBusy(true);
    setUploading(true);
    setError(null);
    try {
      const { paper: opened } = await client.uploadPaper(file);
      enterPaper(opened.paperKey);
      setInput('');
      await refresh(opened.paperKey);
      void loadLibrary();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
      setUploading(false);
    }
  }, [enterPaper, refresh, loadLibrary, fail]);

  /** A stored paper opens through the service: from disk when its extraction is current, or
   * re-extracted from the saved PDF when the format moved on — never re-downloaded. */
  const openStored = useCallback(
    async (key: string) => {
      setError(null);
      setBusy(true);
      try {
        const { paper: opened } = await client.openPaper(key);
        enterPaper(opened.paperKey);
        await refresh(opened.paperKey);
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [enterPaper, refresh, fail],
  );

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await run();
        const key = paperKeyRef.current;
        if (key !== null) await refresh(key);
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    },
    [refresh, fail],
  );

  const confirmDelete = useCallback(
    async (key: string) => {
      setDeleteConfirmation(null);
      await act(async () => {
        await client.deletePaper(key);
        if (paperKeyRef.current === key) leaveReader();
        await loadLibrary();
      });
    },
    [act, leaveReader, loadLibrary],
  );

  const savePaperTitle = useCallback(async (displayTitle: string | null) => {
    if (renameTarget === null) return;
    const updated = await client.renamePaper(renameTarget.paperKey, displayTitle);
    setPapers((stored) => stored.map((item) => item.paperKey === updated.paperKey ? updated : item));
    const current = snapshotRef.current;
    if (current?.paper.paperKey === updated.paperKey && paperKeyRef.current === updated.paperKey) {
      epoch.current += 1;
      applySnapshot({ ...current, paper: updated });
    }
    setRenameTarget(null);
  }, [renameTarget, applySnapshot]);

  // ---------------------------------------------------------------- account

  const startLogin = useCallback(async () => {
    setAccountBusy(true);
    setAccountError(null);
    try {
      const { attempt, loginUrl: url } = await client.startLogin();
      setLoginAttempt(attempt);
      setLoginUrl(url);
      // The official page opens in its own tab; if the browser blocks this, the same
      // address stays visible as a link in the panel.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setAccountError(extractError(cause));
      void refreshConnection();
    } finally {
      setAccountBusy(false);
    }
  }, [refreshConnection]);

  const cancelLogin = useCallback(async (loginId: string) => {
    setAccountBusy(true);
    setAccountError(null);
    try {
      const { attempt } = await client.cancelLogin(loginId);
      setLoginAttempt(attempt);
      setLoginUrl(null);
    } catch (cause) {
      setAccountError(extractError(cause));
    } finally {
      setAccountBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setAccountBusy(true);
    setAccountError(null);
    try {
      const result = await client.logout();
      setConnection(result.connection);
      setModelId('');
      setLoginAttempt(null);
      setLoginUrl(null);
      // A running job was paused by the service; show that, not a stale "running".
      if (paperKeyRef.current !== null) await refresh(paperKeyRef.current);
    } catch (cause) {
      setAccountError(extractError(cause));
    } finally {
      setAccountBusy(false);
      void refreshConnection();
    }
  }, [refresh, refreshConnection]);

  // While an attempt is pending, ask the service for its state; the official callback
  // lands in the service, never in this page.
  useEffect(() => {
    if (loginAttempt === null || loginAttempt.status !== 'pending') return;
    const loginId = loginAttempt.loginId;
    let cancelled = false;
    const tick = async () => {
      try {
        const { attempt } = await client.loginStatus(loginId);
        if (cancelled) return;
        setLoginAttempt(attempt);
        if (attempt.status !== 'pending') {
          setLoginUrl(null);
          void refreshConnection();
        }
      } catch (cause) {
        if (cancelled) return;
        // The service restarted and no longer knows the attempt: show the real state.
        if (extractError(cause).code === 'NOT_FOUND') {
          setLoginAttempt(null);
          setLoginUrl(null);
          void refreshConnection();
        }
      }
    };
    const timer = window.setInterval(() => void tick(), LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loginAttempt, refreshConnection]);

  // ---------------------------------------------------------------- restart

  const sendRestart = useCallback(
    async (pending: PendingRestart) => {
      epoch.current += 1;
      const mine = epoch.current;
      setResetting(true);
      setError(null);
      // From the confirmation onwards the old Korean pages are hidden; the service's answer
      // decides what comes back — never a locally kept copy of the old translation.
      setSnapshot((current) => (current !== null && current.paper.paperKey === pending.paperKey ? { ...current, translations: [], job: null } : current));
      try {
        await client.restartTranslation(pending.paperKey, {
          modelId: pending.modelId,
          requestId: pending.requestId,
          expectedJobId: pending.expectedJobId,
        });
        writePendingRestart(null);
      } catch (cause) {
        const failure = extractError(cause);
        // A definitive refusal ends the request; a retryable one is re-sent as-is next time.
        if (!failure.retryable) writePendingRestart(null);
        setError(failure);
      } finally {
        if (epoch.current === mine) {
          setResetting(false);
          if (paperKeyRef.current === pending.paperKey) await refresh(pending.paperKey);
        }
      }
    },
    [refresh],
  );

  // A restart confirmed before a reload is finished with the same request, never a new one.
  useEffect(() => {
    const pending = readPendingRestart();
    if (pending === null) return;
    enterPaper(pending.paperKey);
    void sendRestart(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestReplacement = useCallback(() => {
    if (paperKey === null || job === null || modelId === '') return;
    const oldTranslationExists = (snapshot?.translations ?? []).some((t) => t.status === 'completed');
    setReplacement({ modelId, oldTranslationExists });
  }, [paperKey, job, modelId, snapshot]);

  const confirmReplacement = useCallback(
    (chosenModelId: string) => {
      if (paperKey === null || job === null) return;
      const pending: PendingRestart = { paperKey, modelId: chosenModelId, requestId: newRequestId(), expectedJobId: job.jobId };
      writePendingRestart(pending);
      setReplacement(null);
      void sendRestart(pending);
    },
    [paperKey, job, sendRestart],
  );

  // ------------------------------------------------------------- highlights

  // Load the highlight list once per paper; never mixed with the snapshot poll.
  useEffect(() => {
    setHighlights([]);
    setOpenHighlightId(null);
    setAnnotationBusyId(null);
    setAnnotationError(null);
    if (paperKey === null) {
      return;
    }
    let cancelled = false;
    void client
      .listHighlights(paperKey)
      .then((loaded) => {
        if (!cancelled) setHighlights(loaded);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [paperKey, paper?.status, paper?.extractionVersion, fail]);

  const createAnnotation = useCallback(
    (input: AnnotationInput, openNote = false) => {
      if (paperKey === null) return;
      const key = paperKey;
      setAnnotationNotice('저장 중…');
      void client
        .createHighlight(key, input)
        .then((created) => {
          if (paperKeyRef.current !== key) return;
          setHighlights((list) => [...list, created]);
          setAnnotationNotice(input.kind === 'ink' ? '필기를 저장했습니다.' : '하이라이트를 저장했습니다.');
          if (openNote) setOpenHighlightId((current) => current === null ? created.highlightId : current);
        })
        .catch((cause) => { if (paperKeyRef.current === key) { setAnnotationNotice('저장하지 못했습니다.'); fail(cause); } });
    },
    [paperKey, fail],
  );

  const openHighlight = useCallback((highlight: Highlight) => {
    if (annotationBusyId !== null) return;
    if (annotationDirty) { setAnnotationNotice('작성 중인 메모를 먼저 저장하거나 닫아주세요.'); return; }
    setAnnotationError(null);
    setOpenHighlightId(highlight.highlightId);
  }, [annotationBusyId, annotationDirty]);

  const saveHighlight = useCallback(
    (note: string, color: Highlight['color']) => {
      if (paperKey === null || openHighlightId === null || annotationBusyId !== null) return;
      const id = openHighlightId;
      setAnnotationBusyId(id);
      setAnnotationError(null);
      void client
        .updateHighlight(paperKey, openHighlightId, { note: note.length === 0 ? null : note, color })
        .then((updated) => {
          if (paperKeyRef.current !== paperKey) return;
          setHighlights((list) => list.map((h) => (h.highlightId === updated.highlightId ? updated : h)));
          setOpenHighlightId((current) => current === id ? null : current);
          setAnnotationNotice('메모를 저장했습니다.');
        })
        .catch((cause) => { if (paperKeyRef.current === paperKey) setAnnotationError(extractError(cause).message); })
        .finally(() => { if (paperKeyRef.current === paperKey) setAnnotationBusyId(null); });
    },
    [paperKey, openHighlightId, annotationBusyId],
  );

  const removeHighlight = useCallback(() => {
    if (paperKey === null || openHighlightId === null || annotationBusyId !== null) return;
    const id = openHighlightId;
    setAnnotationBusyId(id);
    setAnnotationError(null);
    void client
      .deleteHighlight(paperKey, id)
      .then(() => {
        if (paperKeyRef.current !== paperKey) return;
        setHighlights((list) => list.filter((h) => h.highlightId !== id));
        setOpenHighlightId((current) => current === id ? null : current);
      })
      .catch((cause) => { if (paperKeyRef.current === paperKey) setAnnotationError(extractError(cause).message); })
      .finally(() => { if (paperKeyRef.current === paperKey) setAnnotationBusyId(null); });
  }, [paperKey, openHighlightId, annotationBusyId]);

  const openHighlightRecord = highlights.find((h) => h.highlightId === openHighlightId) ?? null;
  const eraseAnnotation = (id: string) => {
    const selected = highlights.find((highlight) => highlight.highlightId === id && highlight.kind === 'ink');
    if (paperKey === null || selected === undefined || pendingErases.current.has(id)) return;
    const key = paperKey;
    pendingErases.current.add(id);
    void client.deleteHighlight(key, id).then(() => {
      if (paperKeyRef.current !== key) return;
      setHighlights((list) => list.filter((highlight) => highlight.highlightId !== id));
      setErasedInk((history) => [...history.slice(-19), selected]);
      setOpenHighlightId((current) => current === id ? null : current);
      setAnnotationNotice('필기를 지웠습니다.');
    }).catch(fail).finally(() => pendingErases.current.delete(id));
  };
  const restoreErasedInk = () => {
    const last = erasedInk.at(-1);
    if (last === undefined || paperKey === null || restoringInk) return;
    const key = paperKey;
    const { highlightId, paperKey: _key, createdAt: _created, updatedAt: _updated, ...input } = last;
    setRestoringInk(true);
    void client.createHighlight(key, input).then((restored) => {
      if (paperKeyRef.current !== key) return;
      setHighlights((list) => [...list, restored]);
      setErasedInk((history) => history.filter((item) => item.highlightId !== highlightId));
      setAnnotationNotice('지운 필기를 복원했습니다.');
    }).catch(fail).finally(() => { if (paperKeyRef.current === key) setRestoringInk(false); });
  };
  useEffect(() => {
    setNotebookOpen(false);
    setAnnotationMode('select');
    setAnnotationNotice('');
    setErasedInk([]);
    setRestoringInk(false);
    setAnnotationDirty(false);
    pendingErases.current.clear();
  }, [paperKey]);

  useEffect(() => {
    if (annotationNotice === '' || annotationNotice === '저장 중…' || annotationNotice === '저장하지 못했습니다.') return;
    const timer = window.setTimeout(() => setAnnotationNotice(''), 4500);
    return () => window.clearTimeout(timer);
  }, [annotationNotice]);

  // ------------------------------------------------------- paragraph jumps

  const scrollPaneTo = useCallback((pane: Pane, top: number) => {
    const node = pane === 'source' ? pdfBody.current : textBody.current;
    if (node === null) return;
    // Mark the scroll as ours before it happens, so its echo never bounces back.
    beginProgrammaticScroll(link.current, pane, performance.now());
    node.scrollTo({ top });
  }, []);

  // ------------------------------------------------------------ scroll link

  const pageIntrinsicSize = useCallback((page: number) => intrinsic.current.get(page) ?? FALLBACK_INTRINSIC_SIZE, [intrinsicVersion]);

  const koreanPageBoundaries = useCallback(
    () =>
      pageBoundaries(pageCount, (page) => {
        return koreanPageHeight(koreanHeights.get(page), koreanPageFallbackHeight(pageIntrinsicSize(page), zoom));
      }),
    [koreanHeights, pageCount, pageIntrinsicSize, zoom],
  );

  /** Every page element of a pane, keyed by page: the source pane's from its registry, the
   * Korean pane's (drawn page or placeholder alike) from its `data-page` children. */
  const paneNodes = useCallback((pane: Pane): Map<number, HTMLElement> => {
    if (pane === 'source') return pageNodes.current;
    const nodes = new Map<number, HTMLElement>();
    for (const node of textBody.current?.querySelectorAll<HTMLElement>(':scope > [data-page]') ?? []) nodes.set(Number(node.dataset.page), node);
    return nodes;
  }, []);

  /** The page whose top has scrolled past the top of the pane. */
  const pageAtScroll = useCallback(
    (pane: Pane) => {
      const body = pane === 'source' ? pdfBody.current : textBody.current;
      if (body === null) return currentPage;
      let page = 1;
      for (const [candidate, node] of paneNodes(pane)) {
        const top = scrollTopForDescendant(node.getBoundingClientRect().top, body.getBoundingClientRect().top, body.scrollTop);
        if (top <= body.scrollTop + 1 && candidate > page) page = candidate;
      }
      return page;
    },
    [currentPage, paneNodes],
  );

  /** A Korean page's top as laid out now; the measured-height estimate only when it is not in
   * the pane at all. A stale estimate put the reader at the end of the previous page. */
  const koreanPageTop = useCallback(
    (page: number) => {
      const body = textBody.current;
      const node = paneNodes('translation').get(page);
      if (body === null || node === undefined) return pageTop(page, koreanPageBoundaries());
      return scrollTopForDescendant(node.getBoundingClientRect().top, body.getBoundingClientRect().top, body.scrollTop);
    },
    [koreanPageBoundaries, paneNodes],
  );

  const scrollKoreanToPage = useCallback((page: number) => scrollPaneTo('translation', koreanPageTop(page)), [koreanPageTop, scrollPaneTo]);

  const blocksById = useMemo(() => new Map((snapshot?.blocks ?? []).map((block) => [block.blockId, block] as const)), [snapshot?.blocks]);

  /**
   * Where the two panes show the same content right now, read from the laid-out pages: every
   * page's top and bottom edge in both panes, and on each drawn Korean page the top of every
   * paragraph and crop against where that block starts on the original page. A page shown as
   * the original image (or not drawn yet) maps edge to edge.
   */
  const scrollAnchors = useCallback((): ScrollAnchor[] => {
    const sourceBody = pdfBody.current;
    const koreanBody = textBody.current;
    if (sourceBody === null || koreanBody === null) return [];
    const sourceTop = sourceBody.getBoundingClientRect().top - sourceBody.scrollTop;
    const koreanTop = koreanBody.getBoundingClientRect().top - koreanBody.scrollTop;
    const koreanNodes = paneNodes('translation');
    const anchors: ScrollAnchor[] = [];
    for (const [page, sourceNode] of pageNodes.current) {
      const koreanNode = koreanNodes.get(page);
      if (koreanNode === undefined) continue;
      const source = sourceNode.getBoundingClientRect();
      const korean = koreanNode.getBoundingClientRect();
      const sourcePageTop = source.top - sourceTop;
      const koreanPageTopPx = korean.top - koreanTop;
      anchors.push({ source: sourcePageTop, translation: koreanPageTopPx }, { source: sourcePageTop + source.height, translation: koreanPageTopPx + korean.height });
      if (koreanNode.classList.contains('kr-source-only') || koreanNode.classList.contains('kr-placeholder')) continue;
      for (const element of koreanNode.querySelectorAll<HTMLElement>('[data-block-id]')) {
        const region = blocksById.get(element.dataset.blockId ?? '')?.regions.find((candidate) => candidate.page === page);
        if (region === undefined) continue;
        anchors.push({ source: sourcePageTop + region.y * source.height, translation: element.getBoundingClientRect().top - koreanTop });
      }
    }
    return orderedAnchors(anchors);
  }, [blocksById, paneNodes]);

  /**
   * Line for line: the content at the top of the pane being read is brought to the top of the
   * other pane, interpolated between the nearest shared anchors — not only when a page
   * boundary is crossed.
   */
  const alignFollower = useCallback(
    (leading: Pane) => {
      const following: Pane = leading === 'source' ? 'translation' : 'source';
      const from = leading === 'source' ? pdfBody.current : textBody.current;
      const to = following === 'source' ? pdfBody.current : textBody.current;
      if (from === null || to === null) return;
      const top = Math.max(0, mapScrollPosition(from.scrollTop, scrollAnchors(), leading));
      aligned.current = true;
      if (Math.abs(to.scrollTop - top) >= 1) scrollPaneTo(following, top);
    },
    [scrollAnchors, scrollPaneTo],
  );
  const alignFollowerRef = useRef(alignFollower);
  alignFollowerRef.current = alignFollower;

  const follow = useCallback(
    (pane: Pane) => {
      const decision = onUserScroll(link.current, pane, performance.now());
      setLeader(link.current.leader);
      if (!decision.follow || decision.target === null) return;
      setCurrentPage(pageAtScroll(pane));
      alignFollower(pane);
    },
    [alignFollower, pageAtScroll],
  );

  // Korean pages are drawn, re-measured and re-laid out as the reader moves and translations
  // arrive, and every time the shared anchors move with them. The pane that follows is brought
  // back in line at most once a frame; with nobody leading yet, the original leads.
  const realignFrame = useRef<number | null>(null);
  const realign = useCallback(() => {
    if (realignFrame.current !== null) return;
    realignFrame.current = window.requestAnimationFrame(() => {
      realignFrame.current = null;
      if (!aligned.current || !link.current.enabled) return;
      alignFollowerRef.current(link.current.leader ?? 'source');
    });
  }, []);
  useEffect(
    () => () => {
      if (realignFrame.current !== null) window.cancelAnimationFrame(realignFrame.current);
    },
    [],
  );

  // A Korean page above the reader re-measured and the pane kept its place by shifting its own
  // scroll position: that is not the reader scrolling, and must not take the lead.
  const onKoreanAdjustScroll = useCallback(() => {
    beginProgrammaticScroll(link.current, 'translation', performance.now());
  }, []);

  const onPdfScroll = useCallback(() => {
    follow('source');
  }, [follow]);

  const onTextScroll = useCallback(() => follow('translation'), [follow]);

  // ------------------------------------------------------------- registries

  const registerPage = useCallback((page: number, element: HTMLDivElement | null) => {
    if (element === null) pageNodes.current.delete(page);
    else pageNodes.current.set(page, element);
  }, []);

  const recordSize = useCallback((page: number, size: Size) => {
    const previous = intrinsic.current.get(page);
    intrinsic.current.set(page, size);
    if (previous?.width !== size.width || previous.height !== size.height) setIntrinsicVersion((version) => version + 1);
  }, []);

  // The Korean page's rendered height is not known ahead of time — translated text and
  // cropped figures decide it. The pane reports it here; the next stage uses it for the
  // Korean pane's own page-boundary math.
  const recordKoreanHeight = useCallback(
    (page: number, heightPx: number) => {
      setKoreanHeights((heights) => {
        if (heights.get(page) === heightPx) return heights;
        const next = new Map(heights);
        next.set(page, heightPx);
        return next;
      });
      realign();
    },
    [realign],
  );

  /** Every page of a pane as laid out now, in the pane's scroll coordinates. */
  const paneBoxes = useCallback(
    (pane: Pane): PageBox[] => {
      const body = pane === 'source' ? pdfBody.current : textBody.current;
      if (body === null) return [];
      const bodyTop = body.getBoundingClientRect().top;
      const boxes: PageBox[] = [];
      for (const [page, node] of paneNodes(pane)) {
        const rect = node.getBoundingClientRect();
        boxes.push({ page, top: scrollTopForDescendant(rect.top, bodyTop, body.scrollTop), height: rect.height });
      }
      return boxes;
    },
    [paneNodes],
  );

  /** The page at the top of a laid-out pane and how far into it; null for a pane not laid out. */
  const panePosition = useCallback(
    (pane: Pane): PagePosition | null => {
      const body = pane === 'source' ? pdfBody.current : textBody.current;
      if (body === null || body.clientHeight === 0) return null;
      return positionInPages(paneBoxes(pane), body.scrollTop);
    },
    [paneBoxes],
  );

  const changeZoom = useCallback(
    (delta: number) => {
      const previousZoom = zoomRef.current;
      const nextZoom = clampZoom(previousZoom + delta);
      if (nextZoom === previousZoom) return;
      // Every page grows or shrinks with the zoom while the scroll positions stay put, so the
      // reader's place is noted here (the first change of a burst counts) and put back below.
      if (zoomAnchor.current === null) zoomAnchor.current = { source: panePosition('source'), translation: panePosition('translation') };
      zoomRef.current = nextZoom;
      const scale = nextZoom / previousZoom;
      setKoreanHeights((heights) => new Map([...heights].map(([page, height]) => [page, height * scale])));
      setZoom(nextZoom);
    },
    [panePosition],
  );

  // After a zoom change, each pane goes back to the same page and the same share of it. The
  // original's pages already have their new size; the Korean pages are drawn again at the new
  // zoom and meanwhile hold their measured heights scaled with it, so their places come from
  // those. Browser scroll anchoring is off (styles.css), and no scroll event would fire for a
  // position that did not change — so the page readout and which pages are drawn are updated
  // here too.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    if (anchor === null) return;
    zoomAnchor.current = null;
    const leader = link.current.leader ?? 'source';
    const restore = (pane: Pane, position: PagePosition | null, boxes: PageBox[]) => {
      const body = pane === 'source' ? pdfBody.current : textBody.current;
      if (body === null || position === null) return;
      const top = scrollTopForPosition(position, boxes);
      if (top === null || Math.abs(body.scrollTop - top) < 1) return;
      beginProgrammaticScroll(link.current, pane, performance.now());
      body.scrollTop = top;
    };
    const koreanBoxes = () => koreanPageBoundaries().map((boundary) => ({ page: boundary.page, top: boundary.top, height: boundary.bottom - boundary.top }));
    // The leading pane last: its move is the one marked as ours while the other one's echo is
    // held back as not the leader's.
    for (const pane of leader === 'source' ? (['translation', 'source'] as const) : (['source', 'translation'] as const)) {
      restore(pane, anchor[pane], pane === 'source' ? paneBoxes('source') : koreanBoxes());
    }
    const page = anchor[leader]?.page ?? anchor.source?.page ?? anchor.translation?.page;
    if (page !== undefined) setCurrentPage(page);
  }, [zoom, koreanPageBoundaries, paneBoxes]);

  /** The zoom at which the current page's width fills the source pane, or null when unknown. */
  const fitZoom = useCallback((): number | null => {
    const body = pdfBody.current;
    if (body === null) return null;
    const size = intrinsic.current.get(currentPage) ?? intrinsic.current.get(1);
    if (size === undefined || size.width <= 0) return null;
    // Pane padding on both sides plus a hairline, so no horizontal scrollbar appears.
    const available = body.clientWidth - 24 - 2;
    return available <= 0 ? null : clampZoom(available / size.width);
  }, [currentPage]);

  /** Zoom so the current page's width fills the source pane, the usual reading default. */
  const fitWidth = useCallback(() => {
    const zoomToFit = fitZoom();
    if (zoomToFit !== null) changeZoom(zoomToFit - zoomRef.current);
  }, [changeZoom, fitZoom]);
  const fitWidthRef = useRef(fitWidth);
  fitWidthRef.current = fitWidth;

  // The first time a document's page sizes are known, start at fit-width rather than 100%.
  const fittedDoc = useRef<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (doc === null || fittedDoc.current === doc || intrinsic.current.size === 0) return;
    fittedDoc.current = doc;
    fitWidth();
  }, [doc, intrinsicVersion, fitWidth]);

  const selectKoreanBlock = useCallback(
    (block: Block, via: SelectVia) => {
      const page = blockPage(block);
      if (page === null) return;
      window.clearTimeout(koreanJump.current);
      const jump = () => {
        aligned.current = false;
        setCurrentPage(page);
        setNarrowPane('source');
        window.requestAnimationFrame(() => {
          const node = pageNodes.current.get(page);
          const body = pdfBody.current;
          if (node !== undefined && body !== null) {
            scrollPaneTo('source', scrollTopForDescendant(node.getBoundingClientRect().top, body.getBoundingClientRect().top, body.scrollTop));
          }
        });
      };
      const delay = paragraphJumpDelay(via, paneVisible(pdfBody.current));
      if (delay === 0) {
        jump();
        return;
      }
      // Only the Korean pane is shown and the jump would hide it: a double-click that selects a
      // word to quote must get its second click in first.
      koreanJump.current = window.setTimeout(() => {
        if (!selectionWithin(textBody.current)) jump();
      }, delay);
    },
    [scrollPaneTo],
  );
  useEffect(() => () => window.clearTimeout(koreanJump.current), []);

  const selectSourceBlock = useCallback(
    (block: Block) => {
      const page = blockPage(block);
      if (page === null) return;
      aligned.current = false;
      setCurrentPage(page);
      setNarrowPane('translation');
      window.requestAnimationFrame(() => scrollKoreanToPage(page));
    },
    [scrollKoreanToPage],
  );

  // Both panes go to the page's top, which is in line by definition.
  const goToPage = useCallback(
    (page: number) => {
      aligned.current = true;
      setCurrentPage(page);
      window.requestAnimationFrame(() => {
        const node = pageNodes.current.get(page);
        const body = pdfBody.current;
        if (node !== undefined && body !== null) {
          scrollPaneTo('source', scrollTopForDescendant(node.getBoundingClientRect().top, body.getBoundingClientRect().top, body.scrollTop));
        }
        scrollKoreanToPage(page);
      });
    },
    [scrollKoreanToPage, scrollPaneTo],
  );

  // A find result is shown in its pane: its page first while it is not drawn, then the result
  // itself, with the other pane brought in line.
  const revealFind = useCallback(
    (pane: Pane, page: number, top: number | null) => {
      setNarrowPane(pane);
      if (top === null) {
        goToPage(page);
        return;
      }
      scrollPaneTo(pane, top);
      setCurrentPage(pageAtScroll(pane));
      alignFollower(pane);
    },
    [alignFollower, goToPage, pageAtScroll, scrollPaneTo],
  );

  // ---------------------------------------------------------- question panel

  /**
   * Open or shut the question panel. The docked panel narrows the reading panes; a source page
   * that was fitted to its pane's width is fitted again once the panel has finished moving.
   */
  const showChat = useCallback(
    (open: boolean, reading?: Pane) => {
      const zoomToFit = fitZoom();
      const fitted = zoomToFit !== null && Math.abs(zoomToFit - zoomRef.current) < 0.005;
      if (open) {
        setNotebookOpen(false);
        setAnnotationMode('select');
        setChatMounted(true);
        // Beside the docked panel a cramped reader shows one pane (onePaneBesideChat): keep the
        // one being read — where the quote came from, else the one the reader last scrolled.
        if (paneVisible(pdfBody.current) && paneVisible(textBody.current)) {
          const keep = reading ?? link.current.leader;
          if (keep !== null) setNarrowPane(keep);
        }
      }
      setChatOpen(open);
      if (!open) {
        // Focus that sat in the panel goes back to the toggle instead of vanishing with it.
        const active = document.activeElement;
        if (active === null || active === document.body || chatDockRef.current?.contains(active) === true) chatButtonRef.current?.focus();
      }
      window.clearTimeout(refitTimer.current);
      if (fitted) refitTimer.current = window.setTimeout(() => fitWidthRef.current(), prefersReducedMotion() ? 0 : CHAT_TRANSITION_MS + 40);
    },
    [fitZoom],
  );
  useEffect(() => () => window.clearTimeout(refitTimer.current), []);

  const closeChat = useCallback(() => showChat(false), [showChat]);
  const toggleChat = useCallback(() => showChat(!chatOpen), [showChat, chatOpen]);

  /** The account menu, opened from the top bar or from the question panel. */
  const openAccountFrom = useCallback((element: HTMLElement | null, fromChat: boolean) => {
    accountOpener.current = { element, fromChat };
    setAccountOpen(true);
  }, []);
  const openAccount = useCallback(() => {
    const active = document.activeElement;
    openAccountFrom(active instanceof HTMLElement && active !== document.body ? active : null, true);
  }, [openAccountFrom]);

  /** Open the panel with `text` quoted into the question being written. */
  const askAbout = useCallback(
    (text: string, from: Pane) => {
      quoteCount.current += 1;
      setChatQuote({ id: quoteCount.current, text });
      if (!chatOpen) showChat(true, from);
    },
    [chatOpen, showChat],
  );
  const askAboutKorean = useCallback((text: string) => askAbout(text, 'translation'), [askAbout]);
  const askAboutSource = useCallback((text: string) => askAbout(text, 'source'), [askAbout]);

  // The reader's width decides whether two panes still fit beside the docked panel.
  useEffect(() => {
    const reader = readerRef.current;
    if (reader === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setReaderWidth(reader.clientWidth));
    observer.observe(reader);
    return () => observer.disconnect();
  }, [paperKey]);

  // Global keyboard shortcuts, skipped while the reader is typing or a dialog is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (keepsKeysToItself(target)) return;
      // The question panel scrolls and closes with its own keys.
      if (target !== null && typeof target.closest === 'function' && target.closest('.chat-dock') !== null) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        // A pending login is the panel's own Escape (it cancels); anything else just closes.
        if (accountOpen && (loginAttempt === null || loginAttempt.status !== 'pending')) {
          setAccountOpen(false);
          event.preventDefault();
          return;
        }
        // A panel control that was used went away (or was disabled) under the focus, which fell
        // to the page: Escape still closes the panel.
        if (!accountOpen && chatOpen && replacement === null && deleteConfirmation === null && renameTarget === null && (target === null || target === document.body)) {
          closeChat();
          event.preventDefault();
        }
        return;
      }
      if (accountOpen || replacement !== null || deleteConfirmation !== null || renameTarget !== null) return;
      switch (event.key) {
        case '+':
        case '=':
          changeZoom(CONTROL_LIMITS.zoom.step);
          break;
        case '-':
          changeZoom(-CONTROL_LIMITS.zoom.step);
          break;
        case 'PageDown':
          goToPage(nextPage(currentPage, 1, pageCount));
          break;
        case 'PageUp':
          goToPage(nextPage(currentPage, -1, pageCount));
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeZoom, currentPage, pageCount, goToPage, accountOpen, loginAttempt, replacement, deleteConfirmation, renameTarget, chatOpen, closeChat]);

  // ------------------------------------------------------------------ view

  const tone = connectionTone(connection);
  const deleteTarget = deleteConfirmation === null ? undefined : papers.find((p) => p.paperKey === deleteConfirmation) ?? (paper?.paperKey === deleteConfirmation ? paper : undefined);

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" aria-label="PaperRead 홈으로" onClick={() => { setAccountOpen(false); leaveReader(); }}>
          <span className="brand__mark" aria-hidden="true">
            Pr
          </span>
          <span className="brand__name">PaperRead</span>
        </button>
        <form
          className="open-form"
          onSubmit={(event) => {
            event.preventDefault();
            void openPaper();
          }}
        >
          <label htmlFor="arxiv-input" className="sr-only">
            논문 PDF/arXiv 주소 또는 arXiv 번호
          </label>
          <input
            id="arxiv-input"
            type="text"
            value={input}
            placeholder="논문 PDF 주소 또는 arXiv 번호"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !client.canMutate || input.trim().length === 0}>
            논문 열기
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            aria-label="첨부할 PDF 파일 선택"
            disabled={busy || !client.canMutate}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void uploadPaper(file);
            }}
          />
          <button type="button" disabled={busy || !client.canMutate} onClick={() => fileInputRef.current?.click()}>
            {uploading ? 'PDF 여는 중…' : 'PDF 첨부'}
          </button>
        </form>
        <div className="topbar__right">
          {paperKey !== null ? (
            <button type="button" onClick={leaveReader}>
              보관함
            </button>
          ) : null}
          <button
            ref={accountButtonRef}
            type="button"
            className="account-button"
            aria-haspopup="dialog"
            aria-expanded={accountOpen}
            disabled={connection === null}
            onClick={() => (accountOpen ? setAccountOpen(false) : openAccountFrom(null, false))}
          >
            <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
            <span>{connectionShortLabel(connection)}</span>
          </button>
        </div>
      </header>

      {accountOpen && connection !== null ? (
        <div className="popover-layer">
          <button type="button" className="popover-scrim" aria-label="계정 메뉴 닫기" tabIndex={-1} onClick={() => setAccountOpen(false)} />
          <div className="popover-anchor">
            <AccountPanel
              connection={connection}
              loginAttempt={loginAttempt}
              loginUrl={loginUrl}
              error={accountError}
              busy={accountBusy}
              onStartLogin={() => void startLogin()}
              onCancelLogin={(loginId) => void cancelLogin(loginId)}
              onLogout={() => void logout()}
              open
              onClose={() => setAccountOpen(false)}
              returnFocusRef={accountReturnRef}
            >
              <ModelPreferences connection={connection} busy={accountBusy} onSave={async (id) => {
                const value = await saveModelChoice(client, id);
                setConnection(value);
                setModelId(pickDefaultModel(value) ?? '');
              }} onRefresh={async () => {
                const value = await client.refreshModels();
                setConnection(value);
                setModelId((current) => value.modelIds.includes(current) ? current : (pickDefaultModel(value) ?? ''));
              }} />
            </AccountPanel>
          </div>
        </div>
      ) : null}

      {!client.canMutate ? (
        <div className="notice warn" role="alert">
          <span className="notice__text">이 화면은 로컬 서비스가 제공한 진입 문서가 아니어서 조작할 수 없습니다. 서비스가 알려준 주소로 다시 열어 주세요.</span>
        </div>
      ) : null}

      {error !== null ? (
        <div className="notice error" role="alert">
          <span className="notice__text">
            {error.message}
            {error.retryable ? ' 다시 시도할 수 있습니다.' : ''}
          </span>
          <button type="button" onClick={() => setError(null)} aria-label="알림 닫기">
            닫기
          </button>
        </div>
      ) : null}

      {paperKey === null ? (
        <main className="home">
          <div className="home__grid">
            <section className="home__hero" aria-labelledby="home-title">
              <p className="eyebrow">원문 옆에서 읽는 한국어 논문</p>
              <h1 id="home-title">논문을 열고, 의심되는 문장은 원문에서 바로 확인하세요.</h1>
              <p className="home__lead">왼쪽에는 원본 PDF, 오른쪽에는 같은 쪽의 한국어 지면이 나란히 놓입니다. 문단을 누르면 반대쪽의 같은 쪽으로 이동합니다.</p>
              <ol className="steps">
                <li>
                  <strong>논문 열기</strong>
                  위 입력란에 논문 주소나 arXiv 번호를 넣거나, PDF 첨부로 내 PC의 파일을 선택합니다. 번역을 시작하거나 질문을 보내기 전에는 논문 내용을 Codex로 보내지 않습니다.
                </li>
                <li>
                  <strong>Codex 로그인</strong>
                  오른쪽 위 계정 메뉴에서 본인 ChatGPT 구독으로 로그인합니다. PaperRead 전용 로그인이라 다른 곳의 Codex에는 영향이 없습니다.
                </li>
                <li>
                  <strong>번역 시작</strong>
                  쪽 단위로 번역되어 오른쪽 지면에 흘러 들어옵니다. 저장된 번역은 로그인 없이도 다시 읽을 수 있습니다.
                </li>
              </ol>
              <div className="home__connection" role="status">
                <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
                <p>
                  {connection === null
                    ? 'Codex 연결 상태를 확인하는 중입니다.'
                    : connection.status === 'subscription'
                      ? 'Codex 구독에 연결되어 있습니다. 논문을 열면 바로 번역을 시작할 수 있습니다.'
                      : (translationBlockedReason(connection, { status: 'ready' } as Paper) ?? '')}
                </p>
                {connection !== null && connection.status !== 'subscription' ? (
                  <button type="button" className="primary" onClick={() => openAccountFrom(null, false)}>
                    계정 메뉴 열기
                  </button>
                ) : null}
              </div>
            </section>
            <div className="home__library">
              {backgroundTranslation ? <BackgroundTranslation paper={backgroundTranslation.paper} initialJob={backgroundTranslation.job} client={client} onOpen={() => void openStored(backgroundTranslation.paper.paperKey)} /> : null}
              <LibraryPanel
                papers={papers}
                selectedPaperKey={null}
                deleteConfirmation={deleteConfirmation}
                onOpen={(key) => void openStored(key)}
                onRequestDelete={setDeleteConfirmation}
                onRequestRename={(key) => setRenameTarget(papers.find((item) => item.paperKey === key) ?? null)}
                onCancelDelete={() => setDeleteConfirmation(null)}
                onConfirmDelete={(key) => void confirmDelete(key)}
              />
            </div>
          </div>
        </main>
      ) : (
        <main className="reader-shell" style={{ '--chat-width': `${panelWidth}px` } as CSSProperties}>
          <ReaderToolbar
            paper={paper}
            job={job}
            blocks={snapshot?.blocks ?? []}
            translations={snapshot?.translations ?? []}
            onReadPage={(page) => { setNarrowPane('translation'); goToPage(page); }}
            selectedModelId={modelId}
            modelIds={connection?.modelIds ?? []}
            canTranslate={canTranslate}
            disabledReason={resetting ? '새로 번역을 준비하는 중입니다.' : blockedReason}
            replacement={replacement}
            modelNotice={preferredModelFallback(connection)}
            onModelChange={chooseModel}
            onStart={(chosen) => void act(() => client.startTranslation(paperKey, chosen))}
            onPause={(jobId) => void act(() => client.pauseJob(jobId))}
            onResume={(jobId) => void act(() => client.resumeJob(jobId))}
            onRetry={(jobId) => void act(() => client.retryJob(jobId))}
            onRequestReplacement={requestReplacement}
            onConfirmReplacement={confirmReplacement}
            onCancelReplacement={() => setReplacement(null)}
            hint={SEND_HINT}
            onRequestDelete={() => setDeleteConfirmation(paperKey)}
            chat={{ open: chatOpen, controls: CHAT_PANEL_ID, onToggle: toggleChat, buttonRef: chatButtonRef }}
          />

          <div className="reader-annotations">
            <AnnotationToolbar mode={annotationMode} onModeChange={setAnnotationMode} color={annotationColor} onColorChange={setAnnotationColor}
              eraserSize={eraserSize} onEraserSizeChange={setEraserSize}
              notebookOpen={notebookOpen} onToggleNotebook={() => { showChat(false); setNotebookOpen((open) => !open); }} />
            <div className="annotation-feedback"><span className="annotation-save-status" role="status">{annotationNotice || (annotationMode === 'pen' ? '그린 필기는 자동 저장됩니다.' : annotationMode === 'erase' ? '지울 필기 위를 드래그하세요.' : '글자를 선택해 하이라이트·메모·질문')}</span>
              {erasedInk.length > 0 ? <button type="button" className="annotation-restore" onClick={restoreErasedInk} disabled={restoringInk}>{restoringInk ? '복원 중…' : '지운 필기 복원'}</button> : null}</div>
          </div>

          <div className="reader-stage">
            {paper !== null && !readable ? (
              <div className="reader-status" role="status" inert={chatOpen && chatSheet}>
                <p className="eyebrow">{paper.paperKey}</p>
                <h2>{paperStatusLabel(paper)}</h2>
                {paper.status === 'fetching' || paper.status === 'extracting' ? (
                  <p>원문을 받아 문단을 뽑는 중입니다. 끝나면 이 자리에 원문과 한국어 지면이 나타납니다.</p>
                ) : (
                  <p>주소를 확인한 뒤 다시 열어 보거나, 다른 개정판을 시도해 주세요.</p>
                )}
              </div>
            ) : null}

            <div
              ref={readerRef}
              className={`reader narrow${onePane ? ' one-pane' : ''}${resetting ? ' resetting' : ''}`}
              hidden={paper !== null && !readable}
              // Covered by the panel's sheet on a narrow screen: out of reach until it closes.
              inert={(chatOpen || notebookOpen) && chatSheet}
            >
              <section className={`pane ${narrowPane === 'source' ? '' : 'hidden'}`} style={{ flex: `0 0 ${split * 100}%` }} aria-label="원본 PDF">
                <div className="pane-head pane-head--source">
                  <span className="pane-title">원본</span>
                  <div className="pane-tools" role="group" aria-label="확대 조절">
                    <button type="button" onClick={() => changeZoom(-CONTROL_LIMITS.zoom.step)} aria-label="축소">
                      축소 −
                    </button>
                    <span data-testid="zoom" className="pane-readout">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button type="button" onClick={() => changeZoom(CONTROL_LIMITS.zoom.step)} aria-label="확대">
                      확대 +
                    </button>
                    <button type="button" onClick={fitWidth} aria-label="폭 맞춤">
                      폭 맞춤
                    </button>
                  </div>
                  <div className="pane-tools" role="group" aria-label="쪽 이동">
                    <button type="button" onClick={() => goToPage(nextPage(currentPage, -1, pageCount))} aria-label="이전 쪽">
                      이전 쪽
                    </button>
                    <span data-testid="page" className="pane-readout">
                      {currentPage} / {pageCount || '?'}
                    </span>
                    <button type="button" onClick={() => goToPage(nextPage(currentPage, 1, pageCount))} aria-label="다음 쪽">
                      다음 쪽
                    </button>
                  </div>
                  <span className="pane-hint">드래그: 하이라이트 · 클릭: 한국어 같은 쪽으로</span>
                  <span className="pane-switch">
                    <button type="button" onClick={() => setNarrowPane('translation')}>
                      번역 보기
                    </button>
                  </span>
                </div>
                <PdfPages
                  doc={doc}
                  pageCount={pageCount}
                  currentPage={currentPage}
                  zoom={zoom}
                  blocks={snapshot?.blocks ?? []}
                  highlights={highlights}
                  pageIntrinsicSize={pageIntrinsicSize}
                  onSize={recordSize}
                  registerPage={registerPage}
                  bodyRef={pdfBody}
                  onScroll={onPdfScroll}
                  onSelectBlock={selectSourceBlock}
                  onCreateAnnotation={createAnnotation}
                  annotationMode={annotationMode}
                  annotationColor={annotationColor}
                  annotationEraserSize={eraserSize}
                  onAsk={askAboutSource}
                  onEraseAnnotation={eraseAnnotation}
                  onOpenHighlight={openHighlight}
                />
              </section>

              <button
                type="button"
                className="splitter"
                aria-label="분할 폭 조절"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') setSplit((s) => clampSplit(s - CONTROL_LIMITS.split.step));
                  if (event.key === 'ArrowRight') setSplit((s) => clampSplit(s + CONTROL_LIMITS.split.step));
                }}
                onPointerDown={(event) => {
                  const start = event.clientX;
                  const startSplit = split;
                  const width = event.currentTarget.parentElement?.clientWidth ?? 1;
                  const move = (e: PointerEvent) => setSplit(clampSplit(startSplit + (e.clientX - start) / width));
                  const up = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                }}
              />

              <section className={`pane ${narrowPane === 'translation' ? '' : 'hidden'}`} style={{ flex: '1 1 0' }} aria-label="한국어 번역">
                <div className="pane-head">
                  <span className="pane-title">한국어</span>
                  <span data-testid="leader" className="pane-readout pane-readout--wide">
                    {leaderLabel(leader)}
                  </span>
                  <span className="pane-hint">클릭: 원본 같은 쪽으로</span>
                  <span className="pane-switch">
                    <button type="button" onClick={() => setNarrowPane('source')}>
                      원본 보기
                    </button>
                  </span>
                </div>
                <KoreanPages
                  doc={doc}
                  pageCount={pageCount}
                  currentPage={currentPage}
                  zoom={zoom}
                  blocks={snapshot?.blocks ?? []}
                  translations={snapshot?.translations ?? []}
                  modelId={snapshot?.job?.modelId ?? null}
                  pageHeights={koreanHeights}
                  pageIntrinsicSize={pageIntrinsicSize}
                  onPageHeight={recordKoreanHeight}
                  bodyRef={textBody}
                  onScroll={onTextScroll}
                  onAdjustScroll={onKoreanAdjustScroll}
                  onSelectBlock={selectKoreanBlock}
                  highlights={highlights}
                  onCreateAnnotation={createAnnotation}
                  annotationMode={annotationMode}
                  annotationColor={annotationColor}
                  annotationEraserSize={eraserSize}
                  onOpenHighlight={openHighlight}
                  onAsk={askAboutKorean}
                  onEraseAnnotation={eraseAnnotation}
                />
              </section>
              <FindBar key={paperKey} doc={doc} pageCount={pageCount} blocks={snapshot?.blocks ?? []} translations={snapshot?.translations ?? []} modelId={snapshot?.job?.modelId ?? null}
                currentPage={currentPage} sourceBody={pdfBody} koreanBody={textBody} onReveal={revealFind} />
            </div>

            {(chatOpen || notebookOpen) && !chatSheet ? <PanelResizeHandle width={panelWidth} onResize={setPanelWidth} /> : null}
            {chatOpen ? <button type="button" className="chat-scrim" aria-label="질문 패널 닫기" tabIndex={-1} onClick={closeChat} /> : null}
            <aside
              ref={chatDockRef}
              id={CHAT_PANEL_ID}
              className={`chat-dock${chatOpen ? ' is-open' : ''}`}
              aria-label="논문 질문"
              // As a sheet it covers the reader, which is inert meanwhile; the toolbar above stays
              // reachable (it holds the toggle that closes the sheet), so the dialog is not modal.
              role={chatSheet && chatOpen ? 'dialog' : undefined}
            >
              <div className="chat-dock__inner">
                {chatMounted ? (
                  <ChatBoundary key={paperKey} open={chatOpen} onClose={closeChat}>
                    <Suspense fallback={<p className="chat-dock__loading">질문 창을 여는 중입니다.</p>}>
                      <ChatPanel
                        key={paperKey}
                        client={client}
                        paperKey={paperKey}
                        paper={paper}
                        connection={connection}
                        canMutate={client.canMutate}
                        preferredModelId={modelId}
                        onModelChange={chooseModel}
                        open={chatOpen}
                        quote={chatQuote}
                        onClose={closeChat}
                        onOpenAccount={openAccount}
                        onConnectionStale={refreshConnection}
                      />
                    </Suspense>
                  </ChatBoundary>
                ) : null}
              </div>
            </aside>
            {notebookOpen ? <>
              <button type="button" className="chat-scrim" aria-label="메모 모음 닫기" tabIndex={-1} onClick={() => setNotebookOpen(false)} />
              <aside className="chat-dock is-open notebook-dock" role={chatSheet ? 'dialog' : undefined} aria-label="메모 모음 패널" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setNotebookOpen(false); } }}>
                <div className="chat-dock__inner"><AnnotationNotebook highlights={highlights} translations={snapshot?.translations ?? []} blocks={snapshot?.blocks ?? []} modelId={snapshot?.job?.modelId ?? null}
                  onOpen={openHighlight} onClose={() => setNotebookOpen(false)} onNavigate={(highlight) => {
                    setNarrowPane(highlight.surface === 'translation' ? 'translation' : 'source');
                    if (chatSheet) setNotebookOpen(false);
                    goToPage(highlight.page);
                  }} /></div>
              </aside>
            </> : null}
          </div>

          {openHighlightRecord !== null ? <HighlightPopover key={openHighlightRecord.highlightId} highlight={openHighlightRecord}
            onDirtyChange={setAnnotationDirty}
            busy={annotationBusyId === openHighlightRecord.highlightId} error={annotationError}
            onSave={saveHighlight} onDelete={removeHighlight} onClose={() => setOpenHighlightId(null)}
            onAsk={openHighlightRecord.surface === 'translation' ? askAboutKorean : askAboutSource} /> : null}

          {deleteConfirmation !== null ? (
            <DeleteDialog paper={deleteTarget} paperKey={deleteConfirmation} onCancel={() => setDeleteConfirmation(null)} onConfirm={() => void confirmDelete(deleteConfirmation)} />
          ) : null}
        </main>
      )}
      {renameTarget !== null ? <RenamePaperDialog key={renameTarget.paperKey} paper={renameTarget} onCancel={() => setRenameTarget(null)} onSave={savePaperTitle} /> : null}
    </div>
  );
}

export default App;
