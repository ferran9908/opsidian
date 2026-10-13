export type SaveStatus =
  { state: 'saved' } | { state: 'saving' } | { state: 'error'; message: string };

/** One write in flight; new edits replace only the not-yet-started snapshot. */
export class SaveQueue {
  private current: string;
  private persisted: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  /** When the oldest edit not yet handed to `write` was made. */
  private waitingSince: number | undefined;

  constructor(
    initial: string,
    /** Resolving with a string means the store holds that text instead, so the queue adopts it. */
    private readonly write: (content: string) => Promise<void | string>,
    private readonly report: (status: SaveStatus) => void,
    private readonly delay = 160,
    /** Longest an edit waits while typing continues, so a crash loses at most this much. */
    private readonly longest = 1000,
  ) {
    this.current = this.persisted = initial;
  }

  update(content: string): void {
    this.current = content;
    if (content === this.persisted && !this.running) return;
    this.report({ state: 'saving' });
    clearTimeout(this.timer);
    this.waitingSince ??= Date.now();
    const wait = Math.min(this.delay, this.waitingSince + this.longest - Date.now());
    this.timer = setTimeout(() => void this.flush().catch(() => {}), Math.max(wait, 0));
  }

  /** Nothing waiting to be written and nothing being written. */
  get settled(): boolean {
    return this.current === this.persisted && !this.running;
  }

  /** Takes text loaded from the store as the new saved state, dropping nothing pending. */
  adopt(content: string): void {
    if (this.settled) this.current = this.persisted = content;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.current !== this.persisted) {
        const snapshot = this.current;
        this.waitingSince = undefined;
        this.report({ state: 'saving' });
        const adopted = await this.write(snapshot);
        if (typeof adopted === 'string') this.current = this.persisted = adopted;
        else this.persisted = snapshot;
      }
      this.report({ state: 'saved' });
    } catch (error) {
      this.report({
        state: 'error',
        message: error instanceof Error ? error.message : 'Save failed',
      });
      throw error;
    }
  }
}
