import { describe, expect, it } from 'vitest';
import { cellOffset, parseTable, splitLink, splitRow } from '../packages/core/src/index';

describe('tables', () => {
  it('reads the header, body and alignment', () => {
    expect(parseTable('| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | 2 | 3 | 4 |')).toEqual({
      align: [undefined, 'left', 'center', 'right'],
      header: ['a', 'b', 'c', 'd'],
      rows: [['1', '2', '3', '4']],
    });
  });
  it('reads rows without outer bars', () => {
    expect(parseTable('a | b\n--- | ---\n1 | 2')).toEqual({
      align: [undefined, undefined],
      header: ['a', 'b'],
      rows: [['1', '2']],
    });
  });
  it('pads short rows and cuts long ones to the header', () => {
    expect(parseTable('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')?.rows).toEqual([
      ['1', ''],
      ['1', '2'],
    ]);
  });
  it('keeps escaped bars inside a cell, including a wiki link alias', () => {
    const table = parseTable('| a | b |\n|---|---|\n| `x \\| y` | [[Japan\\|the trip]] |');
    expect(table?.rows[0]).toEqual(['`x | y`', '[[Japan|the trip]]']);
    expect(splitLink('Japan|the trip')).toEqual({ target: 'Japan', alias: 'the trip' });
    expect(splitRow('| a \\|')).toEqual(['a |']);
  });
  it('is not a table without a matching delimiter row', () => {
    expect(parseTable('| a | b |\n| 1 | 2 |')).toBeUndefined();
    expect(parseTable('| a | b |\n|---|')).toBeUndefined();
    expect(parseTable('| a | b |')).toBeUndefined();
  });
  it('finds where each cell’s text begins', () => {
    const line = '| one | two \\| x | |';
    expect(line.slice(cellOffset(line, 0))).toMatch(/^one/);
    expect(line.slice(cellOffset(line, 1))).toMatch(/^two/);
    expect(line[cellOffset(line, 2) - 1]).toBe('|');
    expect(cellOffset('a | b', 0)).toBe(0);
    expect('a | b'.slice(cellOffset('a | b', 1))).toBe('b');
    expect(cellOffset('| a |', 5)).toBe(5);
  });
});
