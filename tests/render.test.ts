import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderPage, renderedFiles } from '../packages/core/src/index';

describe('rendering a note as HTML', () => {
  it('draws headings, emphasis, lists, quotes, code and rules', () => {
    const html = renderMarkdown(
      '# Title\n\nSome *em* and **strong** and ~~gone~~ and `code`.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted\n\n```js\nlet a = 1 < 2;\n```\n\n---\n',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain(
      '<ul>\n<li>one</li>\n<li>two\n<ul>\n<li>nested</li>\n</ul>\n</li>\n</ul>',
    );
    expect(html).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
    expect(html).toContain('<blockquote>\n<p>quoted</p>\n</blockquote>');
    expect(html).toContain('<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>');
    expect(html).toContain('<hr>');
  });
  it('never lets HTML written in the note onto the page', () => {
    const html = renderMarkdown(
      'Hi <script>alert(1)</script> there\n\n<div onclick="x">block</div>\n',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;div onclick=&quot;x&quot;&gt;block&lt;/div&gt;');
  });
  it('leaves out comments, which Reading view hides', () => {
    const html = renderMarkdown(
      'Shown <!-- hidden --> here.\n\n%%\nsecret\n%%\n\nAnd %%inline%% done.\n',
    );
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('inline');
    expect(html).toContain('Shown  here.');
    expect(html).toContain('And  done.');
  });
  it('links to the web, not to anything else', () => {
    const html = renderMarkdown(
      '[site](https://example.com "A title") and [bad](javascript:alert(1)) and https://bare.example and <me@example.com>\n',
    );
    expect(html).toContain(
      '<a href="https://example.com" rel="noopener noreferrer" title="A title">site</a>',
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('>bad</a>' === '' ? '' : 'bad');
    expect(html).toContain(
      '<a href="https://bare.example" rel="noopener noreferrer">https://bare.example</a>',
    );
    expect(html).toContain(
      '<a href="mailto:me@example.com" rel="noopener noreferrer">me@example.com</a>',
    );
  });
  it('shows wiki links as text unless the other note is reachable', () => {
    const paths = ['Japan.md', 'Travel/Food.md'];
    const plain = renderMarkdown('See [[Japan]] and [[Food|the food]] and [[Nowhere]].', { paths });
    expect(plain).toContain('<span class="wiki">Japan</span>');
    expect(plain).toContain('<span class="wiki">the food</span>');
    expect(plain).toContain('<span class="wiki">Nowhere</span>');
    expect(plain).not.toContain('[[');
    const linked = renderMarkdown('See [[Japan]].', {
      paths,
      note: (path) => (path === 'Japan.md' ? '/s/abc' : undefined),
    });
    expect(linked).toContain('<a class="wiki" href="/s/abc">Japan</a>');
  });
  it('embeds images by name or path, and names files it cannot show', () => {
    const paths = ['attachments/photo.png', 'Notes/pic.jpg', 'files/paper.pdf'];
    const files: string[] = [];
    const html = renderMarkdown(
      '![[photo.png]]\n\n![alt text](Notes/pic.jpg)\n\n![[paper.pdf]]\n\n![[missing.png]]\n\n![](https://example.com/x.png)\n',
      {
        paths,
        file: (path) => (files.push(path), path === 'files/paper.pdf' ? undefined : `/f/${path}`),
      },
    );
    expect(html).toContain('<img src="/f/attachments/photo.png" alt="photo.png">');
    expect(html).toContain('<img src="/f/Notes/pic.jpg" alt="alt text">');
    expect(html).toContain('<span class="missing">paper.pdf</span>');
    expect(html).toContain('<span class="missing">missing.png</span>');
    expect(html).toContain('<img src="https://example.com/x.png" alt="">');
    expect(renderedFiles('![[photo.png]] and ![x](Notes/pic.jpg) and [[Japan]]', paths)).toEqual([
      'attachments/photo.png',
      'Notes/pic.jpg',
    ]);
  });
  it('draws properties, tags, tables and task lists', () => {
    const html = renderMarkdown(
      '---\ntitle: Trip\ntags: [travel, food]\n---\nA #tag here but not in `#code`.\n\n| Name | Count |\n| :--- | ----: |\n| a | 1 |\n\n- [x] done\n- [ ] not yet\n',
    );
    expect(html).toContain('<dt>title</dt><dd><span>Trip</span></dd>');
    expect(html).toContain(
      '<dt>tags</dt><dd><span class="tag">#travel</span> <span class="tag">#food</span></dd>',
    );
    expect(html).toContain('A <span class="tag">#tag</span> here but not in <code>#code</code>.');
    expect(html).toContain('<th align="left">Name</th><th align="right">Count</th>');
    expect(html).toContain('<td align="left">a</td><td align="right">1</td>');
    expect(html).toContain('<input type="checkbox" disabled checked> done');
    expect(html).toContain('<input type="checkbox" disabled> not yet');
  });
  it('keeps a shortcut reference as written and escapes what needs escaping', () => {
    expect(renderMarkdown('See [this] & that \\*not em\\*.')).toBe(
      '<p>See [this] &amp; that *not em*.</p>\n',
    );
  });
  it('wraps a page with no scripts and no outside resources', () => {
    const page = renderPage({ title: 'A <note>', body: '<p>hi</p>\n', footer: 'Until Friday' });
    expect(page).toContain('<title>A &lt;note&gt;</title>');
    expect(page).toContain('<h1 class="title">A &lt;note&gt;</h1>');
    expect(page).toContain('<footer>Until Friday</footer>');
    expect(page).not.toContain('<script');
    expect(page).not.toMatch(/src="http|href="http/);
  });
});
