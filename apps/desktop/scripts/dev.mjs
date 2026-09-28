import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
process.env.OPSIDIAN_DEV = '1';
await import('./build.mjs');
const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
delete process.env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, OPSIDIAN_RENDERER_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill('SIGINT'));
