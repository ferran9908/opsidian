import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  noteTags,
  readFrontmatter,
  removeProperty,
  setProperty,
  stripFrontmatter,
} from '../packages/core/src/frontmatter';

const NOTE = `---
tags:
  - journal
  - weekend
date: 2026-09-28
place: The harbour, then the long way home
shared: true
rating: 4
aliases: [Sunday walk, "Harbour day"]
# kept as written
---
A walk without a destination.
`;

const props = (doc: string) =>
  Object.fromEntries(readFrontmatter(doc)!.properties.map((p) => [p.key, [p.type, p.value]]));

describe('reading properties', () => {
  it('reads each shape Obsidian writes, with its type', () => {
    expect(props(NOTE)).toEqual({
      tags: ['tags', ['journal', 'weekend']],
      date: ['date', '2026-09-28'],
      place: ['text', 'The harbour, then the long way home'],
      shared: ['checkbox', true],
      rating: ['number', 4],
      aliases: ['list', ['Sunday walk', 'Harbour day']],
    });
    expect(stripFrontmatter(NOTE)).toBe('A walk without a destination.\n');
  });

  it('only counts a block at the very start, closed by --- or ...', () => {
    expect(readFrontmatter('text\n---\na: 1\n---\n')).toBeUndefined();
    expect(readFrontmatter('---\na: 1\nno close')).toBeUndefined();
    expect(props('---\na: 1\n...\nbody')).toEqual({ a: ['number', 1] });
    expect(readFrontmatter('---\n---\nbody')!.properties).toEqual([]);
  });

  it('reads tags written on one line, with or without #, and empty values', () => {
    expect(props('---\ntags: "#a, b c"\nempty:\ntag: [x]\n---\n')).toEqual({
      tags: ['tags', ['a', 'b', 'c']],
      empty: ['text', null],
      tag: ['tags', ['x']],
    });
  });

  it('reads dates with a time, quoted text, and comments after a value', () => {
    expect(props("---\nat: 2026-09-28T09:30\nq: 'it''s: fine'\nn: plain # note\n---\n")).toEqual({
      at: ['datetime', '2026-09-28T09:30'],
      q: ['text', "it's: fine"],
      n: ['text', 'plain'],
    });
  });

  it('keeps what it does not understand as written', () => {
    const doc = '---\nnested:\n  a: 1\nblock: |\n  line\n---\n';
    expect(props(doc)).toEqual({
      nested: ['raw', '  a: 1'],
      block: ['raw', '|\n  line'],
    });
  });
});

describe('changing properties', () => {
  const change = (doc: string, edit: ReturnType<typeof setProperty> | undefined) =>
    applyEdit(doc, edit!);

  it('rewrites only the property changed', () => {
    const next = change(NOTE, setProperty(NOTE, 'tags', 'tags', ['journal', 'weekend', 'travel']));
    expect(next).toBe(NOTE.replace('  - weekend\n', '  - weekend\n  - travel\n'));
    const dated = change(NOTE, setProperty(NOTE, 'date', 'date', '2026-10-01'));
    expect(dated).toBe(NOTE.replace('2026-09-28', '2026-10-01'));
  });

  it('keeps the comment after the last property in place', () => {
    const next = change(NOTE, setProperty(NOTE, 'aliases', 'list', ['One']));
    expect(next).toContain('aliases:\n  - One\n# kept as written\n---\n');
  });

  it('adds a property at the end, and the block when there is none', () => {
    expect(change(NOTE, setProperty(NOTE, 'mood', 'text', 'calm'))).toContain(
      '# kept as written\nmood: calm\n---\n',
    );
    expect(change('Just text\n', setProperty('Just text\n', 'tags', 'tags', ['a']))).toBe(
      '---\ntags:\n  - a\n---\nJust text\n',
    );
  });

  it('quotes text that YAML would otherwise read as something else', () => {
    const doc = '---\nx: 1\n---\n';
    for (const [text, written] of [
      ['true', '"true"'],
      ['42', '"42"'],
      ['2026-01-01', '"2026-01-01"'],
      ['a: b', '"a: b"'],
      ['#hash', '"#hash"'],
      ['plain words', 'plain words'],
    ]) {
      const next = change(doc, setProperty(doc, 'x', 'text', text));
      expect(next).toBe(`---\nx: ${written}\n---\n`);
      expect(props(next).x![1]).toBe(text);
    }
  });

  it('writes empty values and booleans the way Obsidian does', () => {
    const doc = '---\nx: 1\n---\n';
    expect(change(doc, setProperty(doc, 'x', 'list', []))).toBe('---\nx:\n---\n');
    expect(change(doc, setProperty(doc, 'x', 'checkbox', false))).toBe('---\nx: false\n---\n');
  });

  it('removes a property, and the block with the last one', () => {
    const doc = '---\na: 1\nb: 2\n---\nbody\n';
    expect(change(doc, removeProperty(doc, 'a'))).toBe('---\nb: 2\n---\nbody\n');
    const one = '---\na: 1\n---\nbody\n';
    expect(change(one, removeProperty(one, 'a'))).toBe('body\n');
    expect(removeProperty(one, 'missing')).toBeUndefined();
  });
});

describe('tags', () => {
  it('come from the tags property and from #tags in the text, not code or headings', () => {
    const doc = `---\ntags: [journal]\n---\n# Heading\nA #walk and #travel/japan, not #42.\n\`#code\`\n`;
    expect(noteTags(doc).sort()).toEqual(['journal', 'travel/japan', 'walk']);
  });
});
