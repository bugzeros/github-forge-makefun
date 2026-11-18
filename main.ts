// Entry point for the Git Forge: one Node process that serves the forge
// from app.ts and, when the make.fun suite is running beside it, hands the
// suite the port it picked and waits until the suite says it is done.
//
// There are two ways this file runs:
//
//   - In a trial pod, MAKEFUN_ENV_URL names the suite. The forge binds an
//     ephemeral port (port 0, so the kernel picks one), tells the suite
//     that port with a POST to /register, then polls GET /done until the
//     suite answers {"done": true} and exits 0. It never binds 8080,
//     where the suite itself listens.
//   - Anywhere else, it just listens on a fixed port — a number on the
//     command line, the PORT variable, or 3000 — and keeps serving
//     until the process is stopped, so the local runner can drive it.

import { createApp } from './app.ts';

export { createApp } from './app.ts';

type ForgeServer = ReturnType<typeof createApp>;

const SUITE_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const POLL_DELAY_MS = 1000;
const REGISTER_ATTEMPTS = 60;

/** Sleep helper for the register and poll loops. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A port number from text, or undefined when the text is not a port. */
function parsePort(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}

/** The port to listen on outside a trial pod. */
function standalonePort(): number {
  return parsePort(process.argv[2]) ?? parsePort(process.env.PORT) ?? 3000;
}

/** Start the server and resolve with the port it actually bound. */
function startListening(server: ForgeServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Tell the suite which port the forge bound, retrying while it is busy. */
async function registerWithSuite(port: number): Promise<void> {
  const target = `${SUITE_URL}/register`;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
      process.stderr.write(`register attempt ${attempt}: the suite answered HTTP ${response.status}\n`);
    } catch (err) {
      process.stderr.write(`register attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await pause(POLL_DELAY_MS);
  }
  throw new Error(`could not register port ${port} with the suite at ${SUITE_URL}`);
}

/** Poll the suite until it reports that the trial is over. */
async function waitForSuite(): Promise<void> {
  const target = `${SUITE_URL}/done`;
  for (;;) {
    try {
      const response = await fetch(target, { headers: { accept: 'application/json' } });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The suite may not be answering yet; poll again below.
    }
    await pause(POLL_DELAY_MS);
  }
}

try {
  const server = createApp();
  // A server error after startup (not a bind failure) must fail loudly
  // instead of crashing on an unhandled 'error' event.
  server.on('error', (err) => {
    process.stderr.write(`github-forge server error: ${err.message}\n`);
    process.exit(1);
  });
  if (SUITE_URL === '') {
    const port = standalonePort();
    await startListening(server, port);
    process.stdout.write(`github-forge listening on http://127.0.0.1:${port}\n`);
    // Serve forever: this promise never settles, so the process stays
    // alive on the open server until it is stopped from outside.
    await new Promise<void>(() => undefined);
  }
  const port = await startListening(server, 0);
  process.stdout.write(`github-forge listening on port ${port}; registering with the suite\n`);
  await registerWithSuite(port);
  await waitForSuite();
  process.stdout.write('suite finished; shutting down\n');
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
} catch (err) {
  process.stderr.write(`github-forge failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
