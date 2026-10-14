import { app, dialog, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Keeps an installed copy current from the project's GitHub releases. A new version downloads
 * quietly and installs when the app quits; since a hosting Mac rarely quits, the menus also
 * offer to restart for it. A development run never updates.
 */
export class Updates {
  /** The version downloaded and waiting to be installed, if any. */
  ready: string | undefined;

  constructor(private readonly changed: () => void) {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    // Offline, or the release page unreachable: try again at the next check.
    autoUpdater.on('error', () => {});
    autoUpdater.on('update-downloaded', ({ version }) => {
      this.ready = version;
      this.changed();
      new Notification({
        title: `Opsidian ${version} is ready`,
        body: 'It installs the next time Opsidian quits, or choose Restart to Update.',
      }).show();
    });
    const check = () => void autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, 6 * 60 * 60 * 1000).unref();
  }

  get available(): boolean {
    return app.isPackaged;
  }

  /** Checks now, because someone asked, and says what it found. */
  async checkNow(): Promise<void> {
    if (this.ready) return this.restart();
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo.version;
      if (!latest || latest === app.getVersion())
        void dialog.showMessageBox({
          message: 'Opsidian is up to date',
          detail: `You have version ${app.getVersion()}.`,
        });
      else
        void dialog.showMessageBox({
          message: `Downloading Opsidian ${latest}`,
          detail: 'You can keep working. Opsidian will say when it is ready to install.',
        });
    } catch (reason) {
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Could not check for updates',
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  restart(): void {
    autoUpdater.quitAndInstall();
  }
}
