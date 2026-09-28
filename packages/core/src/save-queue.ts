export type SaveStatus =
  { state: 'saved' } | { state: 'saving' } | { state: 'error'; message: string };

/** One write in flight; new edits replace only the not-yet-started snapshot. */
export class SaveQueue {
  private current: string;
  private persisted: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    initial: string,
    private readonly write: (content: string) => Promise<void>,
    private readonly report: (status: SaveStatus) => void,
    private readonly delay = 160,
  ) {
    this.current = this.persisted = initial;
  }

  update(content: string): void {
    this.current = content;
    if (content === this.persisted && !this.running) return;
    this.report({ state: 'saving' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush().catch(() => {}), this.delay);
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
        this.report({ state: 'saving' });
        await this.write(snapshot);
        this.persisted = snapshot;
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
