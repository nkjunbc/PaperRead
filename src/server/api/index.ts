import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { AppError, Block, Highlight, Job, LogoutResult, Paper, PaperChat, PaperListResult, Region, RestartTranslationRequest, Snapshot, Translation, Translator } from '../../shared/contracts';
import type { AccountSession } from '../codex/auth-contract';
import { PaperStore, appError, invalidInput, notFound } from '../store/index';
import { assertSafeKey } from '../store/validate';
import { JobManager } from '../jobs/state';
import { PROMPT_VERSION, TranslationPipeline, type PipelineLogEvent } from '../translation/index';
import { isExcludedModel } from '../codex/index';
import { EXTRACTION_VERSION } from '../pdf/index';
import { ChatService, LOGGED_OUT_ERROR, RESTARTED_ERROR, type ChatLogEvent } from '../chat/index';
import { HttpError, toHttp } from './errors';
import { TOKEN_HEADER, assertCredentialHeader, assertLocalRequest } from './guard';

export { TOKEN_HEADER, assertLocalRequest, isLoopbackHost, isLoopbackOrigin } from './guard';
export { HttpError, statusFor, toHttp } from './errors';

/** Loopback only. The service is never reachable from another machine. */
export const LOOPBACK = '127.0.0.1';

/** Largest JSON body the service will read; requests here are tiny by design. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * arXiv acquisition, injected so tests never touch the network.
 * `resolve` pins the revision synchronously inside the open request;
 * `acquire` downloads and extracts afterwards; `reextract` works only from
 * bytes already committed to local storage.
 */
export interface PaperAcquirer {
  /** The stored key an input names outright (an explicit revision), decided without any
   * network; null when the input must be resolved. */
  identify?(input: string): string | null;
  resolve(input: string): Promise<Paper>;
  acquire(paperKey: string, input: string): Promise<{ paper: Paper; blocks: Block[]; pdf: Buffer }>;
  reextract(paper: Paper, pdf: Buffer): Promise<{ paper: Paper; blocks: Block[] }>;
}

export type ApiLogEvent =
  | PipelineLogEvent
  | ChatLogEvent
  | { event: 'http'; route: string; method: string; status: number; code?: AppError['code'] }
  /** A tool item seen after its turn had settled: the official process was ended. */
  | { event: 'codex'; action: 'late-breach'; path: 'translation' | 'question'; code: 'UNSAFE_RUNTIME' };

export interface ApiServerOptions {
  store: PaperStore;
  jobs: JobManager;
  translator: Translator;
  /** Official login/logout for this app's own session. Deliberately not the translator:
   * the generation path never gains account methods. */
  session: AccountSession;
  pipeline: TranslationPipeline;
  acquirer: PaperAcquirer;
  /** The official program's question path for the reader's paper questions. Kept apart from
   * the translator and from the account session: it never gains account methods. */
  paperChat: PaperChat;
  log?: (event: ApiLogEvent) => void;
  /** Overridable for tests; production mints a fresh 256-bit credential. */
  token?: string;
  /**
   * The client entry document. The service injects the request credential into
   * it, which is the only way the local page ever learns the token — it is
   * never returned by an API route and never written to disk.
   */
  clientHtml?: () => string;
  /** Serves built client assets under /assets/*. Returns null when the name is
   * unknown; the implementation owns path containment. */
  clientAssets?: (segments: string[]) => Promise<{ body: Buffer; contentType: string } | null>;
}

export interface ApiServer {
  readonly token: string;
  readonly recovered: string[];
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  address(): AddressInfo | null;
  /** The HTML snippet that hands the credential to the local client page. */
  clientBootstrap(): string;
}

/**
 * Escape the characters that let a JSON body be reinterpreted as markup or
 * script when something embeds it in a page. The payload itself is unchanged
 * after JSON.parse — these are all valid JSON string escapes.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      default:
        return '\\u2029';
    }
  });
}

function baseHeaders(): Record<string, string> {
  return {
    // The API returns data only; nothing here may ever be treated as a document.
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

/** Decode one path segment and prove it is a storable paperKey, never a path. */
function readPaperKey(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidInput('paperKey 형식이 올바르지 않습니다.');
  }
  // assertSafeKey rejects separators, dot segments, NULs and anything outside [A-Za-z0-9._-].
  assertSafeKey(decoded);
  return decoded;
}

function readJobId(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidInput('jobId 형식이 올바르지 않습니다.');
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(decoded)) throw invalidInput('jobId 형식이 올바르지 않습니다.');
  return decoded;
}

function readHighlightId(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidInput('highlightId 형식이 올바르지 않습니다.');
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(decoded)) throw invalidInput('highlightId 형식이 올바르지 않습니다.');
  return decoded;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** App-issued login attempt ids are UUIDs; anything else never reaches the session. */
function readLoginId(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidInput('loginId 형식이 올바르지 않습니다.');
  }
  if (!UUID.test(decoded)) throw invalidInput('loginId 형식이 올바르지 않습니다.');
  return decoded;
}

function requireRequestId(body: Record<string, unknown>): string {
  const value = body.requestId;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalidInput('requestId 값은 UUID여야 합니다.');
  return value;
}

function requireJobIdField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value)) throw invalidInput(`${field} 형식이 올바르지 않습니다.`);
  return value;
}

/** Path words kept verbatim in the request log; every other segment is an identifier. */
const ROUTE_WORDS = new Set(['api', 'papers', 'open', 'pdf', 'translation', 'restart', 'highlights', 'chat', 'jobs', 'pause', 'resume', 'connection', 'login', 'logout', 'cancel', 'assets', 'index.html']);

function requireInt(body: Record<string, unknown>, field: string, min: number): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalidInput(`${field} 값은 ${min} 이상의 정수여야 합니다.`);
  }
  return value;
}

const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

function readHighlightColor(body: Record<string, unknown>, fallback: HighlightColor): HighlightColor {
  const value = body.color;
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(HIGHLIGHT_COLORS as readonly string[]).includes(value)) {
    throw invalidInput('color 값이 올바르지 않습니다.');
  }
  return value as HighlightColor;
}

function hasControlChars(text: string, allowNewline: boolean): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (allowNewline && code === 10) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requireHighlightText(body: Record<string, unknown>): string {
  const value = body.text;
  if (typeof value !== 'string' || value.length === 0) throw invalidInput('text 값은 비어 있지 않은 문자열이어야 합니다.');
  if (value.length > 2000) throw invalidInput('text 값이 너무 깁니다.');
  if (hasControlChars(value, false)) throw invalidInput('text 값에 제어 문자를 넣을 수 없습니다.');
  return value;
}

function readOptionalNote(body: Record<string, unknown>): string | null | undefined {
  if (!('note' in body)) return undefined;
  const value = body.note;
  if (value === null) return null;
  if (typeof value !== 'string') throw invalidInput('note 값은 문자열이나 null이어야 합니다.');
  if (value.length > 5000) throw invalidInput('note 값이 너무 깁니다.');
  if (hasControlChars(value, true)) throw invalidInput('note 값에 제어 문자를 넣을 수 없습니다.');
  return value;
}

function requireHighlightRects(body: Record<string, unknown>, page: number): Region[] {
  const value = body.rects;
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw invalidInput('rects 값은 1~200개의 배열이어야 합니다.');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw invalidInput('rect는 객체여야 합니다.');
    const r = entry as Partial<Region>;
    if (r.page !== page) throw invalidInput('모든 rect의 page가 같아야 합니다.');
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      const v = r[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw invalidInput(`rect.${field} 값은 [0,1] 비율이어야 합니다.`);
      }
    }
    if ((r.width as number) <= 0 || (r.height as number) <= 0) throw invalidInput('rect의 width/height는 0보다 컴야 합니다.');
    return { page: r.page as number, x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw appError('TOO_LARGE', '요청 본문이 너무 큽니다.', false);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalidInput('요청 본문이 올바른 JSON이 아닙니다.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidInput('요청 본문은 JSON 객체여야 합니다.');
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string, max = 512): string {
  const value = body[field];
  if (typeof value !== 'string') throw invalidInput(`${field} 값은 문자열이어야 합니다.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalidInput(`${field} 값이 비어 있습니다.`);
  if (trimmed.length > max) throw invalidInput(`${field} 값이 너무 깁니다.`);
  return trimmed;
}

/**
 * Insert the credential meta tag into the client entry document.
 *
 * The token is hex (`[0-9a-f]{64}`), so it cannot terminate the attribute or
 * open a tag; the surrounding document is the app's own file, not user input.
 */
export function injectToken(html: string, token: string): string {
  if (!/^[0-9a-f]+$/i.test(token)) throw appError('INTERNAL', '요청 자격 형식이 올바르지 않습니다.', false);
  const meta = `<meta name="paperread-token" content="${token}">`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : `${meta}${html}`;
}

/**
 * The local HTTP service the browser talks to.
 *
 * Every JSON answer is `{data}` or `{error}`. Reads have no side effects.
 * State changes require a loopback Host, a loopback Origin and the startup
 * credential (see guard.ts). Nothing is ever rendered as HTML here.
 */
export function createApiServer(options: ApiServerOptions): ApiServer {
  const { store, jobs, translator, session, pipeline, acquirer } = options;
  const log = options.log ?? (() => {});
  const token = options.token ?? randomBytes(32).toString('hex');
  const recovered: string[] = [];
  // Questions share the translator's account check: one live connection, one catalogue.
  const chat = new ChatService({ store, chat: options.paperChat, connection: () => translator.connection(), log });
  /** Per-revision identities for background acquisition/extraction work. */
  const acquiring = new Map<string, number>();
  let nextAcquisition = 0;

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  function send(response: ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(safeJson(payload), 'utf8');
    response.writeHead(status, {
      ...baseHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
    });
    response.end(body);
  }

  function sendError(response: ServerResponse, status: number, error: AppError): void {
    send(response, status, { error });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    let route = 'unknown';
    try {
      const url = new URL(request.url ?? '/', `http://${LOOPBACK}`);
      const segments = url.pathname.split('/').filter((s) => s.length > 0);
      route = `${method} /${segments.map((s) => (ROUTE_WORDS.has(s) ? s : ':id')).join('/')}`;

      const mutating = method !== 'GET' && method !== 'HEAD';
      assertLocalRequest(request, token, mutating);

      const result = await route_(method, segments, request);
      if (result.kind === 'json') {
        send(response, result.status, { data: result.data });
      } else {
        const headers = { ...baseHeaders() };
        // The entry document must load its own script; the API CSP forbids everything.
        if (result.contentType.startsWith('text/html')) {
          headers['content-security-policy'] = "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";
        }
        response.writeHead(result.status, {
          ...headers,
          'content-type': result.contentType,
          'content-length': String(result.body.length),
          'content-disposition': 'inline',
        });
        response.end(result.body);
      }
      log({ event: 'http', route, method, status: result.status });
    } catch (cause) {
      const { status, error } = toHttp(cause);
      sendError(response, status, error);
      log({ event: 'http', route, method, status, code: error.code });
    }
  }

  type Result =
    | { kind: 'json'; status: number; data: unknown }
    | { kind: 'bytes'; status: number; body: Buffer; contentType: string };

  const json = (data: unknown, status = 200): Result => ({ kind: 'json', status, data });

  async function route_(method: string, segments: string[], request: IncomingMessage): Promise<Result> {
    // The client entry document, with the request credential embedded.
    if (options.clientHtml !== undefined && method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html'))) {
      const html = injectToken(options.clientHtml(), token);
      return { kind: 'bytes', status: 200, body: Buffer.from(html, 'utf8'), contentType: 'text/html; charset=utf-8' };
    }
    if (segments[0] !== 'api') {
      // Built client assets (/assets/*). Without this the entry document's
      // <script src="/assets/…"> 404s and the app never loads. Read-only,
      // confined to the configured directory, and never a directory listing.
      if (options.clientAssets !== undefined && method === 'GET' && segments.length >= 2 && segments[0] === 'assets') {
        const asset = await options.clientAssets(segments.slice(1));
        if (asset === null) throw notFound('없는 파일입니다.');
        return { kind: 'bytes', status: 200, body: asset.body, contentType: asset.contentType };
      }
      throw notFound('없는 경로입니다.');
    }

    // ------------------------------------------------------------- connection
    if (segments[1] === 'connection') {
      if (segments.length === 2 && method === 'GET') return json(await translator.connection());
      if (segments.length === 3 && segments[2] === 'login' && method === 'POST') {
        // The official program performs the login; this only starts it and hands back the
        // official HTTPS address. No password, cookie or token ever passes through here.
        return json(await locked(() => session.startLogin()));
      }
      if (segments.length === 4 && segments[2] === 'login' && method === 'GET') {
        // A login attempt is per-session state: even this read needs the page credential.
        assertCredentialHeader(request, token);
        return json(await session.getLogin(readLoginId(segments[3])));
      }
      if (segments.length === 5 && segments[2] === 'login' && segments[4] === 'cancel' && method === 'POST') {
        return json(await locked(() => session.cancelLogin(readLoginId(segments[3]))));
      }
      if (segments.length === 3 && segments[2] === 'logout' && method === 'POST') {
        return json(await logout());
      }
      throw notFound('없는 경로입니다.');
    }

    // ----------------------------------------------------------------- papers
    if (segments[1] === 'papers') {
      if (segments.length === 2 && method === 'GET') return json(listPapers());
      if (segments.length === 3 && segments[2] === 'open' && method === 'POST') {
        // 'open' is a reserved action word, never a paperKey.
        return json({ paper: await openPaper(await readJsonBody(request)) });
      }
      if (segments.length >= 3) {
        const paperKey = readPaperKey(segments[2]);

        if (segments.length === 3 && method === 'GET') return json(snapshot(paperKey));
        if (segments.length === 3 && method === 'DELETE') {
          if (store.getPaper(paperKey) === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
          // The question answer stops (written as stopped, in case the removal fails) and its
          // official thread is dropped while the stored conversation id can still be read; the
          // folder removal then takes the conversation.
          chat.forgetPaper(paperKey);
          // Bumping the generation first makes every in-flight answer stale.
          jobs.deletePaperAndJobs(paperKey);
          // A late acquirer/re-extractor may not recreate this deleted revision.
          acquiring.delete(paperKey);
          pipeline.abortAll();
          return json({ deleted: true });
        }
        if (segments.length === 4 && segments[3] === 'pdf' && method === 'GET') {
          if (store.getPaper(paperKey) === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
          const bytes = store.getPdf(paperKey);
          // Still fetching: the revision exists but its bytes do not yet.
          if (bytes === null) throw notFound('아직 원본 PDF를 가져오지 않았습니다.');
          return { kind: 'bytes', status: 200, body: bytes, contentType: 'application/pdf' };
        }
        if (segments.length === 4 && segments[3] === 'translation' && method === 'POST') {
          const body = await readJsonBody(request);
          return json({ job: await startTranslation(paperKey, requireString(body, 'modelId', 100)) });
        }
        if (segments.length === 5 && segments[3] === 'translation' && segments[4] === 'restart' && method === 'POST') {
          const body = await readJsonBody(request);
          return json({ job: await restartTranslation(paperKey, body) });
        }
        if (segments.length === 4 && segments[3] === 'highlights' && method === 'GET') {
          if (store.getPaper(paperKey) === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
          return json(store.listHighlights(paperKey));
        }
        if (segments.length === 4 && segments[3] === 'highlights' && method === 'POST') {
          const body = await readJsonBody(request);
          return json(createHighlight(paperKey, body), 201);
        }
        if (segments.length === 5 && segments[3] === 'highlights' && method === 'PATCH') {
          const highlightId = readHighlightId(segments[4]);
          const body = await readJsonBody(request);
          return json(updateHighlight(paperKey, highlightId, body));
        }
        if (segments[3] === 'chat') {
          // Reads carry no credential and never write; asking, stopping and starting over pass
          // the state-change guard like every other mutation. The answer is written in the background: asking
          // returns 202 with the question stored and the answer in progress.
          if (segments.length === 4 && method === 'GET') return json({ conversation: chat.conversation(paperKey) });
          if (segments.length === 4 && method === 'POST') {
            const body = await readJsonBody(request);
            // Serialized with logins, logouts and job starts: a question admitted before a logout
            // never starts on the session that logout is ending.
            return json({ conversation: await locked(() => chat.ask(paperKey, body)) }, 202);
          }
          if (segments.length === 5 && segments[4] === 'cancel' && method === 'POST') return json({ conversation: chat.cancel(paperKey) });
          if (segments.length === 4 && method === 'DELETE') return json({ conversation: chat.clear(paperKey) });
          throw notFound('없는 경로입니다.');
        }
        if (segments.length === 5 && segments[3] === 'highlights' && method === 'DELETE') {
          const highlightId = readHighlightId(segments[4]);
          if (store.getPaper(paperKey) === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
          if (!store.deleteHighlight(paperKey, highlightId)) throw notFound(`하이라이트를 찾을 수 없습니다: ${highlightId}`);
          return json({ deleted: true });
        }
      }
      throw notFound('없는 경로입니다.');
    }

    // ------------------------------------------------------------------- jobs
    if (segments[1] === 'jobs' && segments.length >= 3) {
      const jobId = readJobId(segments[2]);
      const existing = jobs.getJob(jobId);
      if (existing === null) throw notFound(`작업을 찾을 수 없습니다: ${jobId}`);

      if (segments.length === 3 && method === 'GET') {
        return json({ job: existing, translations: store.listTranslations(existing.paperKey) });
      }
      if (segments.length === 4 && segments[3] === 'pause' && method === 'POST') {
        // Idempotent: pausing an already paused job just reports it.
        // Persist the pause *before* aborting, so the loop's post-request guard
        // already sees a non-running job and discards the in-flight answer.
        const job = existing.state === 'running' ? jobs.pauseJob(jobId, 'user') : existing;
        pipeline.abort(jobId);
        return json({ job });
      }
      if (segments.length === 4 && segments[3] === 'resume' && method === 'POST') {
        // A job stored before a model became forbidden must not resume on it.
        if (isExcludedModel(existing.modelId)) {
          throw appError('MODEL_UNAVAILABLE', '이 작업은 사용하지 않도록 설정된 모델로 만들어져 재개할 수 없습니다.', false);
        }
        const job = await locked(async () => {
          const current = jobs.getJob(jobId) ?? existing;
          if (current.state === 'running') return current;
          // Refused before the record changes: a resume while signed out would only create
          // a running job that pauses itself on its first request.
          await assertAccountReady(null);
          // A previous loop may still be unwinding after its abort.
          await settleLoop(jobId);
          // resumeJob keeps the revision's pinned model and prompt version.
          const resumed = jobs.resumeJob(jobId);
          drive(resumed);
          return resumed;
        });
        return json({ job });
      }
    }

    throw notFound('없는 경로입니다.');
  }

  function snapshot(paperKey: string): Snapshot {
    const paper = store.getPaper(paperKey);
    if (paper === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
    return {
      paper,
      blocks: store.listBlocks(paperKey),
      translations: store.listTranslations(paperKey),
      job: store.getJobForPaper(paperKey),
    };
  }

  /** A revision already on disk is reused verbatim only when its extraction format matches.
   * Empty blocks indicate an invalid/torn prior extraction. */
  function isCurrentExtraction(stored: Paper): boolean {
    return (
      (stored.status === 'ready' || stored.status === 'partial') &&
      stored.extractionVersion === EXTRACTION_VERSION &&
      store.listBlocks(stored.paperKey).length > 0
    );
  }

  /**
   * Pin the revision inside the request (so the caller gets a real paperKey and
   * version back), then download and extract in the background. Opening a paper
   * never sends anything to the translation provider.
   */
  async function openPaper(body: Record<string, unknown>): Promise<Paper> {
    const input = requireString(body, 'input');
    // An explicit revision already on disk never asks arXiv anything: in the current format it
    // opens as stored, and in an older one it is re-extracted from its saved PDF below. No
    // metadata request, no download — the library stays usable offline.
    const known = acquirer.identify?.(input) ?? null;
    if (known !== null) assertSafeKey(known);
    const onDisk = known === null ? null : store.getPaper(known);
    if (onDisk !== null && isCurrentExtraction(onDisk)) return onDisk;
    const resolved = onDisk !== null && store.getPdf(onDisk.paperKey) !== null ? onDisk : await acquirer.resolve(input);
    assertSafeKey(resolved.paperKey);

    const stored = store.getPaper(resolved.paperKey);
    if (stored !== null && isCurrentExtraction(stored)) return stored;

    const storedPdf = stored === null ? null : store.getPdf(stored.paperKey);
    let carried: Translation[] = [];
    if (storedPdf !== null) {
      // Finished translations survive the re-extraction wherever the paragraph text did not
      // change (same source hash); they are re-attached to the new block ids afterwards.
      carried = store.listTranslations(stored!.paperKey).filter((t) => t.status === 'completed');
      // Block identity is changing. The old job must not be replayed for the
      // replacement blocks, and its in-flight result must become stale.
      const invalidated = jobs.invalidateForReextraction(stored!.paperKey);
      if (invalidated !== null) pipeline.abort(invalidated.jobId);
    }
    const pending = store.savePaper({ ...(storedPdf === null ? resolved : stored!), status: 'fetching' });
    if (!acquiring.has(pending.paperKey)) {
      const acquisition = ++nextAcquisition;
      acquiring.set(pending.paperKey, acquisition);
      if (storedPdf === null) void acquireInBackground(pending.paperKey, input, acquisition);
      else void reextractInBackground(pending.paperKey, storedPdf, acquisition, carried);
    }
    return pending;
  }

  function isCurrentAcquisition(paperKey: string, acquisition: number): boolean {
    return acquiring.get(paperKey) === acquisition && store.getPaper(paperKey) !== null;
  }

  function finishAcquisition(paperKey: string, acquisition: number): void {
    if (acquiring.get(paperKey) === acquisition) acquiring.delete(paperKey);
  }

  async function acquireInBackground(paperKey: string, input: string, acquisition: number): Promise<void> {
    try {
      const beforeExtraction = store.getPaper(paperKey);
      if (!isCurrentAcquisition(paperKey, acquisition) || beforeExtraction === null) return;
      store.savePaper({ ...beforeExtraction, status: 'extracting' });
      const { paper, blocks, pdf } = await acquirer.acquire(paperKey, input);
      if (!isCurrentAcquisition(paperKey, acquisition)) return;
      store.savePaper(paper, pdf);
      if (!isCurrentAcquisition(paperKey, acquisition)) return;
      store.saveBlocks(paperKey, blocks);
    } catch (cause) {
      const { error } = toHttp(cause);
      const current = store.getPaper(paperKey);
      if (current !== null && isCurrentAcquisition(paperKey, acquisition)) {
        store.savePaper({
          ...current,
          status: error.code === 'UNSUPPORTED_PDF' ? 'unsupported' : 'failed',
          // ready/partial require full metadata; a failure must not claim any.
          pdfSha256: null,
          pageCount: null,
          extractionVersion: null,
          coverage: null,
        });
      }
      log({ event: 'http', route: 'acquire', method: 'BACKGROUND', status: 0, code: error.code });
    } finally {
      finishAcquisition(paperKey, acquisition);
    }
  }

  async function reextractInBackground(paperKey: string, pdf: Buffer, acquisition: number, carried: Translation[] = []): Promise<void> {
    try {
      const current = store.getPaper(paperKey);
      if (current === null || !isCurrentAcquisition(paperKey, acquisition)) return;
      store.savePaper({ ...current, status: 'extracting' });
      const { paper, blocks } = await acquirer.reextract(current, pdf);
      if (!isCurrentAcquisition(paperKey, acquisition)) return;
      store.savePaper(paper);
      if (!isCurrentAcquisition(paperKey, acquisition)) return;
      store.saveBlocks(paperKey, blocks);
      // The same source hash is the same sentence: its finished translation is kept under the
      // new block id, so a format change never re-sends what was already translated.
      const byHash = new Map(carried.map((t) => [t.sourceHash, t] as const));
      const kept: Translation[] = [];
      for (const block of blocks) {
        if (!block.translatable) continue;
        const previous = byHash.get(block.sourceHash);
        if (previous === undefined) continue;
        if (!isCurrentAcquisition(paperKey, acquisition)) return;
        kept.push(store.saveTranslation(paperKey, { ...previous, blockId: block.blockId }));
      }
      // The revision stays pinned to the model that made what it kept: a new job on that model
      // waits, paused, for the user to translate the paragraphs that are still missing.
      const pins = new Set(kept.map((t) => `${t.modelId}\n${t.promptVersion}`));
      if (kept.length > 0 && pins.size === 1 && isCurrentAcquisition(paperKey, acquisition)) {
        jobs.adoptCarriedTranslations(paperKey, kept[0]!.modelId, kept[0]!.promptVersion);
      }
    } catch (cause) {
      const { error } = toHttp(cause);
      const current = store.getPaper(paperKey);
      if (current !== null && isCurrentAcquisition(paperKey, acquisition)) {
        store.savePaper({
          ...current,
          status: error.code === 'UNSUPPORTED_PDF' ? 'unsupported' : 'failed',
          pdfSha256: null,
          pageCount: null,
          extractionVersion: null,
          coverage: null,
        });
      }
      log({ event: 'http', route: 'reextract', method: 'BACKGROUND', status: 0, code: error.code });
    } finally {
      finishAcquisition(paperKey, acquisition);
    }
  }

  /**
   * Create a highlight from a selection drag. `page` must be within the
   * stored paper's pageCount, and every rect must share that page.
   */
  function createHighlight(paperKey: string, body: Record<string, unknown>): Highlight {
    const paper = store.getPaper(paperKey);
    if (paper === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
    const page = requireInt(body, 'page', 1);
    if (paper.pageCount === null || page > paper.pageCount) {
      throw invalidInput(`page 값이 논문의 쪽 수를 벗어납니다: ${page}`);
    }
    const now = new Date().toISOString();
    const highlight: Highlight = {
      highlightId: randomUUID(),
      paperKey,
      page,
      rects: requireHighlightRects(body, page),
      text: requireHighlightText(body),
      color: readHighlightColor(body, 'yellow'),
      note: null,
      createdAt: now,
      updatedAt: now,
    };
    return store.saveHighlight(paperKey, highlight);
  }

  /** Update a highlight's note and/or color. Nothing else may change after creation. */
  function updateHighlight(paperKey: string, highlightId: string, body: Record<string, unknown>): Highlight {
    if (store.getPaper(paperKey) === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
    const existing = store.getHighlight(paperKey, highlightId);
    if (existing === null) throw notFound(`하이라이트를 찾을 수 없습니다: ${highlightId}`);
    const note = readOptionalNote(body);
    const updated: Highlight = {
      ...existing,
      note: note === undefined ? existing.note : note,
      color: readHighlightColor(body, existing.color),
      updatedAt: new Date().toISOString(),
    };
    return store.saveHighlight(paperKey, updated);
  }

  /**
   * Account changes and job starts never interleave. A logout that finished before a start
   * is what that start observes, and a start can never slip in between a logout's pause and
   * its official sign-out; the same serial order protects a restart against both.
   */
  let serial: Promise<unknown> = Promise.resolve();
  function locked<T>(task: () => Promise<T>): Promise<T> {
    const run = serial.then(task, task);
    serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The account gate every generation entry point shares, checked before any job record
   * changes: a signed-out start would otherwise create a running job that only pauses
   * itself on its first request. `modelId` is checked against the live catalogue when a
   * fresh job is about to pin it; a resume keeps its pinned model and passes null.
   */
  async function assertAccountReady(modelId: string | null): Promise<void> {
    const connection = await translator.connection();
    switch (connection.status) {
      case 'missing':
        throw appError('AUTH_REQUIRED', 'Codex CLI를 찾을 수 없습니다. 설치한 뒤 다시 시도해 주세요.', false);
      case 'signed_out':
        throw appError('AUTH_REQUIRED', 'Codex 구독에 로그인해야 번역을 시작할 수 있습니다.', false);
      case 'api_key':
        throw appError('SUBSCRIPTION_REQUIRED', 'API 키 연결로는 번역하지 않습니다. ChatGPT 구독으로 로그인해 주세요.', false);
      case 'unavailable':
        throw appError('NETWORK', 'Codex 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', true);
      default:
        break;
    }
    if (modelId !== null && !connection.modelIds.includes(modelId)) {
      throw appError('MODEL_UNAVAILABLE', '선택한 모델을 지금 사용할 수 없습니다. 다른 모델을 선택해 주세요.', false);
    }
  }

  function requireReadablePaper(paperKey: string): Paper {
    const paper = store.getPaper(paperKey);
    if (paper === null) throw notFound(`저장된 논문이 없습니다: ${paperKey}`);
    if (paper.status !== 'ready' && paper.status !== 'partial') throw invalidInput('아직 번역할 수 없는 논문입니다.');
    return paper;
  }

  /** Start (or rejoin) the single translation job and kick the pipeline loop. */
  async function startTranslation(paperKey: string, modelId: string): Promise<Job> {
    // Refuse a forbidden model at the entrance: without this a job is created
    // (and pinned to that model) before the translator ever gets to object.
    if (isExcludedModel(modelId)) {
      throw appError('MODEL_UNAVAILABLE', '이 모델은 사용하지 않도록 설정되어 있습니다.', false);
    }
    return locked(async () => {
      requireReadablePaper(paperKey);
      const existing = store.getJobForPaper(paperKey);
      // A finished or running job is simply reported: nothing is sent, so no account is needed.
      if (existing !== null && (existing.state === 'running' || existing.state === 'completed' || existing.state === 'completed_with_gaps')) {
        return existing;
      }
      await assertAccountReady(existing === null ? modelId : null);
      const job = jobs.startJob(paperKey, modelId, PROMPT_VERSION);
      drive(job);
      return job;
    });
  }

  /**
   * Replace a paper's translation with a fresh run on the model the user confirmed.
   * Everything that could refuse — input, paper, account, model, another paper's job — is
   * checked before the current job is stopped and before the store deletes anything.
   */
  async function restartTranslation(paperKey: string, body: Record<string, unknown>): Promise<Job> {
    const request: RestartTranslationRequest = {
      modelId: requireString(body, 'modelId', 100),
      requestId: requireRequestId(body),
      expectedJobId: requireJobIdField(body, 'expectedJobId'),
    };
    if (isExcludedModel(request.modelId)) {
      throw appError('MODEL_UNAVAILABLE', '이 모델은 사용하지 않도록 설정되어 있습니다.', false);
    }
    return locked(async () => {
      requireReadablePaper(paperKey);
      const existing = store.getJobForPaper(paperKey);
      if (existing === null) throw notFound('이 논문에는 아직 번역 작업이 없습니다. 번역 시작을 사용해 주세요.');
      // A replay of a request that already went through returns the job it created and
      // touches nothing: no second deletion, no second stop, no extra request.
      const receipt = store.lastTranslationRestart(paperKey);
      if (
        receipt !== null &&
        receipt.jobId === existing.jobId &&
        receipt.requestId === request.requestId &&
        receipt.expectedJobId === request.expectedJobId &&
        receipt.modelId === request.modelId &&
        receipt.promptVersion === PROMPT_VERSION
      ) {
        drive(existing);
        return existing;
      }
      if (existing.jobId !== request.expectedJobId) {
        throw appError('BUSY', '이 논문의 번역 작업이 그사이 바뀌었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.', false);
      }
      const active = jobs.currentActive();
      if (active !== null && active.paperKey !== paperKey) {
        throw appError('BUSY', '다른 논문의 번역이 진행 중입니다. 먼저 일시정지한 뒤 다시 시도해 주세요.', true);
      }
      await assertAccountReady(request.modelId);
      // Only now is the current job stopped; its in-flight answer is discarded by the
      // generation bump the store performs when it publishes the new job.
      if (existing.state === 'running') {
        pipeline.abort(existing.jobId);
        await settleLoop(existing.jobId);
      }
      const job = jobs.restartJob(paperKey, request, PROMPT_VERSION);
      drive(job);
      return job;
    });
  }

  /** Stop our own work, then end this app's official session — never the user's other Codex logins. */
  async function logout(): Promise<LogoutResult> {
    return locked(async () => {
      // No new generation may start on credentials that are about to disappear, and an
      // answer already in flight is discarded by the pause guard.
      const active = jobs.currentActive();
      if (active !== null) {
        jobs.pauseJob(active.jobId, 'auth');
        pipeline.abort(active.jobId);
      }
      // An answer being written on this session is settled now, not left to fail on its own.
      chat.stopAll(LOGGED_OUT_ERROR);
      return session.logout();
    });
  }

  /** Stored revisions only — metadata, never bodies, translations, notes or credentials. */
  function listPapers(): PaperListResult {
    const papers: Paper[] = [];
    for (const key of store.listPapers()) {
      const paper = store.getPaper(key);
      if (paper !== null) papers.push(paper);
    }
    return { papers };
  }

  /** Run the pipeline outside the request/response cycle. */
  function drive(job: Job): void {
    if (job.state !== 'running') return;
    if (pipeline.isRunning(job.jobId)) return;
    void pipeline.run(job.jobId).catch((cause) => {
      const { error } = toHttp(cause);
      log({ event: 'job.end', jobId: job.jobId, code: error.code });
    });
  }

  /** Wait for an aborted loop to unwind so a resume never races a stale iteration.
   * Bounded: a provider that ignores its abort signal must not wedge the request. */
  async function settleLoop(jobId: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pipeline.isRunning(jobId)) {
      if (Date.now() >= deadline) throw appError('BUSY', '이전 번역 작업이 아직 정리되지 않았습니다. 잠시 후 다시 시도해 주세요.', true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  return {
    token,
    recovered,
    clientBootstrap(): string {
      // Only the credential, JSON-escaped, on a data-carrying element.
      return `<meta name="paperread-token" content="${token}">`;
    },
    async listen(port: number, host = LOOPBACK): Promise<AddressInfo> {
      // A restart that a crash interrupted is completed first, so no half-cleared paper is
      // ever served; then any interrupted job is recovered — all before the first request.
      jobs.recoverRestarts();
      recovered.splice(0, recovered.length, ...jobs.recoverInterrupted());
      for (const jobId of recovered) log({ event: 'job.paused', jobId, pauseReason: 'interrupted' });
      // A question whose answer died with the previous process is settled here, so reading a
      // conversation never has to write it.
      chat.recoverInterrupted();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Explicit loopback host: never 0.0.0.0, never a LAN interface.
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server.address() as AddressInfo;
    },
    async close(): Promise<void> {
      pipeline.abortAll();
      // An answer cut off by shutdown is stored as interrupted, never left without an answer;
      // an answer whose earlier write failed gets one more try before it would be lost.
      chat.stopAll(RESTARTED_ERROR);
      chat.flushUnsaved();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    address(): AddressInfo | null {
      return (server.address() as AddressInfo | null) ?? null;
    },
  };
}

export default createApiServer;
