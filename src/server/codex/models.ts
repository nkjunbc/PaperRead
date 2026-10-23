/** Models the user has explicitly forbidden for this product. Never offered,
 * never defaulted to, and refused at the generation call even if one is passed
 * in directly — a catalogue filter alone could be bypassed. Every other model the
 * official catalogue offers stays available. */
export const EXCLUDED_MODEL_MARKERS = ['astra', 'fable'] as const;
export function isExcludedModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return EXCLUDED_MODEL_MARKERS.some(marker => id.includes(marker));
}
