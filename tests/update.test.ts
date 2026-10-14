import { describe, expect, it } from 'vitest';
import {
  NO_UPDATE,
  nextUpdate,
  type AppUpdate,
  type AppUpdateEvent,
} from '../packages/core/src/update';

const run = (events: AppUpdateEvent[], from: AppUpdate = NO_UPDATE) =>
  events.reduce(nextUpdate, from);

describe('the app update', () => {
  it('goes from offered to downloading to ready', () => {
    expect(
      run([
        { type: 'available', version: '0.1.4' },
        { type: 'download_started' },
        { type: 'progress', percent: 42.4 },
      ]),
    ).toEqual({ kind: 'downloading', version: '0.1.4', percent: 42.4 });
    expect(
      run([
        { type: 'available', version: '0.1.4' },
        { type: 'download_started' },
        { type: 'downloaded', version: '0.1.4' },
      ]),
    ).toEqual({
      kind: 'ready',
      version: '0.1.4',
    });
  });

  it('is never interrupted by a later check', () => {
    const downloading: AppUpdate = { kind: 'downloading', version: '0.1.4', percent: 10 };
    const ready: AppUpdate = { kind: 'ready', version: '0.1.4' };
    for (const event of [
      { type: 'available', version: '0.1.5' },
      { type: 'up_to_date' },
    ] as AppUpdateEvent[]) {
      expect(nextUpdate(downloading, event)).toBe(downloading);
      expect(nextUpdate(ready, event)).toBe(ready);
    }
  });

  it('only says up to date when nothing is on offer', () => {
    expect(run([{ type: 'available', version: '0.1.4' }, { type: 'up_to_date' }])).toEqual(
      NO_UPDATE,
    );
    expect(nextUpdate(NO_UPDATE, { type: 'up_to_date' })).toEqual(NO_UPDATE);
  });

  it('keeps a failed background check quiet, and a ready version through any failure', () => {
    expect(nextUpdate(NO_UPDATE, { type: 'failed', message: 'offline' })).toEqual(NO_UPDATE);
    const ready: AppUpdate = { kind: 'ready', version: '0.1.4' };
    expect(nextUpdate(ready, { type: 'failed', message: 'offline' })).toBe(ready);
  });

  it('turns a failed download into an error that can be tried again', () => {
    const failed = run([
      { type: 'available', version: '0.1.4' },
      { type: 'download_started' },
      { type: 'failed', message: 'The connection was lost.' },
    ]);
    expect(failed).toEqual({
      kind: 'error',
      version: '0.1.4',
      message: 'The connection was lost.',
    });
    expect(nextUpdate(failed, { type: 'download_started' })).toEqual({
      kind: 'downloading',
      version: '0.1.4',
      percent: 0,
    });
  });

  it('ignores progress that is not a number, and keeps it within 0 to 100', () => {
    const downloading: AppUpdate = { kind: 'downloading', version: '0.1.4', percent: 5 };
    expect(nextUpdate(downloading, { type: 'progress', percent: Number.NaN })).toMatchObject({
      percent: 0,
    });
    expect(nextUpdate(downloading, { type: 'progress', percent: 140 })).toMatchObject({
      percent: 100,
    });
    expect(nextUpdate(NO_UPDATE, { type: 'progress', percent: 50 })).toEqual(NO_UPDATE);
  });
});
