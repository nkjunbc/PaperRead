import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { SourceError } from '../arxiv/index';

export interface PublicAddress { address: string; family: number }
interface NetworkResponse { status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array> }
/** Trusted service/test dependencies, never API request fields. */
export interface PublicNetworkOptions {
  lookup?: (host: string) => Promise<PublicAddress[]>;
  request?: (url: URL, addresses: PublicAddress[], signal: AbortSignal) => Promise<NetworkResponse>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) reserved.addSubnet(address, prefix, 'ipv4');

export function validatePublicUrl(input: string): URL {
  const invalid = () => new SourceError('INVALID_INPUT', '공개된 HTTPS 논문 또는 PDF 주소를 입력하세요. 로컬 주소·인증정보·별도 포트는 허용하지 않습니다.');
  if (typeof input !== 'string' || input.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(input)) throw invalid();
  // Check raw authority before URL normalization hides numeric IPs, credentials or a port.
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (!authority || /[@:%\[\]]/.test(authority)) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname) ||
      !url.hostname.includes('.') || url.hostname.endsWith('.') || /\.(?:localhost|local|internal|home|lan|test|invalid)$/i.test(url.hostname)) throw invalid();
  url.hash = '';
  return url;
}

/** Each request uses only the vetted IPv4 addresses. No second DNS lookup, proxy, cookie or automatic redirect. */
function pinnedRequest(url: URL, addresses: PublicAddress[], signal: AbortSignal): Promise<NetworkResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: 'GET', agent: false, signal,
      headers: { Accept: 'application/pdf,text/html;q=0.9', 'User-Agent': 'PaperRead/0.1' },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, 4);
      },
    }, (res) => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(res.headers)) headers[key] = Array.isArray(value) ? value.join(',') : value;
      resolve({ status: res.statusCode ?? 0, headers, body: res });
    });
    req.once('error', reject);
    req.end();
  });
}

function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Bounded HTTPS GET. Every redirect gets fresh DNS validation, then a connection pinned to that result. */
export async function publicGet(input: string, options: PublicNetworkOptions = {}): Promise<{ url: string; bytes: Buffer; contentType: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000, maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new SourceError('INVALID_INPUT', '다운로드 제한이 올바르지 않습니다.');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  let url = validatePublicUrl(input);
  try {
    for (let redirect = 0; redirect <= 5; redirect++) {
      signal.throwIfAborted();
      const addresses = await aborted((options.lookup ?? ((host) => lookup(host, { all: true, family: 4 })))(url.hostname), signal);
      if (!addresses.length || addresses.some((a) => a.family !== 4 || isIP(a.address) !== 4 || reserved.check(a.address, 'ipv4'))) {
        throw new SourceError('INVALID_INPUT', '로컬·사설망·예약 주소로는 연결할 수 없습니다.');
      }
      const response = await aborted((options.request ?? pinnedRequest)(url, addresses, signal), signal);
      // Always close the stream, including redirects, non-200 responses and size errors.
      const iterator = response.body[Symbol.asyncIterator]();
      try {
        if (response.status >= 300 && response.status < 400) {
          if (redirect === 5 || !response.headers.location) throw new SourceError('NETWORK', '논문 주소의 리디렉션을 확인할 수 없습니다.', true);
          url = validatePublicUrl(new URL(response.headers.location, url).href);
          continue;
        }
        if ([401, 403, 404].includes(response.status)) throw new SourceError('NOT_FOUND', '로그인 없이 접근할 수 있는 공개 PDF를 찾지 못했습니다. PDF 직접 주소를 확인하세요.');
        if (response.status !== 200) throw new SourceError('NETWORK', `논문 다운로드 응답 오류 (${response.status}).`, true);
        const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const limit = contentType === 'text/html' || contentType === 'application/xhtml+xml' ? Math.min(maxBytes, 2 * 1024 * 1024) : maxBytes;
        if (Number(response.headers['content-length']) > limit) throw new SourceError('TOO_LARGE', '논문 다운로드 크기 제한을 초과했습니다.');
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new SourceError('NETWORK', '압축된 다운로드 응답은 지원하지 않습니다. PDF 직접 주소를 확인하세요.');
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const { done, value } = await aborted(iterator.next(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new SourceError('TOO_LARGE', '논문 다운로드 크기 제한을 초과했습니다.');
          chunks.push(value);
        }
        return { url: url.href, bytes: Buffer.concat(chunks, size), contentType };
      } finally { if (iterator.return) await iterator.return().catch(() => {}); }
    }
    throw new SourceError('NETWORK', '논문 주소의 리디렉션이 너무 많습니다.', true);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError('NETWORK', '논문 연결이 중단되었거나 시간을 초과했습니다.', true);
  } finally { controller.abort(); }
}
