import { previewVault } from './preview-vault';

/** The vault behind the interface: Electron's native bridge, or the browser preview. */
export const bridge = window.opsidian ?? previewVault;
export const message = (reason: unknown) =>
  (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
