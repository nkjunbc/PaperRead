import { mkdir, open, readFile, unlink, link, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Paper, Block } from '../../shared/contracts';
import { normalizeArxiv, SourceError } from './index';
import { extractPdf, sha256, type ExtractionOptions } from '../pdf/index';

export interface FetchOptions {
  /** Trusted dependency injection for tests; never supplied by API clients. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface AcquireOptions extends FetchOptions, ExtractionOptions {
  /** App-owned directory supplied by the service, not a user URL/path. */
  directory: string;
  expectedSha256?: string;
}
async function boundedGet(url:string, limit:number, options:FetchOptions):Promise<Uint8Array> {
  const timeoutMs=options.timeoutMs??30_000;
  if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1) throw new SourceError('INVALID_INPUT','다운로드 제한이 올바르지 않습니다.');
  const signal=options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response:Response|undefined;
  try {
    response=await (options.fetch??globalThis.fetch)(url,{redirect:'manual',credentials:'omit',signal,headers:{Accept:url.includes('/api/')?'application/atom+xml':'application/pdf'}});
    if(response.status>=300&&response.status<400 || response.redirected) throw new SourceError('INVALID_INPUT','arXiv 리디렉션 응답을 허용하지 않습니다.',false,'REDIRECT');
    if(response.url && response.url!==url) throw new SourceError('INVALID_INPUT','arXiv 출처가 일치하지 않습니다.',false,'ORIGIN');
    if(response.status===404) throw new SourceError('NOT_FOUND','해당 arXiv 논문을 찾지 못했습니다.');
    if(!response.ok) throw new SourceError('NETWORK',`arXiv 응답 오류 (${response.status}).`,true);
    if(Number(response.headers.get('content-length'))>limit) throw new SourceError('TOO_LARGE','다운로드 크기 제한을 초과했습니다.');
    if(!response.body) throw new SourceError('NETWORK','arXiv 응답이 비어 있습니다.',true);
    const reader=response.body.getReader(); const chunks:Uint8Array[]=[];let size=0;
    try {
      while(true) {
        signal.throwIfAborted();const {done,value}=await reader.read(); if(done) break;
        size+=value.byteLength;
        if(size>limit) throw new SourceError('TOO_LARGE','다운로드 크기 제한을 초과했습니다.');
        chunks.push(value);
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    return new Uint8Array(Buffer.concat(chunks,size));
  } catch(error) {
    if(response?.body && !response.body.locked) await response.body.cancel().catch(()=>{});
    if(error instanceof SourceError) throw error;
    throw new SourceError('NETWORK','arXiv 연결이 중단되었거나 시간이 초과되었습니다.',true);
  }
}
function xmlText(value:string):string {
  if(/<[^>]*>/.test(value)) throw new SourceError('NETWORK','예상하지 못한 arXiv 메타데이터 구조입니다.',true);
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity:string)=>{
    if(entity.startsWith('#')) {const n=entity[1]==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'\ufffd';}
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity]??'';
  }).replace(/\s+/g,' ').trim();
}
/** One bounded Atom entry: the identifier it pins plus the title and authors it carries. */
async function readAtomEntry(query:string, expectedArxivId:string, options:FetchOptions):Promise<{pinned:ReturnType<typeof normalizeArxiv>;title:string|null;authors:string[]}> {
  const bytes=await boundedGet(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(query)}`,1024*1024,options);
  const xml=new TextDecoder().decode(bytes);
  if(/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml) || !/<feed\b[^>]*xmlns="http:\/\/www.w3.org\/2005\/Atom"/.test(xml)) throw new SourceError('NETWORK','arXiv Atom 응답을 확인할 수 없습니다.',true);
  const entries=[...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)];
  if(!entries.length) throw new SourceError('NOT_FOUND','해당 arXiv 논문을 찾지 못했습니다.');
  if(entries.length!==1) throw new SourceError('NETWORK','arXiv 메타데이터가 모호합니다.',true);
  const entry=entries[0][1], rawId=/<id>([^<]+)<\/id>/.exec(entry)?.[1]?.trim();
  if(!rawId || !/^https?:\/\/arxiv\.org\/abs\//.test(rawId)) throw new SourceError('NOT_FOUND','arXiv 논문 버전을 찾지 못했습니다.');
  const pinned=normalizeArxiv(rawId.replace(/^http:/,'https:'));
  if(pinned.arxivId!==expectedArxivId || pinned.version===null) throw new SourceError('SOURCE_CHANGED','arXiv 식별자 또는 버전이 일치하지 않습니다.');
  const title=xmlText(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1]??'')||null;
  const authors=[...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map(m=>xmlText(m[1]));
  return {pinned,title,authors};
}
/** Read only bounded Atom fields. No HTML parsing, entity expansion, URL following or XML execution. */
export async function resolveArxiv(input:string, options:FetchOptions={}):Promise<Paper> {
  let id=normalizeArxiv(input);let title:string|null=null;let authors:string[]=[];
  if(id.version===null) {
    // Pinning the revision needs the entry, so any problem here is a real failure.
    const entry=await readAtomEntry(id.arxivId,id.arxivId,options);
    id=entry.pinned;title=entry.title;authors=entry.authors;
  } else {
    // A pinned revision only *wants* its title and authors: the entry is asked for, but a
    // failed, slow or mismatched answer leaves them empty instead of blocking the open.
    try {
      const entry=await readAtomEntry(id.paperKey,id.arxivId,{...options,timeoutMs:options.timeoutMs??10_000});
      if(entry.pinned.paperKey===id.paperKey){title=entry.title;authors=entry.authors;}
    } catch(error) {
      if(options.signal?.aborted) throw error;
    }
  }
  return {paperKey:id.paperKey,arxivId:id.arxivId,version:id.version!,title,authors,sourceUrl:`https://arxiv.org/pdf/${id.paperKey}`,pdfSha256:null,pageCount:null,extractionVersion:null,status:'fetching',coverage:null,createdAt:new Date().toISOString()};
}

/** Existing revision bytes are immutable. Temp + exclusive hard-link publication never replaces them. */
async function publish(directory:string,key:string,bytes:Uint8Array,hash:string):Promise<string> {
  const root=resolve(directory), destination=join(root,`${sha256(key)}.pdf`), temporary=join(root,`.${randomUUID()}.part`);
  try {
    await mkdir(root,{recursive:true});
    const handle=await open(temporary,'wx',0o600);
    try {await handle.writeFile(bytes);await handle.sync();} finally {await handle.close();}
    try {await link(temporary,destination);}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
      const stat=await lstat(destination);
      if(!stat.isFile() || stat.isSymbolicLink()) throw new SourceError('STORAGE','안전하지 않은 PDF 저장 경로입니다.');
      if(stat.size!==bytes.length || sha256(await readFile(destination))!==hash) throw new SourceError('SOURCE_CHANGED','같은 arXiv 버전의 PDF가 변경되었습니다. 기존 결과를 유지합니다.');
    }
    return destination;
  } catch(error) {
    if(error instanceof SourceError) throw error;
    throw new SourceError('STORAGE','원본 PDF를 저장할 수 없습니다.');
  } finally {await unlink(temporary).catch(()=>{});}
}
export async function acquirePaper(input:string, options:AcquireOptions):Promise<{paper:Paper;blocks:Block[];pdfPath:string}> {
  const paper=await resolveArxiv(input,options);
  const bytes=await boundedGet(paper.sourceUrl,options.maxBytes??50*1024*1024,options);
  const hash=sha256(bytes);
  if(options.expectedSha256 && options.expectedSha256!==hash) throw new SourceError('SOURCE_CHANGED','같은 arXiv 버전의 PDF가 변경되었습니다.');
  const extraction=await extractPdf(bytes,paper.paperKey,options);
  const pdfPath=await publish(options.directory,paper.paperKey,bytes,hash);
  const {coverage,blocks,extractionVersion}=extraction;
  return {pdfPath,blocks,paper:{...paper,pdfSha256:hash,pageCount:coverage.totalPages,coverage,extractionVersion,
    status:coverage.textPages===0?'unsupported':coverage.unsupportedPages.length || blocks.some(b=>b.kind==='unsupported')?'partial':'ready'}};
}
 export const acquireArxiv = acquirePaper;
 export const resolvePaper = resolveArxiv;
