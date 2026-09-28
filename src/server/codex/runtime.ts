import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import { failure, isRpcClosed, JsonLineRpc } from './rpc';

/** CLI overrides only. Not a claim that read-only blocks shell/file-read/MCP tools.
 * Sources: https://developers.openai.com/codex/config-reference
 *          https://developers.openai.com/codex/app-server
 * These are defense in depth for account inspection; no thread is started.
 * Deliberately no auto-compaction override: model_auto_compact_token_limit exists (config schema,
 * 0.156.0) but a huge value is clamped to about 90% of the context window, so it cannot switch
 * compaction off (measured against a loopback provider). chat.ts handles a compaction instead.
 */
export function restrictedArgs():string[] {
  return ['app-server','--listen','stdio://',...[
    'approval_policy="never"','sandbox_mode="read-only"','web_search="disabled"',
    'features.shell_tool=false','features.apps=false','features.hooks=false','features.multi_agent=false',
    'features.memories=false','features.goals=false','notify=[]','project_doc_max_bytes=0',
    // 0.156.0 otherwise opens every thread with a ~5,500-character developer message listing the
    // bundled skills and the user's own ~/.agents/skills (measured: 379 characters without it).
    // It does not remove the 'skills' tools the official program still declares (official source
    // ext/skills/src/extension.rs: an empty environments list counts as "cloud skills available"); a call to one is a
    // non-text item and ends the process like any tool.
    'skills.include_instructions=false',
    'shell_environment_policy.inherit="none"','shell_environment_policy.ignore_default_excludes=false',
    'model_provider="openai"',
    'cli_auth_credentials_store="file"',
  ].flatMap(value=>['-c',value])];
}
function appDataDirectory(env:NodeJS.ProcessEnv):string {
  const injected=env.PAPERREAD_DATA?.trim();
  if(injected)return resolve(injected);
  if(process.platform==='win32'){
    const local=env.LOCALAPPDATA?.trim();
    if(local)return resolve(local,'PaperRead');
    const profile=env.USERPROFILE?.trim();
    if(profile)return resolve(profile,'AppData','Local','PaperRead');
    return resolve(osHomedir(),'AppData','Local','PaperRead');
  }
  const xdg=env.XDG_DATA_HOME?.trim();
  if(xdg)return resolve(xdg,'paperread');
  const home=env.HOME?.trim()||osHomedir();
  return resolve(home,'.local','share','paperread');
}
/** Preserve only OS startup paths and an app-owned official state location.
 * In particular, an inherited CODEX_HOME is never allowed to select a user's
 * default Codex credentials. */
export function childEnvironment(env:NodeJS.ProcessEnv=process.env,dataDirectory?:string):NodeJS.ProcessEnv {
  const permitted=new Set(['path','systemroot','windir','comspec','pathext','temp','tmp','home','userprofile','appdata','localappdata']);
  const output=Object.fromEntries(Object.entries(env).filter(([key,value])=>permitted.has(key.toLowerCase())&&value!==undefined&&key.toLowerCase()!=='codex_home'));
  output.CODEX_HOME=resolve(dataDirectory?.trim()?resolve(dataDirectory):appDataDirectory(env),'.codex-home');
  return output;
}
/** Resolve native official npm binary on Windows: never run a .cmd through a shell. */
export async function resolveCodexExecutable():Promise<string> {
  const paths=(process.env.PATH??process.env.Path??'').split(delimiter);
  for(const directory of paths){
    if(!directory)continue;
    const direct=join(directory,process.platform==='win32'?'codex.exe':'codex');
    try{await access(direct);return direct;}catch{/* continue */}
    if(process.platform!=='win32')continue;
    const root=join(directory,'node_modules','@openai','codex','package.json');
    try {
      await access(root);
      const require=createRequire(root);
      const architecture=process.arch==='arm64'?'arm64':'x64';
      const target=architecture==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
      const pkg=require.resolve(`@openai/codex-win32-${architecture}/package.json`);
      const binary=join(dirname(pkg),'vendor',target,'bin','codex.exe');await access(binary);return binary;
    }catch{/* do not install or prompt */}
  }
  throw Object.assign(new Error('Codex is not installed'),{code:'ENOENT'});
}
export interface OfficialRpcOptions { dataDirectory?:string }
export async function startOfficialRpc(options:OfficialRpcOptions={}):Promise<JsonLineRpc> {
  const executable=await resolveCodexExecutable();
  const env=childEnvironment(process.env,options.dataDirectory);
  // Measured on 0.155.1: the official program refuses to start when CODEX_HOME is missing
  // ("CODEX_HOME points to ..., but that path does not exist") and never creates it itself.
  await mkdir(env.CODEX_HOME as string,{recursive:true});
  const child=spawn(executable,restrictedArgs(),{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env});
  const rpc=new JsonLineRpc(child);
  try{
    await rpc.request('initialize',{clientInfo:{name:'paperread',title:'PaperRead',version:'0.1.0'},capabilities:{experimentalApi:true}});
    rpc.initialized();return rpc;
  }catch(error){await rpc.close();throw error;}
}
/** Build one process factory for the translator and account session to share.
 * The owner must call both modules' shutdown methods only when the service
 * itself is stopping; ordinary account/connection reads must not close it. */
export function createOfficialRpcFactory(start:()=>Promise<JsonLineRpc>=startOfficialRpc):()=>Promise<JsonLineRpc> {
  let shared:Promise<JsonLineRpc>|null=null;
  return async()=>{
    for(;;){
      const existing=shared;
      if(existing){
        try {
          const rpc=await existing;
          if(!isRpcClosed(rpc))return rpc;
          if(shared===existing)shared=null;
        } catch(error) {
          if(shared===existing)shared=null;
          throw error;
        }
        continue;
      }
      const pending=Promise.resolve().then(start);
      let owned!:Promise<JsonLineRpc>;
      owned=pending.then(rpc=>{
        if(isRpcClosed(rpc))throw failure('NETWORK','공식 Codex 연결이 이미 종료되었습니다.',true);
        rpc.onClose?.(()=>{if(shared===owned)shared=null;});
        return rpc;
      }).catch(error=>{
        if(shared===owned)shared=null;
        throw error;
      });
      shared=owned;
      return owned;
    }
  };
}
