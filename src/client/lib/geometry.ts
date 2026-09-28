import type { Block, Region } from '../../shared/contracts';

/** A page's intrinsic (unzoomed) size in CSS pixels, as pdf.js reports it at scale 1. */
export interface Size {
  width: number;
  height: number;
}

/** A rectangle in rendered-page pixel space, measured from the page's top-left corner. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The rendered size of a page at the current zoom.
 *
 * Every pixel coordinate in this module derives from this one function, so the
 * zoom and the pane width can change freely without the overlay drifting: the
 * ratio coordinates are re-multiplied by whatever the page currently measures.
 */
export function pageRenderSize(intrinsic: Size, zoom: number): Size {
  const factor = clamp(finite(zoom, 1), 0.1, 8);
  return { width: intrinsic.width * factor, height: intrinsic.height * factor };
}

/**
 * Ratio coordinates ([0,1] from the page's top-left, pre-rotation) times the
 * current render size. Clamped to the page box so a slightly out-of-range
 * extraction cannot paint an overlay outside the canvas.
 */
export function regionToPixels(region: Region, size: Size): PixelRect {
  const left = clamp(finite(region.x, 0), 0, 1) * size.width;
  const top = clamp(finite(region.y, 0), 0, 1) * size.height;
  const width = clamp(finite(region.width, 0), 0, 1) * size.width;
  const height = clamp(finite(region.height, 0), 0, 1) * size.height;
  return {
    left,
    top,
    // Keep a hairline of width so a degenerate region is still visible.
    width: Math.max(1, Math.min(width, size.width - left)),
    height: Math.max(1, Math.min(height, size.height - top)),
  };
}

/** A block's home page for page-only navigation; no coordinates are inferred. */
export function blockPage(block: Block): number | null {
  return block.regions[0]?.page ?? null;
}

/** Click targets exist only for readable prose, not source crops such as figures or tables. */
export function sourceClickRegions(blocks: readonly Block[], page: number): { block: Block; region: Region }[] {
  return blocks.flatMap((block) => {
    if (block.kind !== 'heading' && block.kind !== 'paragraph' && block.kind !== 'caption') return [];
    return block.regions.filter((region) => region.page === page).map((region) => ({ block, region }));
  });
}

/**
 * The topmost block whose click region contains a page-ratio point, or null.
 * Used to keep "click jumps to the paired page" working even when the click
 * targets have pointer-events disabled in favour of text selection.
 */
export function hitTestBlock(blocks: readonly Block[], page: number, xRatio: number, yRatio: number): Block | null {
  const regions = sourceClickRegions(blocks, page);
  for (const { block, region } of regions) {
    if (xRatio >= region.x && xRatio <= region.x + region.width && yRatio >= region.y && yRatio <= region.y + region.height) {
      return block;
    }
  }
  return null;
}

/**
 * The pages to keep mounted. A long paper must never render every page at
 * once (spec R06), so only a small window around the current page is live.
 */
export function visiblePageWindow(currentPage: number, pageCount: number, radius = 1): number[] {
  if (pageCount <= 0) return [];
  const centre = clamp(Math.round(finite(currentPage, 1)), 1, pageCount);
  const pages: number[] = [];
  for (let page = Math.max(1, centre - radius); page <= Math.min(pageCount, centre + radius); page += 1) pages.push(page);
  return pages;
}
