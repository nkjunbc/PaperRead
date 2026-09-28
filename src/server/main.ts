import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Block, Paper } from '../shared/contracts';
import { PaperStore } from './store/index';
import { JobManager } from './jobs/state';
import { AccountAuthenticator, CodexTranslator, createOfficialRpcFactory } from './codex/index';
import { startOfficialRpc } from './codex/runtime';
import { TranslationPipeline, type PipelineLogEvent } from './translation/index';
import { LOOPBACK, createApiServer, type ApiLogEvent, type ApiServer, type PaperAcquirer } from './api/index';
import { acquirePaper, resolveArxiv } from './arxiv/acquire';
import { normalizeArxiv } from './arxiv/index';
import { extractPdf, inferTitle } from './pdf/index';

/**
 * App-owned data folder. Deliberately outside the source tree and outside the
 * browser's storage, so clearing the browser cache never loses a translation.
 */
export function defaultDataDirectory(): string {
  const base =
    process.env.PAPERREAD_DATA ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'PaperRead')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'paperread'));
  return resolve(base);
}

/**
 * Real arXiv acquisition wired to the verified T2 modules.
 *
 * `resolve` pins the revision (and only that) inside the open request.
 * `acquire` downloads and extracts afterwards; the caller's raw input is only
 * ever passed to the arXiv normaliser, never into a command string.
 */
export function realAcquirer(directory: string): PaperAcquirer {
  return {
    identify(input: string): string | null {
      try {
        const id = normalizeArxiv(input);
        return id.version === null ? null : id.paperKey;
      } catch {
        return null;
      }
    },
    async resolve(input: string): Promise<Paper> {
      return resolveArxiv(input);
    },
    async acquire(paperKey: string, input: string): Promise<{ paper: Paper; blocks: Block[]; pdf: Buffer }> {
      // Re-resolving from the pinned key keeps the revision fixed even when the
      // user typed a version-less address.
      const result = await acquirePaper(paperKey, { directory });
      const pdf = readFileSync(result.pdfPath);
      // arXiv metadata wins; the page-1 heading only fills a title the entry did not give.
      return { paper: { ...result.paper, title: result.paper.title ?? inferTitle(result.blocks) }, blocks: result.blocks, pdf };
    },
    async reextract(paper: Paper, pdf: Buffer): Promise<{ paper: Paper; blocks: Block[] }> {
      const { blocks, coverage, extractionVersion } = await extractPdf(pdf, paper.paperKey);
      return {
        blocks,
        paper: {
          ...paper,
          title: paper.title ?? inferTitle(blocks),
          pageCount: coverage.totalPages,
          coverage,
          extractionVersion,
          status: coverage.textPages === 0 ? 'unsupported' : coverage.unsupportedPages.length || blocks.some((block) => block.kind === 'unsupported') ? 'partial' : 'ready',
        },
      };
    },
  };
}

/**
 * Stored revisions from before titles were kept show their paper key in the library. Give
 * each readable one without a title the page-1 heading, once, at start. Real metadata is not
 * fetched here: this touches no network and never overwrites a stored title.
 */
export function backfillTitles(store: PaperStore): number {
  let updated = 0;
  for (const key of store.listPapers()) {
    const paper = store.getPaper(key);
    if (paper === null || paper.title !== null) continue;
    if (paper.status !== 'ready' && paper.status !== 'partial') continue;
    const title = inferTitle(store.listBlocks(key));
    if (title === null) continue;
    try {
      store.savePaper({ ...paper, title });
      updated += 1;
    } catch {
      /* a title is a convenience; a storage fault surfaces on the paper's own routes */
    }
  }
  return updated;
}

export interface ServiceOptions {
  dataDirectory?: string;
  port?: number;
  /** Absolute path to the client entry document, when one should be served. */
  indexHtml?: string;
  log?: (event: ApiLogEvent | PipelineLogEvent) => void;
}

export interface Service {
  server: ApiServer;
  store: PaperStore;
  jobs: JobManager;
  url: string;
  token: string;
  dataDirectory: string;
  stop(): Promise<void>;
}

/**
 * Bring up the whole local service: storage, job state, the official Codex
 * translator, the sequential pipeline and the loopback HTTP API.
 *
 * Interrupted jobs are recovered inside `listen`, before the first request is
 * answered, so a hard kill never leaves a job claiming to be running.
 */
/**
 * Serves the built client's asset files from one directory.
 *
 * Path containment is explicit: only a single flat name is accepted, and the
 * resolved path must still sit inside the asset directory. A request can never
 * reach an app data file, a source file, or anything outside the build output.
 */
export function servedAssets(assetDirectory: string) {
  const root = resolve(assetDirectory);
  const types: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
  };
  return async (segments: string[]): Promise<{ body: Buffer; contentType: string } | null> => {
    if (segments.length !== 1) return null;
    const name = segments[0]!;
    if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) return null;
    const target = resolve(root, name);
    if (target !== join(root, name)) return null;
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    const contentType = types[extension];
    if (contentType === undefined) return null;
    try {
      return { body: await readFile(target), contentType };
    } catch {
      return null;
    }
  };
}

export async function startService(options: ServiceOptions = {}): Promise<Service> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const store = new PaperStore(dataDirectory);
  store.ensureRoot();
  backfillTitles(store);
  const jobs = new JobManager(store);
  // One official process serves both the translator's reads and the account session. The
  // session alone owns login/logout; the translator never gains account methods. Its state
  // lives in the app-owned `.codex-home` under the data directory, never in ~/.codex.
  const official = createOfficialRpcFactory(() => startOfficialRpc({ dataDirectory }));
  const translator = new CodexTranslator(official);
  const session = new AccountAuthenticator(official);
  const log = options.log ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  // Isolation evidence that outlived its turn still ends the process (CodexTranslator); here it is
  // also recorded, with the path only — never any provider text.
  translator.onLateBreach = (path) => log({ event: 'codex', action: 'late-breach', path, code: 'UNSAFE_RUNTIME' });
  const pipeline = new TranslationPipeline({ store, jobs, translator, log });

  const server = createApiServer({
    store,
    jobs,
    translator,
    session,
    pipeline,
    // The same official process answers the reader's paper questions, on its own tool-less
    // threads; the translation pipeline never receives this path.
    paperChat: translator,
    acquirer: realAcquirer(join(dataDirectory, '.pdf-cache')),
    log,
    clientHtml: options.indexHtml === undefined ? undefined : () => readFileSync(options.indexHtml!, 'utf8'),
    clientAssets: options.indexHtml === undefined ? undefined : servedAssets(join(dirname(resolve(options.indexHtml)), 'assets')),
  });

  const address = await server.listen(options.port ?? 0, LOOPBACK);
  return {
    server,
    store,
    jobs,
    url: `http://${LOOPBACK}:${address.port}`,
    token: server.token,
    dataDirectory,
    async stop() {
      await server.close();
      // Process shutdown only: the app's stored login is kept for the next start.
      await session.disconnect();
      await translator.disconnect();
    },
  };
}

/** True when this module is the process entry point (not an import from a test). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const port = Number(process.env.PAPERREAD_PORT ?? 7327);
  startService({ port: Number.isSafeInteger(port) && port >= 0 ? port : 7327, indexHtml: process.env.PAPERREAD_INDEX })
    .then((service) => {
      process.stdout.write(`${JSON.stringify({ event: 'service.ready', url: service.url, dataDirectory: service.dataDirectory })}\n`);
      const stop = () => {
        void service.stop().finally(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((cause) => {
      process.stderr.write(`${JSON.stringify({ event: 'service.failed', message: (cause as Error).message })}\n`);
      process.exit(1);
    });
}

export default startService;
