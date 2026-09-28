import type { Readable, Writable } from 'node:stream';
import type { AppError } from '../../shared/contracts';

export function failure(code: AppError['code'], message:string, retryable=false): Error & AppError {
  return Object.assign(new Error(message),{code,retryable});
}
/** What a running turn reports when the transport stops under it. A fail-closed stop keeps its
 * code and reason (never a retryable "connection lost" that hides the evidence); any other stop
 * is a retryable loss of the connection worded by the caller. */
export function closedFailure(reason:unknown,lostMessage:string):Error&AppError {
  const e=reason as (Partial<AppError>&{message?:unknown;oversize?:unknown})|null|undefined;
  if(e?.code!=='UNSAFE_RUNTIME')return failure('NETWORK',lostMessage,true);
  const stopped=failure('UNSAFE_RUNTIME',typeof e.message==='string'&&e.message?e.message:'공식 프로그램 연결을 안전 위반으로 종료했습니다.');
  return e.oversize===true?Object.assign(stopped,{oversize:true}):stopped;
}
export interface ChildStreams {
  stdin: Writable; stdout: Readable; stderr: Readable;
  on(event:string, listener:(...args:any[])=>void):unknown;
  kill():boolean;
}
export interface Rpc {
  request(method:string, params?:unknown):Promise<unknown>;
  close():Promise<void>;
  /** Optional lifecycle signal used by shared factories and consumers. */
  isClosed?():boolean;
  closed?:boolean;
  /** Observers learn why the transport stopped (the same error its pending requests got). */
  onClose?(handler:(reason?:Error)=>void):void;
  offClose?(handler:(reason?:Error)=>void):void;
}
/** Transport that can also carry a proved-isolated generation turn. */
export interface GenerationRpc extends Rpc {
  /** Legacy generation-event alias retained for test transports. */
  onEvent?(handler:(method:string,params:unknown)=>void):void;
  offEvent?(handler:(method:string,params:unknown)=>void):void;
  /** Account notifications are never routed to generation listeners. */
  onAccountEvent?(handler:(method:string,params:unknown)=>void):void;
  offAccountEvent?(handler:(method:string,params:unknown)=>void):void;
  /** Generation/item notifications require an active generation listener. */
  onGenerationEvent?(handler:(method:string,params:unknown)=>void):void;
  offGenerationEvent?(handler:(method:string,params:unknown)=>void):void;
  /** Takes the proved isolation request as the key; there is no argument-less form. */
  unlockGeneration(request:unknown):void;
}
/** Methods that only read official account/catalog state. */
const STATUS_METHODS=new Set(['initialize','account/read','model/list','account/rateLimits/read']);
/** Account controls are explicitly bounded; this is not a general command proxy. */
const AUTH_METHODS=new Set(['account/login/start','account/login/cancel','account/logout']);
/** Official in-process feature enablement: reads and writes only this child process. */
const FEATURE_METHODS=new Set(['experimentalFeature/list','experimentalFeature/enablement']);
/** thread/unsubscribe ends this connection's subscription to a thread it started, so the official
 * program unloads it once idle (thread_unload_delay_secs; measured on 0.156.0). It carries only
 * the thread id and cannot start, widen or approve anything. */
const GENERATION_METHODS=new Set(['thread/start','turn/start','turn/interrupt','thread/unsubscribe']);
const EVENT_METHODS=new Set(['account/login/completed','account/updated']);
/** Codex plan values that prove a ChatGPT subscription for this application. */
export const KNOWN_SUBSCRIPTION_PLANS:ReadonlySet<string>=new Set([
  'go','plus','pro','prolite','team','business','ent26','enterprise','edu','edu_plus','edu_pro',
  'self_serve_business_prolite','self_serve_business_usage_based','enterprise_cbp_automation','enterprise_cbp_usage_based',
]);
export function isKnownSubscriptionPlan(value:unknown):boolean {
  return typeof value==='string'&&KNOWN_SUBSCRIPTION_PLANS.has(value);
}
/** Item types the measured text-only runtime produces. Anything else is a tool. */
export const TEXT_ONLY_ITEM_TYPES:ReadonlySet<string>=new Set(['userMessage','reasoning','agentMessage']);
/** The official program's automatic context compaction (v2 ThreadItem, 0.156.0). Not a text item,
 * so it counts as a tool everywhere except on a thread a question turn is listening on, where it
 * fails that question as too large instead (see chat.ts). */
export const CONTEXT_COMPACTION_ITEM='contextCompaction';
/** Turn payload keys that cannot re-introduce tools, writable paths, or approvals. */
const TURN_KEYS:Record<string,ReadonlySet<string>>={'turn/start':new Set(['threadId','input','outputSchema']),'turn/interrupt':new Set(['threadId','turnId']),'thread/unsubscribe':new Set(['threadId'])};
function plainObject(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function validGenerationParams(method:string,value:unknown):boolean {
  const allowedKeys=TURN_KEYS[method];
  if(!allowedKeys)return true;
  if(!plainObject(value)||Object.keys(value).some(key=>!allowedKeys.has(key)))return false;
  // Unsubscribe is exactly {threadId}: nothing else can ride on it.
  if(method==='thread/unsubscribe')return Object.keys(value).length===1&&typeof value.threadId==='string'&&value.threadId.length>0;
  return true;
}
function validAuthParams(method:string,value:unknown):boolean {
  if(!plainObject(value))return false;
  const keys=Object.keys(value);
  if(method==='account/login/start')return keys.length===1&&keys[0]==='type'&&value.type==='chatgpt';
  if(method==='account/login/cancel')return keys.length===1&&keys[0]==='loginId'&&typeof value.loginId==='string'&&value.loginId.length>0;
  if(method==='account/logout')return keys.length===0;
  return false;
}
/** Single source of truth for "this thread cannot run tools", checked structurally on the
 * request object itself. No boolean, env var, or persisted file can stand in for it.
 * Tool conditions measured in scripts/probe-isolation.result.json: empty environments, empty
 * dynamicTools, read-only sandbox, approvalPolicy never, and a non-empty cwd path.
 * Two more keys are accepted, and neither can grant a tool, a writable path or an approval
 * path — one is a storage flag, the other is plain text:
 * - ephemeral: REQUIRED and exactly true. The official program then keeps the thread in memory
 *   and writes no rollout under CODEX_HOME/sessions, so paper text and answers never land on
 *   disk (app-server v2 schema, 0.156.0). Missing or false is not proved.
 * - baseInstructions: optional non-empty string replacing the official default coding-agent
 *   system prompt; the question path puts the paper's full text here.
 * Any other key (developerInstructions, config, personality, ...) is not proved.
 */
const ISOLATED_KEYS=new Set(['model','cwd','sandbox','approvalPolicy','environments','dynamicTools','ephemeral','baseInstructions']);
export function provesIsolation(value:unknown):boolean {
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return typeof v.model==='string'&&!!v.model.trim()
    &&typeof v.cwd==='string'&&!!v.cwd.trim()
    &&v.sandbox==='read-only'&&v.approvalPolicy==='never'
    &&Array.isArray(v.environments)&&v.environments.length===0
    &&Array.isArray(v.dynamicTools)&&v.dynamicTools.length===0
    &&v.ephemeral===true
    &&(!('baseInstructions' in v)||typeof v.baseInstructions==='string'&&!!v.baseInstructions.trim())
    &&Object.keys(v).every(key=>ISOLATED_KEYS.has(key));
}
function stable(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  return '{'+Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
}
/** Key-sorted JSON of own enumerable data only; null when the value cannot be written as JSON. */
function canonical(value:unknown):string|null {
  try{return stable(value);}catch{return null;}
}
/** One inbound JSON line may not exceed this; a larger one stops the transport (UNSAFE_RUNTIME). */
export const MAX_LINE_BYTES=1024*1024;
/** Private, bounded JSONL transport. Not an HTTP command proxy. Never logs raw events. */
export class JsonLineRpc implements GenerationRpc {
  private nextId=0;
  private buffer='';
  private ended=false;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private accountEventHandlers=new Set<(method:string,params:unknown)=>void>();
  private generationEventHandlers=new Set<(method:string,params:unknown)=>void>();
  private closeHandlers=new Set<(reason?:Error)=>void>();
  private stopReason:Error|null=null;
  /** The one proved thread request this transport may generate on, as the canonical JSON that
   * was proved and that thread/start writes byte for byte; null = locked. */
  private provedThread:string|null=null;
  constructor(private child:ChildStreams,private timeoutMs=180_000) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>this.receive(chunk));
    child.stdout.on('error',()=>this.stop(failure('NETWORK','공식 프로그램 응답을 읽을 수 없습니다.',true)));
    child.stderr.resume(); // Drain only: can contain personal paths/provider messages.
    child.stdin.on('error',()=>this.stop(failure('NETWORK','공식 프로그램 연결이 끊겼습니다.',true)));
    child.on('error',(error:NodeJS.ErrnoException)=>this.stop(error.code==='ENOENT'?Object.assign(failure('AUTH_REQUIRED','공식 Codex 프로그램을 설치해 주세요.'),{code:'ENOENT'}):failure('NETWORK','공식 프로그램을 실행할 수 없습니다.',true)));
    child.on('close',()=>this.stop(failure('NETWORK','공식 프로그램 연결이 종료되었습니다.',true)));
  }
  get closed():boolean { return this.ended; }
  isClosed():boolean { return this.ended; }
  request(method:string,params:unknown={}):Promise<unknown> {
    // Status + official in-process feature enablement always allowed; generation only on
    // the exact thread request whose isolation was proved (unlockGeneration), and only
    // with turn payloads that cannot re-enable tools.
    if(AUTH_METHODS.has(method)&&!validAuthParams(method,params))return Promise.reject(failure('UNSAFE_RUNTIME','인증 요청에 허용되지 않은 항목이 있습니다.'));
    if(!STATUS_METHODS.has(method)&&!FEATURE_METHODS.has(method)&&!AUTH_METHODS.has(method)) {
      if(!GENERATION_METHODS.has(method)||this.provedThread===null)return Promise.reject(failure('UNSAFE_RUNTIME','이 연결에서는 허용되지 않은 요청입니다.'));
      if(method==='thread/start'&&canonical(params)!==this.provedThread)return Promise.reject(failure('UNSAFE_RUNTIME','격리가 입증된 스레드 조건과 다른 요청입니다.'));
      if(!validGenerationParams(method,params))return Promise.reject(failure('UNSAFE_RUNTIME','턴 요청에 허용되지 않은 항목이 있습니다.'));
    }
    if(this.ended)return Promise.reject(failure('NETWORK','공식 프로그램 연결이 종료되었습니다.',true));
    const id=++this.nextId;
    // thread/start writes the proved canonical text itself, never a re-serialisation of the
    // caller's object: a toJSON, getter or prototype cannot change what the official program gets.
    const line=method==='thread/start'?`{"id":${id},"method":"thread/start","params":${this.provedThread}}`:JSON.stringify({id,method,params});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.stop(failure('NETWORK','공식 프로그램 응답 시간이 초과되었습니다.',true)),this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(line+'\n');
    });
  }
  initialized():void { if(!this.ended)this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n'); }
  /** Opens generation for THIS transport and ONLY for the given thread request, which must
   * itself carry every proved isolation condition. Passing anything else throws and the
   * transport stays locked; there is no way to unlock without such a request. */
  unlockGeneration(request:unknown):void {
    const refused=()=>failure('UNSAFE_RUNTIME','도구 격리 조건을 갖추지 못한 스레드에서는 생성을 시작할 수 없습니다.');
    if(!provesIsolation(request))throw refused();
    // Prove the bytes, not only the object: the canonical text is parsed back into plain data and
    // proved again, and that same text is what thread/start writes.
    const text=canonical(request);
    let parsed:unknown=null;
    try{parsed=text===null?null:JSON.parse(text);}catch{parsed=null;}
    if(text===null||!provesIsolation(parsed))throw refused();
    this.provedThread=text;
  }
  /** Legacy registration means generation events, not account notifications. */
  onEvent(handler:(method:string,params:unknown)=>void):void { this.onGenerationEvent(handler); }
  offEvent(handler:(method:string,params:unknown)=>void):void { this.offGenerationEvent(handler); }
  onAccountEvent(handler:(method:string,params:unknown)=>void):void { this.accountEventHandlers.add(handler); }
  offAccountEvent(handler:(method:string,params:unknown)=>void):void { this.accountEventHandlers.delete(handler); }
  onGenerationEvent(handler:(method:string,params:unknown)=>void):void { this.generationEventHandlers.add(handler); }
  offGenerationEvent(handler:(method:string,params:unknown)=>void):void { this.generationEventHandlers.delete(handler); }
  onClose(handler:(reason?:Error)=>void):void { if(this.ended)handler(this.stopReason??undefined);else this.closeHandlers.add(handler); }
  offClose(handler:(reason?:Error)=>void):void { this.closeHandlers.delete(handler); }
  private receive(chunk:string):void {
    if(this.ended)return;
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>MAX_LINE_BYTES){this.stop(Object.assign(failure('UNSAFE_RUNTIME','공식 응답 크기 제한을 초과했습니다.'),{oversize:true}));return;}
    let newline:number;
    while((newline=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,newline).trim();this.buffer=this.buffer.slice(newline+1);
      if(!line)continue;
      try {
        const msg=JSON.parse(line);
        if(!msg || typeof msg!=='object' || Array.isArray(msg))throw new Error();
        if(typeof msg.method==='string') {
          if('id' in msg){
            this.child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'PaperRead denies all server requests'}})+'\n');
            this.stop(failure('UNSAFE_RUNTIME','도구·권한·인증정보 요청을 거절했습니다.'));return;
          }
          if(EVENT_METHODS.has(msg.method)){
            const params=(msg as {params?:unknown}).params;
            for(const handler of this.accountEventHandlers){
              try{handler(msg.method,params);}catch{this.stop(failure('UNSAFE_RUNTIME','이벤트 처리 중 안전 위반이 발생했습니다.'));return;}
            }
            continue;
          }
          if(msg.method.startsWith('item/')||msg.method.startsWith('turn/')){
            // Account listeners cannot make a generation event safe. A generation
            // notification without a generation consumer is a fail-closed violation.
            if(this.generationEventHandlers.size===0){
              this.stop(failure('UNSAFE_RUNTIME','예상하지 않은 생성·도구 이벤트를 감지했습니다.'));return;
            }
            const params=(msg as {params?:unknown}).params;
            for(const handler of this.generationEventHandlers){
              try{handler(msg.method,params);}catch{this.stop(failure('UNSAFE_RUNTIME','이벤트 처리 중 안전 위반이 발생했습니다.'));return;}
            }
            continue;
          }
          if(msg.method==='thread/tokenUsage/updated'){
            // Token counts only: this notification cannot run anything, so with no running turn
            // to report to it is dropped silently instead of failing closed.
            if(this.generationEventHandlers.size===0)continue;
            const params=(msg as {params?:unknown}).params;
            for(const handler of this.generationEventHandlers){
              try{handler(msg.method,params);}catch{this.stop(failure('UNSAFE_RUNTIME','이벤트 처리 중 안전 위반이 발생했습니다.'));return;}
            }
            continue;
          }
          continue;
        }
        if(typeof msg.id!=='number'||(!('result' in msg)&&!('error' in msg)))throw new Error();
        const pending=this.pending.get(msg.id);if(!pending)continue;
        clearTimeout(pending.timer);this.pending.delete(msg.id);
        if(msg.error)pending.reject(mapRpcError(msg.error));else pending.resolve(msg.result);
      } catch { this.stop(failure('UNSAFE_RUNTIME','공식 응답 형식을 확인할 수 없습니다.'));return; }
    }
  }
  private stop(error:Error):void {
    if(this.ended)return;this.ended=true;this.stopReason=error;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.buffer='';
    const closeHandlers=[...this.closeHandlers];
    this.closeHandlers.clear();
    this.accountEventHandlers.clear();
    this.generationEventHandlers.clear();
    // A turn that already got its turn/start reply has no pending request: the close observer
    // is the only way it learns the real reason (an UNSAFE_RUNTIME stop is not a network loss).
    for(const handler of closeHandlers){try{handler(error);}catch{/* lifecycle observers cannot keep shutdown from completing */}}
    this.child.kill();
  }
  async close():Promise<void>{this.stop(failure('NETWORK','PaperRead 연결이 해제되었습니다.',true));}
}
/** Closed transports must never be reused, including transports supplied by tests. */
export function isRpcClosed(rpc:Rpc):boolean {
  try {
    if(rpc.isClosed?.()===true)return true;
  } catch { return true; }
  return rpc.closed===true;
}
export function mapRpcError(value:unknown):Error & AppError {
  const e=value as {code?:number;message?:string;data?:{codexErrorInfo?:string}};
  const info=e?.data?.codexErrorInfo;const status=e?.code;
  if(status===401||info==='unauthorized')return failure('AUTH_REQUIRED','공식 Codex에서 다시 로그인해 주세요.');
  if(status===429||info==='usageLimitExceeded')return failure('QUOTA','구독 사용 한도에 도달했습니다.');
  // Codex reports prompt/context input-limit rejections before a turn starts. Preserve
  // that distinction so the pipeline can split only the overflowing page.
  // 'contextWindowExceeded' is the v2 schema's name for it (0.156.0).
  if(status===413||info==='contextLengthExceeded'||info==='contextWindowExceeded'||info==='inputTooLarge'||info==='promptTooLong')return failure('TOO_LARGE','번역 입력이 Codex 한도를 초과했습니다.',true);
  if(info==='modelNotFound')return failure('MODEL_UNAVAILABLE','선택한 모델을 사용할 수 없습니다.');
  if(status===-32001)return failure('BUSY','공식 프로그램이 다른 요청을 처리 중입니다.',true);
  // Keep the official message on the Error only (diagnosable); never widen the user-facing contract.
  return Object.assign(failure('NETWORK','공식 프로그램 요청이 실패했습니다.',true),{officialMessage:typeof e?.message==='string'?e.message:null,officialCode:status??null});
}
