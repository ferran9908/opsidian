import type { NotebookBridge } from '@opsidian/core';
declare global {
  interface Window {
    opsidian?: NotebookBridge & {
      onCloseRequest(callback: () => void): () => void;
      closeFailed(message: string): Promise<void>;
      closeReady(): Promise<void>;
    };
  }
}
