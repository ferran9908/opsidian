import { diff3Merge } from 'node-diff3';

const lines = (text: string) => text.split(/(?<=\n)/);

/**
 * Combines two edits of the same text. Returns undefined when both changed the same lines
 * differently, which only a person can settle.
 */
export function mergeText(base: string, mine: string, theirs: string): string | undefined {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  let merged = '';
  for (const region of diff3Merge(lines(mine), lines(base), lines(theirs))) {
    if (region.ok) merged += region.ok.join('');
    else return undefined;
  }
  return merged;
}
