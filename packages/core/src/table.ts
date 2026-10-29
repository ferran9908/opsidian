export type ColumnAlign = 'left' | 'center' | 'right' | undefined;

export interface Table {
  align: ColumnAlign[];
  header: string[];
  /** Body rows, each padded or cut to the header's width. */
  rows: string[][];
}

/** Splits a table row at its unescaped bars. A `\|` stays in the cell as a plain bar. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** Where the text of a row's cell begins, so a cursor can be put in it. */
export function cellOffset(line: string, index: number): number {
  const start = line.length - line.trimStart().length;
  let bars = line.startsWith('|', start) ? -1 : 0;
  let at = start;
  for (let i = start; i < line.length && bars < index; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '|' && ++bars === index) at = i + 1;
  }
  if (bars < index) return line.length;
  while (line[at] === ' ' && at < line.length - 1 && line[at + 1] !== '|') at++;
  return at;
}

const DELIMITER = /^:?-+:?$/;

/** Reads a GFM table, or returns undefined when the second line is not a delimiter row. */
export function parseTable(markdown: string): Table | undefined {
  const [head, delimiter, ...body] = markdown.split('\n');
  if (head === undefined || delimiter === undefined) return undefined;
  const marks = splitRow(delimiter);
  if (!marks.every((mark) => DELIMITER.test(mark))) return undefined;
  const header = splitRow(head);
  if (header.length !== marks.length) return undefined;
  const align = marks.map((mark): ColumnAlign => {
    const left = mark.startsWith(':'),
      right = mark.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
  });
  const rows = body
    .filter((line) => line.trim())
    .map((line) => {
      const cells = splitRow(line).slice(0, header.length);
      while (cells.length < header.length) cells.push('');
      return cells;
    });
  return { align, header, rows };
}
