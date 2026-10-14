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
  const [choosing, setChoosing] = useState(false);
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
          onSwitch={() => setChoosing(true)}
        />
      )}
      <UpdateNotice />
    </UpdatesProvider>
  );
}
