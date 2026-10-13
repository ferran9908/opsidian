import type { VaultBridge } from '@opsidian/core';
declare global {
  interface Window {
    opsidian?: VaultBridge & {
      onCloseRequest(callback: () => void): () => void;
      closeFailed(message: string): Promise<void>;
      closeReady(): Promise<void>;
    };
  }
}
