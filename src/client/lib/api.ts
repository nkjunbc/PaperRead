import type {
  AppError,
  AskRequest,
  Connection,
  ConversationResult,
  Highlight,
  Job,
  LoginAttemptResult,
  LoginStartResult,
  LogoutResult,
  PaperListResult,
  Region,
  RestartTranslationRequest,
  Snapshot,
  Translation,
} from '../../shared/contracts';

/** The header the local service requires on every state-changing request. */
export const TOKEN_HEADER = 'x-paperread-token';

const HEX_TOKEN = /^[0-9a-f]{16,128}$/i;

/**
 * Read the credential the service injected into this page.
 *
 * Only a plain hex string is accepted, so a page that was not served by the
 * app (or a meta tag carrying anything else) yields null instead of a value we
 * would then put into a header.
 */
export function readToken(doc: Document): string | null {
  const meta = doc.querySelector('meta[name="paperread-token"]');
  const value = meta?.getAttribute('content') ?? null;
  return value !== null && HEX_TOKEN.test(value) ? value : null;
}

/**
 * Fill a path template, percent-encoding every value.
 *
 * paperKeys like `1706.03762v7` survive unchanged, while anything containing a
 * separator is encoded and can never escape its own path segment.
 */
export function apiPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([a-zA-Z]+)/g, (_match, name: string) => encodeURIComponent(params[name] ?? ''));
}

function isAppError(value: unknown): value is AppError {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string' && typeof v.retryable === 'boolean';
}

/** Normalise anything thrown or returned into an AppError we can display. */
export function extractError(value: unknown): AppError {
  if (isAppError(value)) return value;
  return { code: 'INTERNAL', message: '요청을 처리하지 못했습니다.', retryable: false };
}

/**
 * The browser's view of the local service.
 *
 * The credential lives here and is attached only as a request header on
 * state-changing calls — never in a URL, never in an error message, never
 * rendered. Reads carry no credential at all.
 */
export class ApiClient {
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string | null, fetchImpl?: typeof fetch) {
    this.token = token;
    // A platform fetch must keep its receiver: storing `globalThis.fetch` in a
    // field and calling it as `this.fetchImpl(...)` detaches it, and every
    // request dies with "Illegal invocation". Bind the platform one; an
    // injected test double is used as given.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** True when this page was served by the app and may change state. */
  get canMutate(): boolean {
    return this.token !== null;
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; credential?: boolean } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const mutating = method !== 'GET' && method !== 'HEAD';
    const headers: Record<string, string> = { accept: 'application/json' };
    // Reads carry no credential, except the one read the service guards as per-session
    // state (a login attempt); `credential` opts that single read in.
    if ((mutating || init.credential === true) && this.token !== null) headers[TOKEN_HEADER] = this.token;
    if (mutating && init.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(path, {
        method,
        headers,
        // Same-origin only; the service is loopback and never cross-site.
        credentials: 'same-origin',
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      // The underlying message can echo the request; never let it through.
      throw { code: 'NETWORK', message: '로컬 서비스에 연결하지 못했습니다.', retryable: true } satisfies AppError;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw { code: 'INTERNAL', message: '응답을 읽을 수 없습니다.', retryable: false } satisfies AppError;
    }

    if (payload !== null && typeof payload === 'object' && 'error' in payload) {
      throw extractError((payload as { error: unknown }).error);
    }
    if (!response.ok) throw { code: 'INTERNAL', message: '요청이 거절되었습니다.', retryable: false } satisfies AppError;
    return (payload as { data: T }).data;
  }

  // ------------------------------------------------------------------ reads

  snapshot(paperKey: string): Promise<Snapshot> {
    return this.request<Snapshot>(apiPath('/api/papers/:key', { key: paperKey }));
  }

  connection(): Promise<Connection> {
    return this.request<Connection>('/api/connection');
  }

  /** Stored revisions only: metadata for the library, never bodies or translations. */
  listPapers(): Promise<PaperListResult> {
    return this.request<PaperListResult>('/api/papers');
  }

  /** The current state of an app-issued login attempt. Guarded like a state change. */
  loginStatus(loginId: string): Promise<LoginAttemptResult> {
    return this.request<LoginAttemptResult>(apiPath('/api/connection/login/:id', { id: loginId }), { credential: true });
  }

  job(jobId: string): Promise<{ job: Job; translations: Translation[] }> {
    return this.request(apiPath('/api/jobs/:id', { id: jobId }));
  }

  /** Same-origin PDF URL; the credential is never part of it. */
  pdfUrl(paperKey: string): string {
    return apiPath('/api/papers/:key/pdf', { key: paperKey });
  }

  // --------------------------------------------------------- state changes

  openPaper(input: string): Promise<{ paper: Snapshot['paper'] }> {
    return this.request('/api/papers/open', { method: 'POST', body: { input } });
  }

  deletePaper(paperKey: string): Promise<{ deleted: true }> {
    return this.request(apiPath('/api/papers/:key', { key: paperKey }), { method: 'DELETE' });
  }

  startTranslation(paperKey: string, modelId: string): Promise<{ job: Job }> {
    return this.request(apiPath('/api/papers/:key/translation', { key: paperKey }), { method: 'POST', body: { modelId } });
  }

  pauseJob(jobId: string): Promise<{ job: Job }> {
    return this.request(apiPath('/api/jobs/:id/pause', { id: jobId }), { method: 'POST' });
  }

  resumeJob(jobId: string): Promise<{ job: Job }> {
    return this.request(apiPath('/api/jobs/:id/resume', { id: jobId }), { method: 'POST' });
  }

  /**
   * Start the official ChatGPT login for this app's own session. The answer is an
   * app-issued attempt and the official HTTPS address the reader opens themselves;
   * no password, cookie or token ever passes through this client.
   */
  startLogin(): Promise<LoginStartResult> {
    return this.request<LoginStartResult>('/api/connection/login', { method: 'POST', body: {} });
  }

  cancelLogin(loginId: string): Promise<LoginAttemptResult> {
    return this.request<LoginAttemptResult>(apiPath('/api/connection/login/:id/cancel', { id: loginId }), { method: 'POST', body: {} });
  }

  /** Ends this app's session only; the reader's other Codex logins are untouched. */
  logout(): Promise<LogoutResult> {
    return this.request<LogoutResult>('/api/connection/logout', { method: 'POST', body: {} });
  }

  /**
   * Replace the stored translation with a fresh run. `requestId` makes a retry after a
   * lost answer land on the same new job instead of deleting twice; `expectedJobId` makes
   * a stale tab's request fail instead of replacing a job it never saw.
   */
  restartTranslation(paperKey: string, input: RestartTranslationRequest): Promise<{ job: Job }> {
    return this.request(apiPath('/api/papers/:key/translation/restart', { key: paperKey }), { method: 'POST', body: input });
  }

  // --------------------------------------------------------------- highlights

  listHighlights(paperKey: string): Promise<Highlight[]> {
    return this.request<Highlight[]>(apiPath('/api/papers/:key/highlights', { key: paperKey }));
  }

  createHighlight(paperKey: string, input: { page: number; rects: Region[]; text: string; color?: Highlight['color'] }): Promise<Highlight> {
    return this.request<Highlight>(apiPath('/api/papers/:key/highlights', { key: paperKey }), { method: 'POST', body: input });
  }

  updateHighlight(paperKey: string, highlightId: string, input: { note?: string | null; color?: Highlight['color'] }): Promise<Highlight> {
    return this.request<Highlight>(apiPath('/api/papers/:key/highlights/:id', { key: paperKey, id: highlightId }), { method: 'PATCH', body: input });
  }

  deleteHighlight(paperKey: string, highlightId: string): Promise<{ deleted: true }> {
    return this.request(apiPath('/api/papers/:key/highlights/:id', { key: paperKey, id: highlightId }), { method: 'DELETE' });
  }

  // ------------------------------------------------------------ questions

  /** The paper's question conversation as the service holds it. A plain read: no credential. */
  getConversation(paperKey: string): Promise<ConversationResult> {
    return this.request<ConversationResult>(apiPath('/api/papers/:key/chat', { key: paperKey }));
  }

  /**
   * Ask about the paper. The service answers at once with the conversation (the question and
   * an answer that is still being written); the answer itself is read by polling.
   */
  askQuestion(paperKey: string, input: AskRequest): Promise<ConversationResult> {
    return this.request<ConversationResult>(apiPath('/api/papers/:key/chat', { key: paperKey }), { method: 'POST', body: input });
  }

  /** Stop the answer being written; what arrived so far stays. */
  cancelAnswer(paperKey: string): Promise<ConversationResult> {
    return this.request<ConversationResult>(apiPath('/api/papers/:key/chat/cancel', { key: paperKey }), { method: 'POST', body: {} });
  }

  /** Drop the conversation and start an empty one. */
  clearConversation(paperKey: string): Promise<ConversationResult> {
    return this.request<ConversationResult>(apiPath('/api/papers/:key/chat', { key: paperKey }), { method: 'DELETE' });
  }
}
