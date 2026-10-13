import { describe, expect, it } from 'vitest';
import {
  NoteIndex,
  linkLabel,
  parseLinks,
  resolveLink,
  splitLink,
  validateName,
} from '../packages/core/src/index';

describe('wiki links', () => {
  it('separates target, heading and alias', () => {
    expect(splitLink('Japan#Food|ramen notes')).toEqual({
      target: 'Japan',
      heading: 'Food',
      alias: 'ramen notes',
    });
    expect(splitLink('Japan')).toEqual({ target: 'Japan' });
    expect(linkLabel('Japan|the trip')).toBe('the trip');
    expect(linkLabel('Japan#Food')).toBe('Japan > Food');
  });
  it('ignores links inside fenced and inline code', () => {
    const text = 'See [[One]].\n```md\n[[Two]]\n```\nAnd `[[Three]]` but [[Four|4]].';
    expect(parseLinks(text).map((link) => link.target)).toEqual(['One', 'Four']);
  });
  it('reports where each link sits in the text', () => {
    const [link] = parseLinks('ab [[One]]');
    expect('ab [[One]]'.slice(link!.from, link!.to)).toBe('[[One]]');
  });
  it('prefers an exact path, then the note nearest the vault root', () => {
    const paths = ['Archive/Old/Plan.md', 'Work/Plan.md', 'Japan.md'];
    expect(resolveLink('plan', paths)).toBe('Work/Plan.md');
    expect(resolveLink('Archive/Old/Plan', paths)).toBe('Archive/Old/Plan.md');
    expect(resolveLink('Old/Plan.md', paths)).toBe('Archive/Old/Plan.md');
    expect(resolveLink('Lan', paths)).toBeUndefined();
    expect(resolveLink('', paths)).toBeUndefined();
  });
  it('rejects names that cannot be filenames or link targets', () => {
    for (const name of ['', ' x', 'a/b', 'a|b', 'a#b', '[x]', '.hidden', 'x.', 'a\nb'])
      expect(() => validateName(name), name).toThrow();
    expect(() => validateName('Weekend plans (2026)')).not.toThrow();
  });
});

describe('note index', () => {
  const index = () => {
    const notes = new NoteIndex();
    notes.set('Sunday.md', 'A slow morning. See [[Weekend plans]] and [[weekend plans|again]].');
    notes.set('Travel/Weekend plans.md', 'Walk by the water, then coffee.');
    notes.set('Books.md', 'Nothing about `[[Weekend plans]]` here.');
    return notes;
  };
  it('lists each linking note once, with the line that links', () => {
    expect(index().backlinks('Travel/Weekend plans.md')).toEqual([
      {
        path: 'Sunday.md',
        excerpt: 'A slow morning. See [[Weekend plans]] and [[weekend plans|again]].',
      },
    ]);
  });
  it('drops backlinks when the linking note changes or goes away', () => {
    const notes = index();
    notes.set('Sunday.md', 'No links now.');
    expect(notes.backlinks('Travel/Weekend plans.md')).toEqual([]);
  });
  it('follows a note when it moves', () => {
    const notes = index();
    notes.move('Travel/Weekend plans.md', 'Travel/Saturday.md');
    expect(notes.backlinks('Travel/Saturday.md')).toEqual([]);
    expect(notes.paths()).toContain('Travel/Saturday.md');
    expect(notes.resolve('Weekend plans')).toBeUndefined();
  });
  it('finds every word, in the title or the text, title matches first', () => {
    const notes = index();
    expect(notes.search('weekend').map((result) => result.path)).toEqual([
      'Travel/Weekend plans.md',
      'Books.md',
      'Sunday.md',
    ]);
    expect(notes.search('coffee water')).toEqual([
      { path: 'Travel/Weekend plans.md', excerpt: 'Walk by the water, then coffee.' },
    ]);
    expect(notes.search('coffee tea')).toEqual([]);
    expect(notes.search('   ')).toEqual([]);
  });
});
