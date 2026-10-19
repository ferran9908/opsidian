import { describe, expect, it } from 'vitest';
import {
  NoteIndex,
  filterGraph,
  headingOffset,
  headingSection,
  linkResolver,
  linkTarget,
  localGraph,
  retargetFiles,
  retargetLinks,
  vaultImageMarkdown,
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
  it('builds a graph in one pass: degrees, unresolved nodes, no self-links or duplicate edges', () => {
    const notes = new NoteIndex();
    notes.set('Sunday.md', 'See [[Weekend plans]] and [[weekend plans|again]] and [[Sunday]].');
    notes.set('Travel/Weekend plans.md', 'Walk. Also [[Missing]] and [[missing]].');
    notes.set('Books.md', 'No links.');
    notes.set('Loop.md', 'Points at [[Loop]] only.');
    const graph = notes.graph();
    expect(graph.edges).toEqual([
      { from: 'Sunday.md', to: 'Travel/Weekend plans.md' },
      { from: 'Travel/Weekend plans.md', to: 'Missing.md' },
    ]);
    const byPath = Object.fromEntries(graph.nodes.map((node) => [node.path, node]));
    expect(byPath['Sunday.md']).toEqual({
      path: 'Sunday.md',
      title: 'Sunday',
      exists: true,
      inDegree: 0,
      outDegree: 1,
    });
    expect(byPath['Travel/Weekend plans.md']).toMatchObject({
      exists: true,
      inDegree: 1,
      outDegree: 1,
    });
    expect(byPath['Missing.md']).toEqual({
      path: 'Missing.md',
      title: 'Missing',
      exists: false,
      inDegree: 1,
      outDegree: 0,
    });
    expect(byPath['Books.md']).toMatchObject({ exists: true, inDegree: 0, outDegree: 0 });
    expect(byPath['Loop.md']).toMatchObject({ exists: true, inDegree: 0, outDegree: 0 });
    expect(graph.nodes.some((node) => node.path === 'missing.md')).toBe(false);
  });
  it('walks both directions for a local graph and can hide orphans and missing files', () => {
    const notes = new NoteIndex();
    notes.set('A.md', '[[B]]');
    notes.set('B.md', '[[C]] [[Ghost]]');
    notes.set('C.md', '');
    notes.set('Far.md', '[[C]]');
    notes.set('Alone.md', '');
    const graph = notes.graph();
    expect(localGraph(graph, 'A.md', 1).nodes.map((node) => node.path)).toEqual(['A.md', 'B.md']);
    expect(localGraph(graph, 'A.md', 2).nodes.map((node) => node.path)).toEqual([
      'A.md',
      'B.md',
      'C.md',
      'Ghost.md',
    ]);
    const depthTwo = localGraph(graph, 'A.md', 2);
    expect(
      filterGraph(depthTwo, { orphans: true, existingOnly: true }).nodes.map((n) => n.path),
    ).toEqual(['A.md', 'B.md', 'C.md']);
    expect(
      filterGraph(graph, { orphans: false, existingOnly: true, keep: 'Alone.md' }).nodes.map(
        (node) => node.path,
      ),
    ).toEqual(['A.md', 'Alone.md', 'B.md', 'C.md', 'Far.md']);
    expect(
      filterGraph(graph, { orphans: false, existingOnly: true }).nodes.map((node) => node.path),
    ).toEqual(['A.md', 'B.md', 'C.md', 'Far.md']);
  });
});

describe('link maintenance', () => {
  it('resolves many links the same way as one', () => {
    const paths = ['Work/Japan.md', 'Travel/Asia/Japan.md', 'Japan notes.md', 'Travel/Plans.md'];
    const resolve = linkResolver(paths);
    for (const target of ['Japan', 'japan.md', 'Asia/Japan', 'Travel/Asia/Japan', 'Plans', 'x', ''])
      expect(resolve(target), target).toBe(resolveLink(target, paths));
    expect(resolve('Japan')).toBe('Work/Japan.md');
    expect(resolve('Asia/Japan')).toBe('Travel/Asia/Japan.md');
    expect(linkTarget('Work/Japan.md', resolve)).toBe('Japan');
    expect(linkTarget('Travel/Asia/Japan.md', resolve)).toBe('Travel/Asia/Japan');
  });
  it('retargets links without touching code, headings or aliases', () => {
    const next = (target: string) => (target.toLowerCase() === 'old' ? 'New' : undefined);
    expect(retargetLinks('[[Old]] [[old#H|a]] ![[Old]] `[[Old]]` [[Other]]', next)).toBe(
      '[[New]] [[New#H|a]] ![[New]] `[[Old]]` [[Other]]',
    );
    expect(retargetLinks('nothing', next)).toBe('nothing');
  });
  it('retargets file destinations and leaves web addresses alone', () => {
    const next = (path: string) => (path.startsWith('a/') ? `b/${path.slice(2)}` : undefined);
    expect(
      retargetFiles('![x](a/one%20two.png) [y](a/doc.pdf) [z](https://a/b) `](a/c)`', next),
    ).toBe('![x](b/one%20two.png) [y](b/doc.pdf) [z](https://a/b) `](a/c)`');
  });
  it('tells code from prose the way Markdown does', () => {
    const targets = (text: string) => parseLinks(text).map((link) => link.target);
    expect(targets('``[[A]]`` [[B]] ```[[C]]``` [[D]]')).toEqual(['B', 'D']);
    // Three backticks with more on the same line are a code span, not an opening fence.
    expect(targets('```x``` is inline\n[[E]]')).toEqual(['E']);
    expect(targets('- item\n  ```\n  [[F]]\n  ```\n[[G]]')).toEqual(['G']);
    expect(splitLink('Old\\|alias')).toEqual({ target: 'Old', alias: 'alias' });
    expect(retargetLinks('| [[Old\\|a]] |', () => 'New')).toBe('| [[New\\|a]] |');
  });
  it('follows files written with parentheses, angle brackets and titles', () => {
    const next = (path: string) => (path.startsWith('a/') ? `b/${path.slice(2)}` : undefined);
    expect(retargetFiles('![](a/p%20(1).png) ![](<a/p q.png>) ![](a/r.png "title")', next)).toBe(
      '![](b/p%20%281%29.png) ![](<b/p q.png>) ![](b/r.png "title")',
    );
    expect(vaultImageMarkdown('attachments/IMG (1).jpg')).toBe(
      '\n![](attachments/IMG%20%281%29.jpg)\n',
    );
  });
  it('follows Markdown links to a renamed note and embeds of moved files', () => {
    const index = new NoteIndex();
    index.set('Old.md', '');
    index.set('Index.md', '[t](Old.md) ![[f/img/p.png]] ![[Old]]');
    const edits = index.relink(new Map([['Old.md', 'New.md']]), new Map([['f', 'g']]));
    expect(edits.get('Index.md')).toBe('[t](New.md) ![[g/img/p.png]] ![[New]]');
  });
  it('finds headings and their sections, ignoring code', () => {
    const text =
      '# One\nintro\n```\n## Fake\n```\n## Two ##\nbody\n### Deeper\nmore\n## Three\nend';
    expect(headingOffset(text, 'two')).toBe(text.indexOf('## Two'));
    expect(headingOffset(text, 'Fake')).toBeUndefined();
    expect(headingSection(text, 'Two')).toBe('## Two ##\nbody\n### Deeper\nmore');
    expect(headingSection(text, 'Three')).toBe('## Three\nend');
    expect(headingSection(text, 'Missing')).toBeUndefined();
  });
  it('plans the edits that keep links pointing at the same notes', () => {
    const index = new NoteIndex();
    index.set('A/Note.md', '');
    index.set('B/Note.md', '');
    index.set('Index.md', '[[Note]] [[B/Note]] [[Missing]]');
    // Removing A/Note from the top spot must not let [[Note]] silently jump to B/Note.
    const edits = index.relink(new Map([['A/Note.md', 'Deep/Down/Note.md']]), new Map());
    expect([...edits]).toEqual([['Index.md', '[[Deep/Down/Note]] [[B/Note]] [[Missing]]']]);
  });
});
