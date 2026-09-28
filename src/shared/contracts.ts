export type ErrorCode = 'INVALID_INPUT'|'NOT_FOUND'|'NETWORK'|'TOO_LARGE'|'UNSUPPORTED_PDF'|'SOURCE_CHANGED'|'AUTH_REQUIRED'|'SUBSCRIPTION_REQUIRED'|'QUOTA'|'MODEL_UNAVAILABLE'|'BUSY'|'INVALID_TRANSLATION'|'STORAGE'|'UNSAFE_RUNTIME'|'INTERNAL';
export interface AppError { code:ErrorCode; message:string; retryable:boolean }
export interface Coverage { totalPages:number; textPages:number; unsupportedPages:number[] }
export interface Paper { paperKey:string; sourceKind?:'arxiv'|'publication'; arxivId:string|null; version:number|null; title:string|null; authors:string[]; sourceUrl:string; pdfSha256:string|null; pageCount:number|null; extractionVersion:string|null; status:'fetching'|'extracting'|'ready'|'partial'|'unsupported'|'failed'; coverage:Coverage|null; createdAt:string }
export interface Region { page:number; x:number; y:number; width:number; height:number }
export interface Block { blockId:string; paperKey:string; order:number; kind:'heading'|'paragraph'|'caption'|'equation'|'figure'|'table'|'reference'|'unsupported'; sourceText:string; sourceHash:string; regions:Region[]; alignment:'exact'|'uncertain'; translatable:boolean; fontFamily:'serif'|'sans'; fontWeight:'normal'|'bold'; fontSize:number; pageOrdinal:number }
export interface Translation { blockId:string; sourceHash:string; modelId:string; promptVersion:string; status:'pending'|'running'|'completed'|'failed'|'unsupported'; text:string|null; error:AppError|null; completedAt:string|null }
export interface Usage { inputTokens:number|null; outputTokens:number|null; limits:Record<string,unknown>|null; observedAt:string|null }
export type JobState = 'idle'|'running'|'paused'|'completed'|'completed_with_gaps'|'failed';
export type PauseReason = null|'user'|'auth'|'quota'|'network'|'model_unavailable'|'interrupted'|'reextracted';
export interface Job { jobId:string; paperKey:string; modelId:string; promptVersion:string; generation:number; state:JobState; pauseReason:PauseReason; completedBlocks:number; totalTranslatableBlocks:number; usage:Usage; updatedAt:string; currentPage:number|null }
export interface Connection { status:'missing'|'signed_out'|'subscription'|'api_key'|'unavailable'; modelIds:string[]; defaultModelId:string|null; limits:Record<string,unknown>|null }
/** App-owned login attempt identifier; never exposes the official login id or credentials. */
export interface LoginAttempt {
  loginId: string;
  status: 'pending'|'completed'|'cancelled'|'expired'|'failed';
  expiresAt: string;
  error: AppError|null;
}
export interface LoginStartResult { attempt: LoginAttempt; loginUrl: string }
export interface LoginAttemptResult { attempt: LoginAttempt }
export interface LogoutResult { connection: Connection }
export interface RestartTranslationRequest { modelId: string; requestId: string; expectedJobId: string }
export interface RestartTranslationResult { job: Job }
export interface PaperListResult { papers: Paper[] }
export interface Snapshot { paper:Paper; blocks:Block[]; translations:Translation[]; job:Job|null }
export interface Highlight { highlightId:string; paperKey:string; page:number; rects:Region[]; text:string; color:'yellow'|'green'|'blue'|'pink'; note:string|null; createdAt:string; updatedAt:string }
export type ApiResult<T> = {data:T}|{error:AppError};
export interface TranslationInput { block:Block; modelId:string; context:string; signal?:AbortSignal }
export interface TranslationOutput { text:string; usage:Usage }
/** One paragraph inside a page-batch request, tagged with its request-local number so the
 * response can be matched back to it regardless of return order or partial dropout. */
export interface TranslationPageParagraph { number:number; block:Block }
export interface TranslationPageInput { paragraphs:TranslationPageParagraph[]; modelId:string; context:string; signal?:AbortSignal }
/** One matched-back result. A number missing from the response simply has no entry here —
 * that is not an error, it is a paragraph to retry. */
export interface TranslationPageResultItem { number:number; text:string }
export interface TranslationPageOutput { results:TranslationPageResultItem[]; usage:Usage }
export interface Translator {
  connection():Promise<Connection>;
  translate(input:TranslationInput):Promise<TranslationOutput>;
  /** One request for every translatable paragraph on a page, numbered and matched back by number. */
  translatePage(input:TranslationPageInput):Promise<TranslationPageOutput>;
  disconnect():Promise<void>;
}

// ------------------------------------------------------------------ paper questions

/** Token counts the official program reported for one answer. A count it did not report stays
 * null — never 0, never a price. `cachedInputTokens` is the part of the input served from the
 * provider's prompt cache (the paper's full text, once warm). */
export interface ChatUsage { inputTokens:number|null; cachedInputTokens:number|null; outputTokens:number|null }
/** One entry of a paper's question conversation. An assistant message is 'answering' only while
 * the service is still generating it; its text is then the answer so far. */
export interface ChatMessage {
  messageId:string;
  role:'user'|'assistant';
  text:string;
  status:'completed'|'answering'|'failed'|'canceled';
  /** The model that wrote an assistant message; null for the reader's own questions. */
  modelId:string|null;
  error:AppError|null;
  /** Assistant messages only; null when nothing was reported. */
  usage:ChatUsage|null;
  createdAt:string;
}
/** A paper's single question conversation, as the service holds it. */
export interface Conversation { paperKey:string; conversationId:string; messages:ChatMessage[]; answering:boolean }
export interface AskRequest {
  question:string;
  modelId:string;
  /** Re-ask the last question whose answer failed or was canceled, replacing that exchange
   * instead of appending a duplicate. */
  retry?:boolean;
}
export interface ConversationResult { conversation:Conversation }
/** One question to the model about one paper revision. */
export interface PaperQuestionInput {
  /** Stable for one conversation; a follow-up with the same id continues the same official
   * thread while it is alive. */
  conversationId:string;
  modelId:string;
  /** The paper's framing and full text, used as the thread's system instructions. Identical for
   * every question about the same revision, so the provider can reuse the cached prefix. */
  instructions:string;
  /** Earlier completed exchanges, oldest first. Replayed only when a new thread has to be opened
   * for an existing conversation (service restart, model change, lost connection). */
  history:{question:string;answer:string}[];
  question:string;
  signal?:AbortSignal;
  /** The answer text so far, each time more of it streams in. */
  onText?(text:string):void;
}
export interface PaperQuestionOutput { text:string; usage:ChatUsage }
/** The question path of the official program. Kept apart from Translator: the translation
 * pipeline never receives it, and it never receives account methods. */
export interface PaperChat {
  ask(input:PaperQuestionInput):Promise<PaperQuestionOutput>;
  /** Drop a conversation's official thread (new conversation, deleted paper). */
  forget(conversationId:string):Promise<void>;
}
