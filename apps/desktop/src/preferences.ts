import type { EditorMode } from '@opsidian/editor';

const MODE = 'opsidian.editor.mode';

/** How notes open, from Settings → Editor. */
export function defaultMode(): EditorMode {
  const saved = localStorage.getItem(MODE);
  return saved === 'source' || saved === 'reading' ? saved : 'live';
}
export function setDefaultMode(mode: EditorMode): void {
  localStorage.setItem(MODE, mode);
}
