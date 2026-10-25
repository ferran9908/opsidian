import { useEffect, useState } from 'react';
import type { MissingNotebook, VaultInfo } from '@opsidian/core';
import { bridge, message } from './bridge';
import { useTheme } from './theme';
import { UpdateNotice, UpdatesProvider } from './updates';
import { Welcome } from './Welcome';
import { Workspace } from './Workspace';

export function App() {
  const theme = useTheme();
  // undefined while asking which notebook, if any, was open last time.
  const [vault, setVault] = useState<VaultInfo | null>();
  // Showing the welcome screen over an open notebook, and in which mode.
  const [choosing, setChoosing] = useState<false | 'start' | 'github'>(false);
  const [error, setError] = useState('');
  // The notebook last open, whose folder is no longer where it was.
  const [missing, setMissing] = useState<MissingNotebook | null>(null);
  useEffect(() => {
    void bridge
      .current()
      .then(async (current) => {
        if (!current) setMissing(await bridge.missing());
        setVault(current);
      })
      .catch((reason) => {
        setError(message(reason));
        setVault(null);
      });
  }, []);
  if (vault === undefined) return null;
  return (
    <UpdatesProvider>
      {!vault || choosing ? (
        <Welcome
          error={error}
          missing={vault ? null : missing}
          onMissingDone={(warning) => {
            setMissing(null);
            if (warning) setError(warning);
          }}
          {...(choosing === 'github' ? { mode: 'github' as const } : {})}
          onOpened={(next) => {
            setVault(next);
            setChoosing(false);
          }}
          {...(vault ? { onCancel: () => setChoosing(false) } : {})}
        />
      ) : (
        <Workspace
          key={vault.location}
          vault={vault}
          theme={theme}
          onSwitch={(mode) => setChoosing(mode ?? 'start')}
          onOpened={setVault}
          onClose={(gone, warning) => {
            setMissing(gone);
            setError(warning ?? '');
            setChoosing(false);
            setVault(null);
          }}
        />
      )}
      <UpdateNotice />
    </UpdatesProvider>
  );
}
