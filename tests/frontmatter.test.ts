import { describe, expect, it } from 'vitest';
import {
  NoteIndex,
  frontmatterTags,
  inlineTags,
  parseFrontmatter,
  parseTags,
  prose,
} from '../packages/core/src/index';

describe('frontmatter', () => {
  it('reads plain values, inline lists and dash lists, and says where the text starts', () => {
    const note = `---\ntitle: "Japan trip"\ntags: [travel, 'food']\naliases:\n  - JP\n  - Nihon\ndate: 2026-10-29\n---\n# Japan\n`;
    const block = parseFrontmatter(note);
    expect(block?.properties).toEqual([
      { key: 'title', value: 'Japan trip' },
      { key: 'tags', value: ['travel', 'food'] },
      { key: 'aliases', value: ['JP', 'Nihon'] },
      { key: 'date', value: '2026-10-29' },
    ]);
    expect(note.slice(block!.end)).toBe('# Japan\n');
  });
  it('needs the block to open on the first line and to close', () => {
    expect(parseFrontmatter('\n---\na: b\n---\n')).toBeUndefined();
    expect(parseFrontmatter('---\na: b\n')).toBeUndefined();
    expect(parseFrontmatter('--- not frontmatter\n---\n')).toBeUndefined();
    expect(parseFrontmatter('---\n---\nText')).toEqual({ end: 8, properties: [] });
  });
  it('keeps lines it does not understand without losing the ones around them', () => {
    const block = parseFrontmatter('---\n# a comment\nnested:\n  deep: value\nok: yes\n---\n');
    expect(block?.properties).toEqual([
      { key: 'nested', value: [] },
      { key: 'ok', value: 'yes' },
    ]);
  });
  it('takes tags from `tags` or `tag`, as a list or a line, with or without #', () => {
    expect(frontmatterTags(parseFrontmatter('---\ntags: [a, "#b"]\ntag: c d\n---\n'))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(frontmatterTags(parseFrontmatter('---\ntags:\n  - one/two\n  - 123\n---\n'))).toEqual([
      'one/two',
    ]);
    expect(frontmatterTags(undefined)).toEqual([]);
  });
});

describe('tags', () => {
  it('finds #tags in prose but not numbers, headings, code or the middle of words', () => {
    const text =
      '# Heading\nWork on #project-x and #work/client, not #123 or a#b.\n`#code` and\n```\n#fenced\n```\n(#parens) #ünïcode';
    expect(inlineTags(prose(text)).map((tag) => tag.tag)).toEqual([
      'project-x',
      'work/client',
      'parens',
      'ünïcode',
    ]);
    const [first] = inlineTags(prose(text));
    expect(text.slice(first!.from, first!.to)).toBe('#project-x');
  });
  it('joins frontmatter and inline tags, each once, first spelling kept', () => {
    expect(parseTags('---\ntags: [Travel]\n---\nSee #travel and #Food and #food.')).toEqual([
      'Travel',
      'Food',
    ]);
  });
  it('indexes tags by note and across the notebook, and searches by them', () => {
    const notes = new NoteIndex();
    notes.set('Japan.md', '---\ntags: [travel, food]\n---\nRamen.');
    notes.set('Italy.md', 'Pasta #travel #food/pasta');
    notes.set('Desk.md', 'Nothing tagged, mentions travel.');
    expect(notes.tagsOf('Italy.md')).toEqual(['travel', 'food/pasta']);
    expect(notes.tags()).toEqual([
      { tag: 'travel', notes: 2 },
      { tag: 'food', notes: 1 },
      { tag: 'food/pasta', notes: 1 },
    ]);
    expect(notes.search('#travel').map((r) => r.path)).toEqual(['Italy.md', 'Japan.md']);
    expect(notes.search('#food ramen').map((r) => r.path)).toEqual(['Japan.md']);
    expect(notes.search('#food/pasta').map((r) => r.path)).toEqual(['Italy.md']);
    expect(notes.search('#nothing')).toEqual([]);
    // A bare # is an ordinary word, as before.
    expect(notes.search('#').map((r) => r.path)).toEqual(['Italy.md']);
    expect(notes.search('travel').map((r) => r.path)).toEqual(['Desk.md', 'Italy.md', 'Japan.md']);
  });
  it('adds tag nodes to the graph only when asked', () => {
    const notes = new NoteIndex();
    notes.set('Japan.md', '#travel [[Italy]]');
    notes.set('Italy.md', '#Travel #food');
    expect(notes.graph().nodes.map((node) => node.path)).toEqual(['Italy.md', 'Japan.md']);
    const graph = notes.graph({ tags: true });
    expect(graph.nodes.map((node) => node.path)).toEqual([
      '#food',
      '#travel',
      'Italy.md',
      'Japan.md',
    ]);
    expect(graph.nodes.find((node) => node.path === '#travel')).toEqual({
      path: '#travel',
      title: '#travel',
      exists: true,
      inDegree: 2,
      outDegree: 0,
      tag: true,
    });
    expect(graph.edges).toEqual([
      { from: 'Italy.md', to: '#food' },
      { from: 'Italy.md', to: '#travel' },
      { from: 'Japan.md', to: '#travel' },
      { from: 'Japan.md', to: 'Italy.md' },
    ]);
  });
});
