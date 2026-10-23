import type { Block, Highlight, Translation } from '../../shared/contracts';
import { carryMathMarkers } from '../translation/format';

/** Preserve text notes through an extraction update only with an unambiguous source match
 * and the identical carried translation (formula markers may follow renumbered formulas,
 * which reads the same). A text that repeats matches only while it repeats as often as
 * before: its blocks pair up in reading order. Unknown/changed matches stay stored as orphans. */
export function remapTranslationAnchors(highlights: Highlight[], previousBlocks: Block[], blocks: Block[], carried: Translation[], kept: Translation[]): Highlight[] {
  const matches = new Map<string, string>();
  const inReadingOrder = (list: Block[]) => list.sort((a, b) => a.order - b.order);
  for (const previous of previousBlocks) {
    const oldMatches = inReadingOrder(previousBlocks.filter((b) => b.sourceHash === previous.sourceHash && b.sourceText === previous.sourceText));
    const nextMatches = inReadingOrder(blocks.filter((b) => b.sourceHash === previous.sourceHash && b.sourceText === previous.sourceText));
    if (oldMatches.length !== nextMatches.length) continue;
    const next = nextMatches[oldMatches.indexOf(previous)];
    if(next.regions[0]?.page !== previous.regions[0]?.page)continue;
    const originalTranslation = carried.find((t) => t.blockId === previous.blockId && t.status === 'completed');
    const nextTranslation = kept.find((t) => t.blockId === next.blockId && t.status === 'completed');
    if (!originalTranslation || !nextTranslation || originalTranslation.text === null) continue;
    if (carryMathMarkers(previous, next, originalTranslation.text, originalTranslation.promptVersion) !== nextTranslation.text) continue;
    matches.set(previous.blockId, next.blockId);
  }
  return highlights.flatMap((highlight) => {
    if (highlight.surface !== 'translation' || highlight.kind === 'ink' || !highlight.anchors?.length) return [];
    if (!highlight.anchors.every((anchor) => matches.has(anchor.blockId))) return [];
    const anchors = highlight.anchors.map((anchor) => ({ ...anchor, blockId:matches.get(anchor.blockId)! }));
    if (anchors.every((anchor, index) => anchor.blockId === highlight.anchors![index].blockId)) return [];
    return [{ ...highlight, anchors }];
  });
}
