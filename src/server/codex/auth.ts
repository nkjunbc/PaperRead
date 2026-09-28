import { randomUUID } from 'node:crypto';
import type {
  AppError,
  Connection,
  LoginAttempt,
  LoginAttemptResult,
  LoginStartResult,
  LogoutResult,
} from '../../shared/contracts';
import { failure, isKnownSubscriptionPlan, isRpcClosed, type GenerationRpc } from './rpc';
import { startOfficialRpc } from './runtime';
import type { AccountSession } from './auth-contract';

const DEFAULT_TIMEOUT_MS=10*60*1000;
const AUTH_EVENT='account/login/completed';
const ALLOWED_LOGIN_HOSTS=new Set(['auth.openai.com','chatgpt.com']);
const ERROR_CODES:ReadonlySet<string>=new Set(['INVALID_INPUT','NOT_FOUND','NETWORK','TOO_LARGE','UNSUPPORTED_PDF','SOURCE_CHANGED','AUTH_REQUIRED','SUBSCRIPTION_REQUIRED','QUOTA','MODEL_UNAVAILABLE','BUSY','INVALID_TRANSLATION','STORAGE','UNSAFE_RUNTIME','INTERNAL']);

export interface AccountAuthenticatorOptions {
  now?:()=>number;
  timeoutMs?:number;
}
type RpcFactory=()=>Promise<GenerationRpc>;
type AccountKind='signed_out'|'subscription'|'api_key'|'unavailable';
type AuthRecord={
  attempt:LoginAttempt;
  officialLoginId:string;
  loginUrl:string;
  generation:number;
  invalidateCallbacks:boolean;
  timer:ReturnType<typeof setTimeout>|null;
  cleanupPromise:Promise<void>|null;
  cleanupFailure:Error|null;
};

function object(value:unknown):Record<string,unknown>|null {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function appError(error:unknown,fallbackCode:AppError['code'],message:string):Error & AppError {
  const candidate=error as {code?:unknown;retryable?:unknown};
  const code=typeof candidate?.code==='string'&&ERROR_CODES.has(candidate.code)?candidate.code as AppError['code']:fallbackCode;
  const retryable=typeof candidate?.retryable==='boolean'?candidate.retryable:fallbackCode==='NETWORK';
  return failure(code,message,retryable);
}
function notFound():Error & AppError {
  return failure('NOT_FOUND','로그인 시도를 찾을 수 없습니다.');
}
function emptyConnection(status:Connection['status']):Connection {
  return {status,modelIds:[],defaultModelId:null,limits:null};
}
/** Official ChatGPT account lifecycle, kept separate from translation. */
export class AccountAuthenticator implements AccountSession {
  private readonly now:()=>number;
  private readonly timeoutMs:number;
  private rpc:Promise<GenerationRpc>|null=null;
  private activeRpc:GenerationRpc|null=null;
  private eventRpc:GenerationRpc|null=null;
  private detachAccountEvents:(()=>void)|null=null;
  private detachCloseObserver:(()=>void)|null=null;
  private readonly records=new Map<string,AuthRecord>();
  private serial:Promise<unknown>=Promise.resolve();
  private generation=0;
  private stopped=false;

  constructor(private readonly factory:RpcFactory=startOfficialRpc,options:AccountAuthenticatorOptions={}) {
    this.now=options.now??(()=>Date.now());
    this.timeoutMs=typeof options.timeoutMs==='number'&&Number.isFinite(options.timeoutMs)&&options.timeoutMs>=0
      ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  private enqueue<T>(task:()=>Promise<T>):Promise<T> {
    const run=this.serial.then(task,task);
    this.serial=run.then(()=>undefined,()=>undefined);
    return run;
  }

  private async getRpc():Promise<GenerationRpc> {
    if(this.stopped)throw failure('NETWORK','공식 Codex 연결이 종료되었습니다.',true);
    const cached=this.rpc;
    if(cached){
      try {
        const rpc=await cached;
        if(!isRpcClosed(rpc)){
          this.observeRpc(rpc);
          return rpc;
        }
        this.invalidateRpc(rpc,cached);
      } catch(error) {
        if(this.rpc===cached)this.rpc=null;
        throw error;
      }
    }
    if(this.stopped)throw failure('NETWORK','공식 Codex 연결이 종료되었습니다.',true);
    const pending=Promise.resolve().then(this.factory);
    const owned=pending.catch(error=>{if(this.rpc===owned)this.rpc=null;throw error;});
    this.rpc=owned;
    try {
      const rpc=await owned;
      if(this.stopped){
        await rpc.close().catch(()=>{});
        throw failure('NETWORK','공식 Codex 연결이 종료되었습니다.',true);
      }
      if(isRpcClosed(rpc)){
        this.invalidateRpc(rpc,owned);
        throw failure('NETWORK','공식 Codex 연결이 이미 종료되었습니다.',true);
      }
      this.observeRpc(rpc);
      return rpc;
    } catch(error) {
      if(this.rpc===owned)this.rpc=null;
      throw error;
    }
  }

  private observeRpc(rpc:GenerationRpc):void {
    if(this.activeRpc===rpc)return;
    this.detachObservers();
    this.activeRpc=rpc;
    this.eventRpc=rpc;
    const handler=(method:string,params:unknown)=>{
      if(method!==AUTH_EVENT)return;
      // Event notifications are not awaited by the JSONL parser. Deliberately
      // consume every rejection here so an auth callback cannot become an
      // unhandled process-level rejection.
      void this.handleCompletion(params).catch(()=>{/* status remains queryable */});
    };
    if(rpc.onAccountEvent){
      rpc.onAccountEvent(handler);
      this.detachAccountEvents=()=>rpc.offAccountEvent?.(handler);
    } else if(rpc.onEvent){
      // Test transports from before typed routing remain usable; the real
      // transport always supplies the account-specific subscription.
      rpc.onEvent(handler);
      this.detachAccountEvents=()=>rpc.offEvent?.(handler);
    }
    if(rpc.onClose){
      const onClose=()=>{
        if(this.activeRpc!==rpc)return;
        this.detachObservers();
        const current=this.rpc;
        if(current)void current.then(value=>{if(this.rpc===current&&value===rpc)this.rpc=null;},()=>{if(this.rpc===current)this.rpc=null;});
      };
      rpc.onClose(onClose);
      this.detachCloseObserver=()=>rpc.offClose?.(onClose);
    }
  }

  private detachObservers():void {
    this.detachAccountEvents?.();
    this.detachAccountEvents=null;
    this.detachCloseObserver?.();
    this.detachCloseObserver=null;
    this.activeRpc=null;
    this.eventRpc=null;
  }

  private invalidateRpc(rpc:GenerationRpc,owned:Promise<GenerationRpc>):void {
    if(this.activeRpc===rpc)this.detachObservers();
    if(this.rpc===owned)this.rpc=null;
  }

  private async readAccount(rpc:GenerationRpc):Promise<AccountKind> {
    try {
      const response=object(await rpc.request('account/read',{refreshToken:false}));
      if(!response||!('account' in response))throw failure('NETWORK','공식 계정 상태를 확인할 수 없습니다.',true);
      if(response.account===null)return 'signed_out';
      const account=object(response.account);
      if(account?.type==='chatgpt'&&isKnownSubscriptionPlan(account.planType))return 'subscription';
      if(account?.type==='apiKey')return 'api_key';
      return 'unavailable';
    } catch(error) {
      throw appError(error,'NETWORK','공식 계정 상태를 확인할 수 없습니다.');
    }
  }

  private async awaitPreviousCleanup():Promise<void> {
    const promises=[...this.records.values()]
      .map(record=>record.cleanupPromise)
      .filter((promise):promise is Promise<void>=>promise!==null);
    if(promises.length>0)await Promise.all(promises);
    const failed=[...this.records.values()].find(record=>record.cleanupFailure!==null);
    if(failed?.cleanupFailure)throw failed.cleanupFailure;
  }

  private clearTimer(record:AuthRecord):void {
    if(record.timer!==null){clearTimeout(record.timer);record.timer=null;}
  }

  private async ensureSignedOut(rpc:GenerationRpc):Promise<void> {
    const current=await this.readAccount(rpc);
    if(current==='signed_out')return;
    await rpc.request('account/logout',{});
    const after=await this.readAccount(rpc);
    if(after!=='signed_out')throw failure('NETWORK','공식 계정 로그아웃을 확인할 수 없습니다.',true);
  }

  private cleanupRecord(record:AuthRecord,force=false):Promise<void> {
    if(record.cleanupPromise)return record.cleanupPromise;
    if(record.cleanupFailure!==null&&!force)return Promise.reject(record.cleanupFailure);
    const promise=(async()=>{
      const rpc=await this.getRpc();
      await this.ensureSignedOut(rpc);
      record.cleanupFailure=null;
    })();
    record.cleanupPromise=promise;
    void promise.then(
      ()=>{if(record.cleanupPromise===promise)record.cleanupPromise=null;},
      error=>{record.cleanupFailure=appError(error,'NETWORK','공식 계정 정리를 확인할 수 없습니다.');if(record.cleanupPromise===promise)record.cleanupPromise=null;},
    );
    return promise;
  }

  private newerConfirmedRecord(record:AuthRecord):boolean {
    for(const candidate of this.records.values()){
      if(candidate.generation>record.generation&&candidate.attempt.status==='completed'&&!candidate.invalidateCallbacks)return true;
    }
    return false;
  }

  private async expireRecord(record:AuthRecord):Promise<void> {
    await this.enqueue(async()=>{
      if(record.attempt.status!=='pending'||this.now()<Date.parse(record.attempt.expiresAt))return;
      record.attempt={...record.attempt,status:'expired'};
      record.invalidateCallbacks=true;
      this.clearTimer(record);
      await this.cleanupRecord(record,true).catch(()=>{/* preserve expired state; retry on callbacks */});
    });
  }

  private async handleCompletion(params:unknown):Promise<void> {
    await this.enqueue(async()=>{
      if(this.stopped)return;
      const value=object(params);
      if(typeof value?.loginId!=='string')return;
      const record=[...this.records.values()].find(candidate=>candidate.officialLoginId===value.loginId);
      if(!record)return;
      if(this.newerConfirmedRecord(record))return;
      if(record.invalidateCallbacks||record.attempt.status==='cancelled'||record.attempt.status==='expired'){
        // A provider callback can arrive after cancellation has returned. A
        // fresh cleanup, rather than merely ignoring it, prevents credentials
        // from being revived; a newer login is guarded above.
        await this.cleanupRecord(record,true).catch(()=>{});
        return;
      }
      if(record.attempt.status!=='pending')return;
      if(value.success!==true){
        this.clearTimer(record);
        record.attempt={...record.attempt,status:'failed',error:failure('AUTH_REQUIRED','공식 로그인이 완료되지 않았습니다.')};
        return;
      }
      const rpc=await this.getRpc();
      let account:AccountKind;
      try{account=await this.readAccount(rpc);}catch{return;}
      if(account!=='subscription')return;
      this.clearTimer(record);
      record.attempt={...record.attempt,status:'completed',error:null};
    });
  }

  async startLogin():Promise<LoginStartResult> {
    return this.enqueue(async()=>{
      await this.awaitPreviousCleanup();
      const stale=[...this.records.values()].find(record=>record.attempt.status==='pending'&&this.now()>=Date.parse(record.attempt.expiresAt));
      if(stale){
        stale.attempt={...stale.attempt,status:'expired'};
        stale.invalidateCallbacks=true;
        this.clearTimer(stale);
        await this.cleanupRecord(stale,true).catch(error=>{throw appError(error,'NETWORK','공식 계정 정리를 확인할 수 없습니다.');});
      }
      const pending=[...this.records.values()].find(record=>{
        if(record.attempt.status!=='pending')return false;
        return this.now()<Date.parse(record.attempt.expiresAt);
      });
      if(pending)return {attempt:pending.attempt,loginUrl:pending.loginUrl};
      const rpc=await this.getRpc();
      const account=await this.readAccount(rpc);
      if(account==='subscription')throw failure('BUSY','이미 ChatGPT 구독으로 로그인되어 있습니다.');
      if(account==='api_key')throw failure('SUBSCRIPTION_REQUIRED','API 키 모드에서는 번역할 수 없습니다. ChatGPT 구독으로 로그인해 주세요.');
      if(account!=='signed_out')throw failure('NETWORK','공식 계정 상태를 확인할 수 없습니다.',true);
      const response=object(await rpc.request('account/login/start',{type:'chatgpt'}));
      if(response===null||Object.keys(response).some(key=>!['type','loginId','authUrl'].includes(key))||response.type!=='chatgpt'||typeof response.loginId!=='string'||!response.loginId||typeof response.authUrl!=='string'||!this.isAllowedLoginUrl(response.authUrl)){
        throw failure('UNSAFE_RUNTIME','공식 로그인 주소를 확인할 수 없습니다.');
      }
      const appLoginId=randomUUID();
      const attempt:LoginAttempt={
        loginId:appLoginId,
        status:'pending',
        expiresAt:new Date(this.now()+this.timeoutMs).toISOString(),
        error:null,
      };
      const record:AuthRecord={
        attempt,
        officialLoginId:response.loginId,
        loginUrl:response.authUrl,
        generation:++this.generation,
        invalidateCallbacks:false,
        timer:null,
        cleanupPromise:null,
        cleanupFailure:null,
      };
      this.records.set(appLoginId,record);
      record.timer=setTimeout(()=>{void this.expireRecord(record).catch(()=>{});},this.timeoutMs);
      const timer=record.timer as ReturnType<typeof setTimeout> & {unref?:()=>void};
      timer.unref?.();
      return {attempt,loginUrl:record.loginUrl};
    });
  }

  private isAllowedLoginUrl(value:string):boolean {
    try {
      const url=new URL(value);
      return url.protocol==='https:'&&ALLOWED_LOGIN_HOSTS.has(url.hostname)&&url.port===''&&url.username===''&&url.password==='';
    } catch{return false;}
  }

  async getLogin(loginId:string):Promise<LoginAttemptResult> {
    return this.enqueue(async()=>{
      const record=this.records.get(loginId);
      if(!record)throw notFound();
      if(record.attempt.status==='pending'&&this.now()>=Date.parse(record.attempt.expiresAt)){
        record.attempt={...record.attempt,status:'expired'};
        record.invalidateCallbacks=true;
        this.clearTimer(record);
        await this.cleanupRecord(record,true).catch(()=>{});
      }
      return {attempt:record.attempt};
    });
  }

  async cancelLogin(loginId:string):Promise<LoginAttemptResult> {
    return this.enqueue(async()=>{
      const record=this.records.get(loginId);
      if(!record)throw notFound();
      if(record.attempt.status!=='pending'){
        if(record.attempt.status==='cancelled'||record.attempt.status==='expired')await this.cleanupRecord(record,true).catch(()=>{});
        return {attempt:record.attempt};
      }
      record.attempt={...record.attempt,status:'cancelled'};
      record.invalidateCallbacks=true;
      this.clearTimer(record);
      const rpc=await this.getRpc();
      let cancellationError:Error|null=null;
      try {
        const response=object(await rpc.request('account/login/cancel',{loginId:record.officialLoginId}));
        if(response===null||Object.keys(response).some(key=>key!=='status')||(response.status!=='canceled'&&response.status!=='notFound'))throw failure('UNSAFE_RUNTIME','공식 로그인 취소 응답을 확인할 수 없습니다.');
      } catch(error){cancellationError=appError(error,'NETWORK','공식 로그인 취소에 실패했습니다.');}
      try{await this.cleanupRecord(record,true);}catch(error){if(cancellationError===null)cancellationError=appError(error,'NETWORK','공식 계정 정리를 확인할 수 없습니다.');}
      if(cancellationError)throw cancellationError;
      return {attempt:record.attempt};
    });
  }

  async logout():Promise<LogoutResult> {
    return this.enqueue(async()=>{
      const rpc=await this.getRpc();
      let firstError:Error|null=null;
      for(const record of this.records.values()){
        record.invalidateCallbacks=true;
        if(record.attempt.status==='pending'){
          record.attempt={...record.attempt,status:'cancelled'};
          this.clearTimer(record);
          try {
            const response=object(await rpc.request('account/login/cancel',{loginId:record.officialLoginId}));
            if(response===null||Object.keys(response).some(key=>key!=='status')||(response.status!=='canceled'&&response.status!=='notFound'))throw failure('UNSAFE_RUNTIME','공식 로그인 취소 응답을 확인할 수 없습니다.');
          } catch(error){firstError??=appError(error,'NETWORK','공식 로그인 취소에 실패했습니다.');}
        }
        if(record.attempt.status==='cancelled'){
          try{await this.cleanupRecord(record,true);}catch(error){firstError??=appError(error,'NETWORK','공식 계정 정리를 확인할 수 없습니다.');}
        }
      }
      try{await rpc.request('account/logout',{});}catch(error){throw appError(error,'NETWORK','공식 계정 로그아웃에 실패했습니다.');}
      const state=await this.readAccount(rpc);
      if(state!=='signed_out')throw failure('NETWORK','공식 계정 로그아웃을 확인할 수 없습니다.',true);
      if(firstError)throw firstError;
      return {connection:emptyConnection('signed_out')};
    });
  }

  /** Process shutdown only. This deliberately never sends account/logout. */
  async disconnect():Promise<void> {
    this.stopped=true;
    for(const record of this.records.values())this.clearTimer(record);
    const rpcPromise=this.rpc;
    this.rpc=null;
    this.detachObservers();
    if(rpcPromise)try{await(await rpcPromise).close();}catch{/* already stopped */}
  }
}
