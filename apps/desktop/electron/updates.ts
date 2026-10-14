import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  NO_UPDATE,
  nextUpdate,
  type AppUpdate,
  type AppUpdateEvent,
  type UpdateCheck,
} from '@opsidian/core';

/**
 * The newest release's update file, at an address that always points to it. GitHub's list of
 * releases, which electron-updater would otherwise read, is cached for minutes and named the
 * previous version just after a release, so the app said it was up to date when it was not.
 */
const FEED = 'https://github.com/ferran9908/opsidian/releases/latest/download';

/**
 * Keeps an installed copy current. It checks shortly after it starts and every four hours,
 * offers a new version, downloads it when asked, and installs it on restart. Every surface reads
 * the one state kept here. A development run never updates.
 */
export class Updates {
  state: AppUpdate = NO_UPDATE;
  private checking: Promise<UpdateCheck> | undefined;

  constructor(private readonly changed: (state: AppUpdate) => void) {
    if (!app.isPackaged) return;
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('update-available', ({ version }) => this.apply({ type: 'available', version }));
    autoUpdater.on('update-not-available', () => this.apply({ type: 'up_to_date' }));
    autoUpdater.on('download-progress', ({ percent }) => this.apply({ type: 'progress', percent }));
    autoUpdater.on('update-downloaded', ({ version }) => {
      this.apply({ type: 'downloaded', version });
      new Notification({
        title: `Opsidian ${version} is ready`,
        body: 'Restart Opsidian to finish updating.',
      }).show();
    });
    autoUpdater.on('error', (error) => this.apply({ type: 'failed', message: readable(error) }));
    // Not at once: starting up is busy enough.
    setTimeout(() => void this.check().catch(() => {}), 15_000).unref();
    setInterval(() => void this.check().catch(() => {}), 4 * 60 * 60 * 1000).unref();
  }

  get available(): boolean {
    return app.isPackaged;
  }

  private apply(event: AppUpdateEvent) {
    const next = nextUpdate(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.changed(next);
  }

  /**
   * Asks for the newest version. While a version is downloading or waiting to install there is
   * nothing to ask, and two checks at once share one answer.
   */
  check(): Promise<UpdateCheck> {
    if (!app.isPackaged) return Promise.resolve('dev');
    if (this.state.kind === 'downloading' || this.state.kind === 'ready')
      return Promise.resolve('busy');
    this.checking ??= autoUpdater
      .checkForUpdates()
      .then((result): UpdateCheck => (result?.isUpdateAvailable ? 'available' : 'up_to_date'))
      .catch((error: unknown) => {
        throw new Error(readable(error));
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  download(): void {
    if (this.state.kind !== 'available' && this.state.kind !== 'error') return;
    this.apply({ type: 'download_started' });
    // A failure also arrives as an 'error' event, which carries the message.
    void autoUpdater.downloadUpdate().catch(() => {});
  }

  restart(): void {
    if (this.state.kind === 'ready') autoUpdater.quitAndInstall();
  }
}

function readable(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|net::ERR_/i.test(text))
    return 'Could not reach the update server. Check the connection and try again.';
  // electron-updater's messages can carry whole HTTP responses; the first line says enough.
  return text.split('\n')[0]!.slice(0, 200) || 'The update did not work.';
}
