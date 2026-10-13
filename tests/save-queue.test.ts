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
  it('adopts the stored text when a write reports the store kept something else', async () => {
    const writes: string[] = [];
    const queue = new SaveQueue(
      '',
      async (text) => {
        writes.push(text);
        return text === 'mine' ? 'theirs' : undefined;
      },
      () => {},
      10000,
    );
    queue.update('mine');
    await queue.flush();
    expect(queue.settled).toBe(true);
    // Typing the adopted text again is not a change; typing anything else is.
    queue.update('theirs');
    await queue.flush();
    queue.update('mine');
    await queue.flush();
    expect(writes).toEqual(['mine', 'mine']);
  });
  it('saves during uninterrupted typing instead of waiting for a pause', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const queue = new SaveQueue(
        '',
        async (text) => void writes.push(text),
        () => {},
        160,
        400,
      );
      let text = '';
      for (let key = 0; key < 20; key++) {
        queue.update((text += 'x'));
        await vi.advanceTimersByTimeAsync(50);
      }
      // A second of typing with no gap longer than the debounce still reached the store.
      expect(writes.length).toBeGreaterThanOrEqual(2);
      expect(writes[0]!.length).toBeLessThan(12);
      await vi.advanceTimersByTimeAsync(200);
      expect(writes.at(-1)).toBe(text);
    } finally {
      vi.useRealTimers();
    }
  });
});
