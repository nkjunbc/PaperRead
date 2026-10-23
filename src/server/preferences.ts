import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Connection, ModelPreferences } from '../shared/contracts';
import { isExcludedModel } from './codex/models';
import { failure } from './codex/rpc';
import { readRecord, writeRecord } from './store/atomic';

/** App-owned preference only; never reads or modifies official account settings. */
export class PreferencesStore {
  private readonly file: string;
  constructor(private readonly dataDirectory: string) {
    this.file = join(resolve(dataDirectory), 'preferences.json');
  }

  /** The default as it was saved, even one that has since become forbidden or unavailable:
   * withPreferredModel decides against the live catalogue and reports the fallback. */
  read(): ModelPreferences {
    const value = readRecord<unknown>(this.file);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).defaultModelId;
      if (typeof id === 'string') return { defaultModelId: id };
    }
    return { defaultModelId: null };
  }

  setDefaultModel(modelId: string | null, availableModelIds: readonly string[]): ModelPreferences {
    if (modelId !== null && isExcludedModel(modelId)) throw failure('MODEL_UNAVAILABLE', '이 모델은 사용하지 않도록 설정되어 있습니다.');
    if (modelId !== null && !availableModelIds.includes(modelId)) throw failure('MODEL_UNAVAILABLE', '현재 목록에 있는 모델을 선택해 주세요.');
    const value = { defaultModelId: modelId };
    try {
      mkdirSync(this.dataDirectory, { recursive: true });
      writeRecord(this.file, value);
    } catch {
      throw failure('STORAGE', '기본 모델 설정을 저장하지 못했습니다.');
    }
    return value;
  }
}

/** The saved default applies only while it is not forbidden and the live catalogue offers it.
 * Otherwise the official default stays in effect and the fallback is reported, never hidden.
 * Without a subscription there is no catalogue to judge it by, so nothing is reported. */
export function withPreferredModel(connection: Connection, saved: string | null): Connection {
  if (connection.status !== 'subscription') return connection;
  const unavailable = saved !== null && (isExcludedModel(saved) || !connection.modelIds.includes(saved));
  return {
    ...connection,
    defaultModelId: saved !== null && !unavailable ? saved : connection.defaultModelId,
    preferredModelId: saved,
    preferredModelUnavailable: unavailable,
  };
}
