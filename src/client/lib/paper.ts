import type { Paper } from '../../shared/contracts';

/** Reader-owned label; the academic title remains the source of model context. */
export function paperTitle(paper: Pick<Paper, 'displayTitle' | 'title' | 'paperKey'>): string {
  return paper.displayTitle?.trim() || paper.title?.trim() || paper.paperKey;
}
