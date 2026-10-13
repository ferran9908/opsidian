import {
  NoteIndex,
  initialMarkdown,
  noteFolder,
  validateName,
  type VaultBridge,
} from '@opsidian/core';

// A browser-only stand-in for `pnpm dev:preview`. The Electron app never uses it, and it
// keeps notes in localStorage rather than as files.
const KEY = 'opsidian-preview-vault';
const seed: Record<string, string> = {
  'A slower kind of Sunday.md': initialMarkdown.replace(/^# .*\n\n/, ''),
  'A place for little things.md': 'Small things worth keeping.\n',
  'Travel/Weekend plans.md': 'See [[A slower kind of Sunday]] for the mood.\n',
};
const stored = localStorage.getItem(KEY);
const notes = new Map<string, string>(Object.entries(stored ? JSON.parse(stored) : seed));
const folders = new Set<string>(['Travel']);
const index = new NoteIndex();
for (const [path, content] of notes) index.set(path, content);
const persist = () => localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(notes)));
const info = { name: 'Preview', location: 'Browser preview · localStorage' };
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
function put(path: string, content: string) {
  notes.set(path, content);
  index.set(path, content);
  persist();
}

export const previewVault: VaultBridge = {
  current: async () => info,
  defaultParent: async () => 'Browser preview',
  chooseParent: async () => null,
  createVault: async () => info,
  openVault: async () => info,
  tree: async () => ({ notes: index.paths(), folders: [...folders].sort() }),
  async read(path) {
    const content = notes.get(path);
    if (content === undefined) throw new Error(`“${path}” is no longer in this notebook.`);
    return { content, revision: content };
  },
  async save(path, content) {
    put(path, content);
    return { revision: content };
  },
  async createNote(folder, name = 'Untitled') {
    validateName(name);
    let path = join(folder, `${name}.md`);
    for (let count = 1; notes.has(path); count++) path = join(folder, `${name} ${count}.md`);
    put(path, '');
    return path;
  },
  async createFolder(parent, name) {
    validateName(name);
    folders.add(join(parent, name));
    return join(parent, name);
  },
  async rename(path, name) {
    validateName(name);
    const next = join(noteFolder(path), `${name}.md`);
    if (next === path) return path;
    if (notes.has(next)) throw new Error(`“${name}” already exists in this folder.`);
    const content = notes.get(path) ?? '';
    notes.delete(path);
    index.delete(path);
    put(next, content);
    return next;
  },
  async trash(path) {
    notes.delete(path);
    index.delete(path);
    persist();
  },
  backlinks: async (path) => index.backlinks(path),
  search: async (query) => index.search(query),
  importImage: async () => null,
  imageUrl: () => undefined,
  reveal: async () => {},
  onChange: () => () => {},
};
