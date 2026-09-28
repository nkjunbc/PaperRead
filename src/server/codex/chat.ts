import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { AppError, ChatUsage, PaperChat, PaperQuestionInput, PaperQuestionOutput } from '../../shared/contracts';
import { closedFailure, CONTEXT_COMPACTION_ITEM, failure, isRpcClosed, mapRpcError, TEXT_ONLY_ITEM_TYPES, type GenerationRpc } from './rpc';
import { openIsolatedThread, type IsolatedThread } from './isolation';

/** What the question path borrows from the translator: the same forbidden-model and
 * subscription checks, the same shared official process, and the same fail-closed disconnect.
 * It never receives account methods. */
export interface ChatHost {
  /** Forbidden model, sign-in, subscription and catalogue checks; throws before any generation request. */
  ensureUsable(modelId:string,signal:AbortSignal|undefined):Promise<unknown>;
  rpc():Promise<GenerationRpc>;
  /** Ends the shared process after isolation evidence. Never a logout. */
  disconnect():Promise<void>;
  /** Isolation evidence that arrived after its turn had settled (no answer left to fail with it):
   * reported so it is recorded, never silently dropped. */
  lateBreach?():void;
}
export const CHAT_TURN_TIMEOUT_MS=300_000;
/** Live official threads kept for follow-up questions; each holds a paper's full text. A thread
 * that leaves this set is unsubscribed (IsolatedThread.release), so the official program unloads
 * it once idle instead of keeping every dropped paper text until the process ends. */
export const MAX_CHAT_THREADS=8;
/** Budget for the transcript replayed into a new thread, in UTF-8 bytes of its JSON-escaped text
 * (what the official program echoes back in one userMessage notification). Well under the
 * transport's per-line limit (MAX_LINE_BYTES, 1 MiB) even for Korean text, so a long
 * conversation can never make that echo stop the shared process. The oldest exchanges go first. */
export const REPLAY_BYTES=300_000;
const OMITTED_NOTE='(Earlier exchanges in this conversation were omitted.)';
/** After a cancel or timeout the official program still ends the interrupted turn; its tail is
 * absorbed for at most this long so it never reaches the transport without a listener. */
const DRAIN_MS=30_000;
/** A question on a conversation whose stopped question is still interrupting its official turn
 * waits at most this long for it (the service settles a stopped answer at once). */
const STOPPED_WAIT_MS=10_000;
const NO_USAGE:ChatUsage=Object.freeze({inputTokens:null,cachedInputTokens:null,outputTokens:null});
const TOO_LARGE_MESSAGE='논문과 대화가 이 모델이 한 번에 읽을 수 있는 분량을 넘었습니다.';
const LEFT_FILES_MESSAGE='격리된 작업 폴더에 파일이 생성되었습니다.';
const TOOL_ITEM_MESSAGE='격리된 스레드에서 도구 실행 항목을 감지했습니다.';
const OVERSIZE_MESSAGE='공식 프로그램의 응답이 한 번에 받을 수 있는 크기를 넘어 연결을 끊었습니다. 새 대화에서 다시 질문해 주세요.';
const canceled=()=>failure('NETWORK','질문이 취소되었습니다.',true);
/** Rejections of turn/start that say nothing about the thread itself: the official program
 * refused to take a turn right now, so nothing entered the thread and it can be kept. */
const THREAD_INTACT_CODES:ReadonlySet<string>=new Set(['BUSY','QUOTA','AUTH_REQUIRED']);

interface ChatThread {
  rpc:GenerationRpc; thread:IsolatedThread; modelId:string;
  /** sha256 of the system instructions: a thread is reused only for the identical paper text. */
  digest:string;
  /** Completed exchanges of the conversation the official thread accounts for (replayed or
   * noted as omitted at open, plus those answered on it). Reused only for exactly as many. */
  exchanges:number;
  /** A turn is running on it; whoever drops it meanwhile leaves the release to that turn. */
  active:boolean;
  retired:boolean;
  released:boolean;
}
function object(value:unknown):Record<string,unknown>|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function counted(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;}
function digestOf(text:string):string{return createHash('sha256').update(text,'utf8').digest('hex');}
function isToolItem(params:unknown):boolean{const item=object(object(params)?.item);return !!item&&typeof item.type==='string'&&!TEXT_ONLY_ITEM_TYPES.has(item.type);}
function isCompaction(params:unknown):boolean{return object(object(params)?.item)?.type===CONTEXT_COMPACTION_ITEM;}
/** Bytes the text takes inside a JSON line. */
function wireBytes(text:string):number{return Buffer.byteLength(JSON.stringify(text),'utf8');}
/** Only the counts the official program reported for the last model call; missing stays null. */
export function chatUsage(tokenUsage:unknown):ChatUsage {
  const last=object(object(tokenUsage)?.last);
  return {inputTokens:counted(last?.inputTokens),cachedInputTokens:counted(last?.cachedInputTokens),outputTokens:counted(last?.outputTokens)};
}
/** The turn's text. On a live thread it is exactly the question. A thread opened for an existing
 * conversation first gets a plain, neutral transcript of the completed exchanges — no style or
 * behaviour instructions, so the model answers as itself. The transcript keeps the most recent
 * exchanges that fit in `limit` (see REPLAY_BYTES); if any are left out, one line says so. */
export function questionTurnText(history:readonly {question:string;answer:string}[],question:string,limit=REPLAY_BYTES):string {
  if(history.length===0)return question;
  const kept:string[]=[];let used=0;
  for(let index=history.length-1;index>=0;index-=1){
    const entry=history[index]!;
    const text=`User: ${entry.question}\n\nAssistant: ${entry.answer}`;
    const size=wireBytes(text)+4; // plus the blank line that joins it to the next
    if(used+size>limit)break;
    kept.unshift(text);used+=size;
  }
  const earlier=(kept.length<history.length?[OMITTED_NOTE,...kept]:kept).join('\n\n');
  return `Earlier in this conversation:\n\n${earlier}\n\nNew question:\n${question}`;
}
/** Official turn errors carry codexErrorInfo at the top level (v2 TurnError). */
function turnFailure(value:unknown):Error&AppError {
  const e=object(value);const info=e?.codexErrorInfo;
  return mapRpcError(typeof info==='string'?{message:e?.message,data:{codexErrorInfo:info}}:value??{});
}
/** Shared mappers speak of translation; a question-path failure is worded for questions. */
function forQuestion(error:unknown):unknown {
  const e=error as (Partial<AppError>&{oversize?:unknown})|null;
  if(e?.code==='TOO_LARGE')return failure('TOO_LARGE',TOO_LARGE_MESSAGE);
  // The transport stopped on a line over its size limit: still UNSAFE_RUNTIME, worded for questions.
  if(e?.code==='UNSAFE_RUNTIME'&&e.oversize===true)return failure('UNSAFE_RUNTIME',OVERSIZE_MESSAGE);
  return error;
}
function agentMessages(items:unknown):{text:string;phase:unknown}[] {
  if(!Array.isArray(items))return [];
  return items.map(object).filter(item=>item?.type==='agentMessage'&&typeof item.text==='string').map(item=>({text:item!.text as string,phase:item!.phase}));
}
function pickAnswer(messages:{text:string;phase:unknown}[]):string {
  const finals=messages.filter(message=>message.phase==='final_answer');
  return (finals.at(-1)??messages.at(-1))?.text??'';
}
/** Resolves when `ended` does, `signal` aborts or `ms` pass, whichever comes first. */
function within(ended:Promise<void>,signal:AbortSignal|undefined,ms:number):Promise<void> {
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,ms);(timer as {unref?:()=>void}).unref?.();
    if(signal?.aborted)finish();else signal?.addEventListener('abort',finish,{once:true});
    void ended.then(finish);
  });
}
/** A question running on a conversation: its caller's stop signal and when it has fully ended. */
interface Asking { signal:AbortSignal|undefined; ended:Promise<void> }
/** How far a question's turn got: turn/start sent (requested) and accepted (started). */
interface TurnProgress { requested:boolean; started:boolean }

/** Paper questions on the shared official process. Each conversation keeps one ephemeral,
 * proved-isolated thread whose system prompt is the paper's full text, so every follow-up sends
 * the identical prefix on the same thread (same prompt-cache key). Nothing about questions,
 * answers or instructions is ever logged. */
export class CodexPaperChat implements PaperChat {
  private threads=new Map<string,ChatThread>(); // insertion order = least recently used first
  private asking=new Map<string,Asking>();
  /** Official threads a question turn is listening on (running, or absorbing its tail). */
  private listening=new Map<string,number>();
  constructor(private host:ChatHost,private turnTimeoutMs=CHAT_TURN_TIMEOUT_MS,private maxThreads=MAX_CHAT_THREADS){}
  /** A question turn is listening on this official thread: a context compaction there is that
   * question's own failure (see runTurn), not a tool for other listeners on the process. */
  listensTo(threadId:string):boolean{ return (this.listening.get(threadId)??0)>0; }
  async ask(input:PaperQuestionInput):Promise<PaperQuestionOutput>{
    const id=input.conversationId;
    const busy=()=>failure('BUSY','이 대화에서 이미 답변을 만들고 있습니다.',true);
    if(typeof id!=='string'||!id)throw failure('INVALID_INPUT','대화를 확인할 수 없습니다.');
    if(typeof input.question!=='string'||!input.question.trim())throw failure('INVALID_INPUT','질문을 입력해 주세요.');
    if(typeof input.instructions!=='string'||!input.instructions.trim())throw failure('INVALID_INPUT','논문 본문이 없어 질문할 수 없습니다.');
    const running=this.asking.get(id);
    if(running){
      // A live question keeps the conversation. A stopped one is still interrupting its official
      // turn (the thread takes one turn at a time): wait for that instead of refusing the next.
      if(!running.signal?.aborted)throw busy();
      await within(running.ended,input.signal,STOPPED_WAIT_MS);
      if(input.signal?.aborted)throw canceled();
      if(this.asking.has(id))throw busy();
    }
    let end:()=>void=()=>{};
    const mine:Asking={signal:input.signal,ended:new Promise<void>(resolve=>{end=resolve;})};
    this.asking.set(id,mine);
    try{return await this.answer(input);}
    catch(error){throw forQuestion(error);}
    finally{if(this.asking.get(id)===mine)this.asking.delete(id);end();}
  }
  async forget(conversationId:string):Promise<void>{
    const entry=this.threads.get(conversationId);
    if(entry)await this.drop(conversationId,entry,true);
  }
  /** The official process closed: its threads are gone with it. */
  async dropConnection(rpc:GenerationRpc):Promise<void>{
    for(const [id,entry] of [...this.threads])if(entry.rpc===rpc)await this.drop(id,entry,false).catch(()=>{/* closing */});
  }
  async dropAll():Promise<void>{
    for(const [id,entry] of [...this.threads])await this.drop(id,entry,false).catch(()=>{/* closing */});
  }
  private async answer(input:PaperQuestionInput):Promise<PaperQuestionOutput>{
    const id=input.conversationId;
    // Same gate as translation: forbidden model and subscription state before any request.
    await this.host.ensureUsable(input.modelId,input.signal);
    const rpc=await this.host.rpc();
    for(const [staleId,stale] of [...this.threads])if(stale.rpc!==rpc||isRpcClosed(stale.rpc))await this.drop(staleId,stale,true);
    const history=(Array.isArray(input.history)?input.history:[]).filter(entry=>typeof entry?.question==='string'&&typeof entry?.answer==='string');
    const digest=digestOf(input.instructions);
    let entry=this.threads.get(id);
    let text=input.question;
    let replaying=false;
    // Reused only when the thread accounts for exactly the conversation's completed exchanges. An
    // answer the official program finished but the conversation recorded as stopped (or lost to
    // a failed save) stays in the thread; a retry there would show the model that question twice.
    if(entry&&entry.modelId===input.modelId&&entry.digest===digest&&entry.exchanges===history.length){
      this.threads.delete(id);this.threads.set(id,entry);
      entry.active=true;
    } else {
      if(entry)await this.drop(id,entry,true);
      if(input.signal?.aborted)throw canceled();
      const thread=await openIsolatedThread(rpc,input.modelId,{instructions:input.instructions,scratchPrefix:'paperread-chat-'});
      entry={rpc,thread,modelId:input.modelId,digest,exchanges:history.length,active:true,retired:false,released:false};
      this.threads.set(id,entry);
      text=questionTurnText(history,input.question);
      replaying=history.length>0;
      try{await this.evict(id);}catch(error){entry.active=false;await this.drop(id,entry,false);throw error;}
    }
    const progress:TurnProgress={requested:false,started:false};
    let output:PaperQuestionOutput;
    try{output=await this.runTurn(entry,text,input,progress);}
    catch(error){
      entry.active=false;
      const code=(error as Partial<AppError>).code;
      if(code==='UNSAFE_RUNTIME'){await this.drop(id,entry,false);throw error;}
      // Nothing entered the thread when no turn was sent, or when the official program refused
      // to take one for a reason that says nothing about the thread (busy, usage limit,
      // sign-in): keep it, prompt cache and all. Not when this turn carried the replay the new
      // thread still lacks, and not when the connection is gone.
      const untouched=!progress.started&&!replaying&&!isRpcClosed(entry.rpc)
        &&(!progress.requested||typeof code==='string'&&THREAD_INTACT_CODES.has(code));
      if(untouched&&!entry.retired)throw error;
      // A failed, canceled or timed-out turn may have left its question (and part of an answer)
      // in the official thread, which the conversation's completed history does not have. The
      // next question opens a fresh thread and replays only completed exchanges.
      await this.drop(id,entry,true);
      throw error;
    }
    entry.active=false;
    if(entry.retired){await this.drop(id,entry,true);return output;}
    let left:string[]|null;
    try{left=await readdir(entry.thread.cwd);}catch{left=null;}
    if(left===null){await this.drop(id,entry,false);return output;} // scratch gone: never reuse a thread without one
    if(left.length>0){await this.drop(id,entry,false);await this.host.disconnect();throw failure('UNSAFE_RUNTIME',LEFT_FILES_MESSAGE);}
    entry.exchanges+=1;
    return output;
  }
  /** Removes an entry and deletes its scratch directory. A turn still running on it releases
   * it when it ends instead. Anything found in the directory is isolation evidence. */
  private async drop(id:string,entry:ChatThread,report:boolean):Promise<void>{
    if(this.threads.get(id)===entry)this.threads.delete(id);
    if(entry.active){entry.retired=true;return;}
    if(entry.released)return;
    entry.released=true;
    const left=await entry.thread.release().catch(()=>[] as string[]);
    if(left.length>0&&report){await this.host.disconnect();throw failure('UNSAFE_RUNTIME',LEFT_FILES_MESSAGE);}
  }
  private async evict(keep:string):Promise<void>{
    for(const [id,entry] of [...this.threads]){
      if(this.threads.size<=this.maxThreads)return;
      if(id===keep||entry.active)continue;
      await this.drop(id,entry,true);
    }
  }
  private listen(threadId:string):void{ this.listening.set(threadId,(this.listening.get(threadId)??0)+1); }
  private unlisten(threadId:string):void{
    const count=(this.listening.get(threadId)??0)-1;
    if(count>0)this.listening.set(threadId,count);else this.listening.delete(threadId);
  }
  /** One free-text turn (no output schema). Streams the latest agent message, watches every
   * item on the process for a tool, fails fast if the process closes, and on cancel or timeout
   * interrupts the turn and absorbs its tail. */
  private async runTurn(entry:ChatThread,text:string,input:PaperQuestionInput,progress:TurnProgress):Promise<PaperQuestionOutput>{
    const {rpc}=entry;const threadId=entry.thread.threadId;
    let turnId:string|null=null;let ended=false;
    let settle:((outcome:{turn:unknown}|{error:Error})=>void)|null=null;
    const finished=new Promise<{turn:unknown}|{error:Error}>(resolve=>{settle=resolve;});
    const done=(outcome:{turn:unknown}|{error:Error})=>{settle?.(outcome);settle=null;};
    const streamed=new Map<string,string>();const completed=new Map<string,{text:string;phase:unknown}>();
    let latest:string|null=null;let sent='';let usage:ChatUsage|null=null;
    const emit=(value:string)=>{
      if(!input.onText||!value||value===sent)return;
      sent=value;
      try{input.onText(value);}catch{/* a consumer error must not stop the official stream */}
    };
    let drainTimer:ReturnType<typeof setTimeout>|null=null;
    let detached=false;
    const detach=()=>{
      if(detached)return;detached=true;
      if(drainTimer)clearTimeout(drainTimer);
      if(rpc.offGenerationEvent)rpc.offGenerationEvent(handler);else rpc.offEvent?.(handler);
      this.unlisten(threadId);
    };
    const handler=(method:string,params:unknown)=>{
      const p=object(params);
      if(isCompaction(params)){
        // The official program compacts a thread's history by itself when the context nears the
        // model's limit (0.156.0: a 'contextCompaction' item at the start of the next turn). No
        // CLI override prevents it: model_auto_compact_token_limit exists in the config schema,
        // but a huge value is clamped to about 90% of the context window — measured against a
        // loopback provider, the thread still compacted. A compaction swaps the conversation for
        // the official program's own summary, so it never yields an answer here: on this
        // question's own thread it fails the question as too large, the thread is dropped, and
        // the next question replays only what fits (questionTurnText). It runs no tool, so it
        // does not end the shared process. On another question's listened thread it is that
        // question's own failure; on any other thread it is treated as a tool, like every
        // non-text item.
        const on=p?.threadId;
        if(on===threadId){if(settle)done({error:failure('TOO_LARGE',TOO_LARGE_MESSAGE)});return;}
        if(typeof on==='string'&&this.listensTo(on))return;
      }
      if(isToolItem(params)){
        // Any thread on the process: the proved isolation did not hold. Never wait for the turn.
        if(settle)done({error:failure('UNSAFE_RUNTIME',TOOL_ITEM_MESSAGE)});
        else{this.host.lateBreach?.();void this.host.disconnect();}
        return;
      }
      if(p?.threadId!==threadId)return;
      const eventTurn=typeof p.turnId==='string'?p.turnId:typeof object(p.turn)?.id==='string'?object(p.turn)!.id as string:null;
      if(turnId!==null&&eventTurn!==null&&eventTurn!==turnId)return;
      if(method==='turn/completed'||method==='turn/failed'){
        ended=true;
        if(!settle){detach();return;} // the interrupted turn's tail has arrived
        if(method==='turn/failed'){const turn=object(p.turn);done({error:turn?.error?turnFailure(turn.error):failure('NETWORK','답변을 받지 못했습니다.',true)});}
        else done({turn:p.turn??null});
        return;
      }
      if(!settle)return;
      if(method==='item/agentMessage/delta'&&typeof p.itemId==='string'&&typeof p.delta==='string'){
        const value=(streamed.get(p.itemId)??'')+p.delta;
        streamed.set(p.itemId,value);latest=p.itemId;emit(value);
      } else if(method==='item/completed'){
        const item=object(p.item);
        if(item?.type==='agentMessage'&&typeof item.id==='string'&&typeof item.text==='string'){
          completed.set(item.id,{text:item.text,phase:item.phase});streamed.set(item.id,item.text);latest=item.id;emit(item.text);
        }
      } else if(method==='thread/tokenUsage/updated')usage=chatUsage(p.tokenUsage);
    };
    if(rpc.onGenerationEvent)rpc.onGenerationEvent(handler);else rpc.onEvent?.(handler);
    this.listen(threadId);
    // A fail-closed stop (server request, bad or oversized line) keeps its UNSAFE_RUNTIME code:
    // it is evidence, not a connection loss to retry.
    const onClose=(reason?:Error)=>done({error:closedFailure(reason,'공식 프로그램 연결이 끊겼습니다.')});
    rpc.onClose?.(onClose);
    let onAbort:(()=>void)|null=null;
    const timer=setTimeout(()=>done({error:failure('NETWORK','답변 시간이 초과되었습니다.',true)}),this.turnTimeoutMs);
    try {
      if(input.signal?.aborted)throw canceled();
      progress.requested=true;
      const response=object(await rpc.request('turn/start',{threadId,input:[{type:'text',text}]}));
      progress.started=true;
      const id=object(response?.turn)?.id;
      if(typeof id==='string'&&id)turnId=id;
      if(input.signal){
        onAbort=()=>done({error:canceled()});
        if(input.signal.aborted)onAbort();else input.signal.addEventListener('abort',onAbort,{once:true});
      }
      const outcome=await finished;
      if('error' in outcome){
        if((outcome.error as Partial<AppError>).code==='UNSAFE_RUNTIME'){await this.host.disconnect();throw outcome.error;}
        // Discard anything in flight; partial text is never an answer.
        if(!ended&&turnId!==null)await rpc.request('turn/interrupt',{threadId,turnId}).catch(()=>{/* connection may already be stopping */});
        throw outcome.error;
      }
      const turn=object(outcome.turn);
      const items=Array.isArray(turn?.items)?turn.items:[];
      const others=items.map(item=>object(item)?.type).filter(type=>typeof type==='string'&&!TEXT_ONLY_ITEM_TYPES.has(type));
      if(others.some(type=>type!==CONTEXT_COMPACTION_ITEM)){
        await this.host.disconnect();throw failure('UNSAFE_RUNTIME',TOOL_ITEM_MESSAGE);
      }
      if(others.length>0)throw failure('TOO_LARGE',TOO_LARGE_MESSAGE); // compacted (see handler)
      if(turn?.status==='failed')throw turnFailure(turn.error);
      if(turn?.status==='interrupted')throw failure('NETWORK','답변이 중단되었습니다.',true);
      if(turn?.status!=='completed')throw failure('NETWORK','답변을 받지 못했습니다.',true);
      let answer=pickAnswer(agentMessages(items));
      if(!answer.trim())answer=pickAnswer([...completed.values()]);
      if(!answer.trim()&&latest!==null)answer=streamed.get(latest)??'';
      if(!answer.trim())throw failure('NETWORK','답변을 받지 못했습니다.',true);
      return {text:answer,usage:usage??{...NO_USAGE}};
    } finally {
      clearTimeout(timer);
      if(onAbort&&input.signal)input.signal.removeEventListener('abort',onAbort);
      rpc.offClose?.(onClose);
      settle=null;
      if(!progress.started||ended||isRpcClosed(rpc))detach();
      else{drainTimer=setTimeout(detach,DRAIN_MS);drainTimer.unref?.();}
    }
  }
}
