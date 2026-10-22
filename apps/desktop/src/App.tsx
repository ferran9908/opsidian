import { useEffect, useState } from 'react';
import type { VaultInfo } from '@opsidian/core';
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
  useEffect(() => {
    void bridge
      .current()
      .then(setVault)
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
        />
      )}
      <UpdateNotice />
    </UpdatesProvider>
  );
}
