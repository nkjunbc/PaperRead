import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failure, isRpcClosed, provesIsolation, type GenerationRpc } from './rpc';
export { TEXT_ONLY_ITEM_TYPES } from './rpc';

/** The exact, complete set of parameters that made tool execution impossible in the
 * measured probe (scripts/probe-isolation.ts + .result.json): no environments, no
 * dynamic tools, read-only sandbox, no approval path, and an empty scratch cwd.
 * Widening or dropping any one of them is UNSAFE_RUNTIME, never a warning.
 * `ephemeral` and `baseInstructions` ride on the same proved object but are not tool
 * conditions: one is a storage flag, the other plain text (see provesIsolation).
 */
export interface IsolatedThreadRequest {
  model:string; cwd:string;
  sandbox:'read-only'; approvalPolicy:'never';
  environments:never[]; dynamicTools:never[];
  /** Always true: the thread lives in the official program's memory only and no rollout file
   * (which would hold paper text) is written under CODEX_HOME/sessions. */
  ephemeral:true;
  /** The thread's system prompt, replacing the official coding-agent default. Question threads only. */
  baseInstructions?:string;
}
export const UNSAFE_THREAD_REASON='도구 격리 조건(environments:[], dynamicTools:[], read-only sandbox, approvalPolicy:never, 빈 임시 작업 폴더)과 디스크에 남기지 않는 임시 스레드(ephemeral) 조건을 모두 갖추지 못한 스레드에서는 생성을 시작하지 않습니다.';

export function isolatedThreadRequest(model:string,cwd:string,instructions?:string):IsolatedThreadRequest {
  const request:IsolatedThreadRequest={model,cwd,sandbox:'read-only',approvalPolicy:'never',environments:[],dynamicTools:[],ephemeral:true};
  return instructions===undefined?request:{...request,baseInstructions:instructions};
}
function record(value:unknown):Record<string,unknown>|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
/** Structural proof, not a trusted flag: the object itself must carry every condition. */
export function assertIsolatedRequest(value:unknown):IsolatedThreadRequest {
  if(!provesIsolation(value))throw failure('UNSAFE_RUNTIME',UNSAFE_THREAD_REASON);
  return value as IsolatedThreadRequest;
}
export interface IsolatedThread {
  threadId:string; cwd:string; request:IsolatedThreadRequest;
  /** Ends the official thread (unsubscribe, so the official program unloads it) while the
   * connection is open, returns whatever the run left in the scratch directory (must be
   * empty), then deletes it. */
  release():Promise<string[]>;
}
/** Scratch directories are named by purpose so a leftover one says which path made it. */
export type ScratchPrefix='paperread-translate-'|'paperread-chat-';
export interface IsolatedThreadOptions {
  /** The thread's system prompt (baseInstructions). Omitted for translation threads. */
  instructions?:string;
  scratchPrefix?:ScratchPrefix;
  /** Test seam only: the plain JSON copy of whatever it returns must still pass the structural
   * proof, and that copy (not the returned object) is what is proved and sent. */
  build?:(model:string,cwd:string,instructions?:string)=>IsolatedThreadRequest;
}
/** Plain JSON data only: whatever toJSON, getter or prototype the built object has, the proof,
 * the key and the payload are all this one copy. */
function plainCopy(value:unknown):unknown {
  try{const text=JSON.stringify(value);return typeof text==='string'?JSON.parse(text):null;}catch{return null;}
}
/** The ONLY way generation is ever unlocked: the proved request object is both the key
 * given to unlockGeneration and the exact payload of thread/start.
 */
export async function openIsolatedThread(
  rpc:GenerationRpc,
  model:string,
  options:IsolatedThreadOptions={},
):Promise<IsolatedThread> {
  const build=options.build??isolatedThreadRequest;
  const cwd=await mkdtemp(join(tmpdir(),options.scratchPrefix??'paperread-translate-'));
  const discard=async()=>{await rm(cwd,{recursive:true,force:true}).catch(()=>{/* best effort */});};
  try {
    const request=assertIsolatedRequest(plainCopy(build(model,cwd,options.instructions)));
    if(request.cwd!==cwd)throw failure('UNSAFE_RUNTIME',UNSAFE_THREAD_REASON);
    if((await readdir(cwd)).length!==0)throw failure('UNSAFE_RUNTIME',UNSAFE_THREAD_REASON);
    rpc.unlockGeneration(request);
    const started=record(await rpc.request('thread/start',request));
    const threadId=record(started?.thread)?.id;
    if(typeof threadId!=='string'||!threadId)throw failure('NETWORK','공식 프로그램이 스레드를 열지 못했습니다.',true);
    let ended=false;
    const end=()=>{
      // Best effort and not awaited: a dropped thread would otherwise stay loaded in the official
      // process (with its paper text) until the process ends. A closed process took it along.
      if(ended||isRpcClosed(rpc))return;
      ended=true;
      try{void rpc.request('thread/unsubscribe',{threadId}).catch(()=>{/* the process may be stopping */});}catch{/* same */}
    };
    return {threadId,cwd,request,release:async()=>{end();const left=await readdir(cwd).catch(()=>[] as string[]);await discard();return left;}};
  } catch(error){await discard();throw error;}
}
