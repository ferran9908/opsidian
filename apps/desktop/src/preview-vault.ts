import {
  NoteIndex,
  initialMarkdown,
  noteFolder,
  validateName,
  type GitHubInfo,
  type GitHubSchedule,
  type MoveResult,
  type VaultBridge,
} from '@opsidian/core';

// A browser-only stand-in for `pnpm dev:preview`. The Electron app never uses it, and it
// keeps notes in localStorage rather than as files.
const KEY = 'opsidian-preview-vault-v2';
const seed: Record<string, string> = {
  'A slower kind of Sunday.md': initialMarkdown.replace(/^# .*\n\n/, ''),
  'A place for little things.md':
    'Small things worth keeping. See [[A slower kind of Sunday]] and [[Travel/Weekend plans]]. Also [[Lanterns]].\n',
  'Travel/Weekend plans.md':
    'See [[A slower kind of Sunday]] for the mood. Maybe [[Travel/Japan]].\n',
  'Travel/Japan.md':
    'From [[Travel/Weekend plans]]. Food in [[Travel/Tokyo]] and [[Travel/Kyoto]].\n',
  'Travel/Tokyo.md': 'Back to [[Travel/Japan]]. A book from [[Books to read]].\n',
  'Travel/Kyoto.md': 'Gardens. Linked from [[Travel/Japan]].\n',
  'Books to read.md': 'Started after [[A slower kind of Sunday]]. Ask [[Travel/Tokyo]].\n',
  'Orphan thought.md': 'Nothing points here, and this points nowhere.\n',
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

const trash = new Map<string, string>();
const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
function relocate(path: string, next: string): MoveResult {
  if (next === path) return { path, rewritten: [], missed: [] };
  if (notes.has(next) || folders.has(next)) throw new Error('That name is already taken there.');
  const shift = (other: string) => next + other.slice(path.length);
  const moved = new Map(
    [...notes.keys()].filter((note) => inside(note, path)).map((note) => [note, shift(note)]),
  );
  const edits = index.relink(moved, new Map(folders.has(path) ? [[path, next]] : []));
  for (const [before, after] of moved) {
    notes.set(after, notes.get(before) ?? '');
    notes.delete(before);
    index.move(before, after);
  }
  for (const folder of [...folders])
    if (inside(folder, path)) {
      folders.delete(folder);
      folders.add(shift(folder));
    }
  for (const [note, content] of edits) put(note, content);
  persist();
  return { path: next, rewritten: [...edits.keys()], missed: [] };
}

export const previewVault: VaultBridge = {
  current: async () => info,
  defaultParent: async () => 'Browser preview',
  chooseParent: async () => null,
  createVault: async () => info,
  openVault: async () => info,
  tree: async () => ({ notes: index.paths(), folders: [...folders].sort(), images: [] }),
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
    return relocate(path, join(noteFolder(path), /\.md$/i.test(path) ? `${name}.md` : name));
  },
  move: async (path, folder) => relocate(path, join(folder, path.slice(path.lastIndexOf('/') + 1))),
  async trash(path) {
    for (const note of [...notes.keys()].filter((note) => inside(note, path))) {
      trash.set(note, notes.get(note) ?? '');
      notes.delete(note);
      index.delete(note);
    }
    for (const folder of [...folders]) if (inside(folder, path)) folders.delete(folder);
    persist();
  },
  trashed: async () =>
    [...trash.keys()].map((name) => ({ name, from: name, folder: false, at: Date.now() })),
  async restore(name) {
    put(name, trash.get(name) ?? '');
    trash.delete(name);
    return name;
  },
  async emptyTrash() {
    trash.clear();
    return true;
  },
  saveImage: async () => {
    throw new Error('Images need the desktop app.');
  },
  backlinks: async (path) => index.backlinks(path),
  search: async (query) => index.search(query),
  graph: async () => index.graph(),
  importImage: async () => null,
  imageUrl: () => undefined,
  reveal: async () => {},
  onChange: () => () => {},
  syncInfo: async () => ({ connected: false }),
  connect: async () => {
    throw new Error('Sync needs the desktop app.');
  },
  disconnect: async () => {},
  confirmDeletions: async () => {},
  joinVault: async () => {
    throw new Error('Sync needs the desktop app.');
  },
  history: async () => [],
  versionText: async () => '',
  onSync: () => () => {},
  checkConnection: async () => [],
  openTailscale: async () => {},
  hosting: async () => notHosting,
  startHosting: async () => notHosting,
  stopHosting: async () => notHosting,
  setKeepRunning: async () => notHosting,
  invite: async () => {
    throw new Error('Hosting needs the Mac app.');
  },
  cancelInvitation: async () => notHosting,
  removeDevice: async () => notHosting,
  backups: async () => ({ keep: 14, backups: [] }),
  chooseBackupFolder: async () => null,
  setBackupSchedule: async () => ({ keep: 14, backups: [] }),
  backUpNow: async () => ({ keep: 14, backups: [] }),
  restoreBackup: async () => ({ keep: 14, backups: [] }),
  onHosting: () => () => {},
  moveHosting: async () => {
    throw new Error('Hosting needs the Mac app.');
  },
  takeOverHosting: async () => {
    throw new Error('Hosting needs the Mac app.');
  },
  onTakeOver: () => () => {},
  followHost: async () => {
    throw new Error('Sync needs the desktop app.');
  },
  github: async () => noGitHub(),
  signInToGitHub: async () => {
    throw new Error('GitHub needs the Mac app.');
  },
  finishGitHubSignIn: async () => noGitHub(),
  cancelGitHubSignIn: async () => {},
  signOutOfGitHub: async () => noGitHub(),
  githubRepositories: async () => [],
  keepOnGitHub: async () => {
    throw new Error('GitHub needs the Mac app.');
  },
  importFromGitHub: async () => {
    throw new Error('GitHub needs the Mac app.');
  },
  syncGitHub: async () => noGitHub(),
  setGitHubSchedule: async (every) => {
    githubEvery = every;
    return noGitHub();
  },
  stopGitHub: async () => noGitHub(),
  // The browser preview is never installed, so it never updates.
  updateState: async () => ({ kind: 'none' }),
  checkForUpdate: async () => 'dev',
  downloadUpdate: async () => {},
  restartToUpdate: async () => {},
  appVersion: async () => 'preview',
  openHelp: async () => {
    window.open('https://github.com/ferran9908/opsidian#readme', '_blank');
  },
  clipboard: async (action) => {
    document.execCommand(action);
  },
  onUpdate: () => () => {},
  onUpdateCheckRequested: () => () => {},
};

let githubEvery: GitHubSchedule = '1h';
const noGitHub = (): GitHubInfo => ({ mirrors: [], every: githubEvery });

const notHosting = {
  hosting: false,
  port: 4810,
  addresses: [],
  notebooks: [],
  devices: [],
  invitations: [],
  keepRunning: true,
};
