import type { Block, Translation } from './contracts';

/** A completed translation of the block's current text that has words in it. */
export function isTranslated(block: Pick<Block, 'sourceHash'>, translation: Translation | undefined): boolean {
  return translation !== undefined && translation.status === 'completed' && translation.sourceHash === block.sourceHash && (translation.text ?? '').trim().length > 0;
}

/**
 * The record that speaks for each block, by block id. A completed translation of the block's
 * current text wins over any later failed or pending attempt, the newest of them when there are
 * several, whichever prompt made it; without one, the latest attempt speaks. With a model id
 * only that model's records count. The server's progress, the reader's progress, the Korean
 * page with its notes, and what a re-extraction carries over all choose with this one rule.
 */
export function selectTranslations(blocks: readonly Pick<Block, 'blockId' | 'sourceHash'>[], translations: readonly Translation[], modelId: string | null): Map<string, Translation> {
  const byId = new Map(blocks.map((block) => [block.blockId, block] as const));
  const selected = new Map<string, Translation>();
  for (const translation of translations) {
    const block = byId.get(translation.blockId);
    if (block === undefined || (modelId !== null && translation.modelId !== modelId)) continue;
    const current = selected.get(translation.blockId);
    if (current === undefined || isTranslated(block, translation) || !isTranslated(block, current)) selected.set(translation.blockId, translation);
  }
  return selected;
}
