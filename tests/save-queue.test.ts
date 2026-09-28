import { describe, expect, it, vi } from 'vitest';
import { SaveQueue, type SaveStatus } from '../packages/core/src/save-queue';

describe('durable acknowledgment queue', () => {
  it('does not report saved before acknowledgment, and drains newer edits in order', async () => {
    let release!: () => void;
    const statuses: SaveStatus[] = [];
    const writes: string[] = [];
    const queue = new SaveQueue(
      '',
      async (text) => {
        writes.push(text);
        if (text === 'first')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
      (s) => statuses.push(s),
      10000,
    );
    queue.update('first');
    const flushing = queue.flush();
    queue.update('second');
    queue.update('latest');
    expect(statuses.at(-1)?.state).toBe('saving');
    release();
    await flushing;
    expect(writes).toEqual(['first', 'latest']);
    expect(statuses.at(-1)?.state).toBe('saved');
    await queue.flush(); // cancels the timer scheduled by the later edit
  });
  it('retains failed content for an explicit retry', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockResolvedValue(undefined);
    const states: SaveStatus[] = [];
    const queue = new SaveQueue('old', write, (s) => states.push(s));
    queue.update('new');
    await expect(queue.flush()).rejects.toThrow('Disk full');
    expect(states.at(-1)).toEqual({ state: 'error', message: 'Disk full' });
    await queue.flush();
    expect(write).toHaveBeenLastCalledWith('new');
    expect(states.at(-1)?.state).toBe('saved');
  });
  it('persists an undo made during an in-flight save', async () => {
    let release!: () => void;
    const values: string[] = [];
    const queue = new SaveQueue(
      'original',
      async (value) => {
        values.push(value);
        if (values.length === 1)
          await new Promise<void>((r) => {
            release = r;
          });
      },
      () => {},
      10000,
    );
    queue.update('changed');
    const done = queue.flush();
    queue.update('original');
    release();
    await done;
    expect(values).toEqual(['changed', 'original']);
    await queue.flush();
  });
});
