import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { createServer as createViteServer } from 'vite';

const projectRoot = resolve(import.meta.dirname, '..');

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a TCP port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitFor(url, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label} did not start: ${lastError || 'timed out'}`);
}

async function webdriver(baseUrl, path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    const detail = payload.value?.message || JSON.stringify(payload);
    throw new Error(`WebDriver ${method} ${path} failed: ${detail}`);
  }
  return payload.value;
}

async function executeAsync(baseUrl, sessionId, script, args = []) {
  return webdriver(
    baseUrl,
    `/session/${sessionId}/execute/async`,
    'POST',
    { script, args },
  );
}

const driverPort = await reservePort();
const vite = await createViteServer({
  root: projectRoot,
  logLevel: 'silent',
  server: { host: '127.0.0.1' },
});
const safariDriver = spawn(
  process.env.SAFARIDRIVER_PATH || '/usr/bin/safaridriver',
  ['--port', String(driverPort)],
  { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
);
let driverLog = '';
safariDriver.stdout.on('data', (chunk) => { driverLog += chunk; });
safariDriver.stderr.on('data', (chunk) => { driverLog += chunk; });

let sessionId;
try {
  await vite.listen();
  const viteUrl = vite.resolvedUrls?.local[0]?.replace(/\/$/, '');
  if (!viteUrl) throw new Error('Vite did not expose a local URL');
  await waitFor(`http://127.0.0.1:${driverPort}/status`, 'safaridriver');
  const session = await webdriver(
    `http://127.0.0.1:${driverPort}`,
    '/session',
    'POST',
    { capabilities: { alwaysMatch: { browserName: 'safari' } } },
  );
  sessionId = session.sessionId;
  const baseUrl = `http://127.0.0.1:${driverPort}`;
  await webdriver(baseUrl, `/session/${sessionId}/window/rect`, 'POST', {
    x: 0,
    y: 0,
    width: 800,
    height: 500,
  });
  await webdriver(baseUrl, `/session/${sessionId}/url`, 'POST', {
    url: `${viteUrl}/tests/safari-native.html`,
  });

  const results = [];
  for (const name of ['solid', 'rich', 'wrapped']) {
    await executeAsync(
      baseUrl,
      sessionId,
      `const done = arguments[arguments.length - 1];
       window.safariNativeOracle.setFixture(arguments[0]).then(done, error => done({ error: String(error) }));`,
      [name],
    );
    const screenshot = await webdriver(baseUrl, `/session/${sessionId}/screenshot`);
    const result = await executeAsync(
      baseUrl,
      sessionId,
      `const done = arguments[arguments.length - 1];
       window.safariNativeOracle.compareScreenshot(arguments[0]).then(done, error => done({ error: String(error) }));`,
      [screenshot],
    );
    if (result.error) throw new Error(`${name}: ${result.error}`);
    results.push(result);
  }

  const solid = results.find((result) => result.name === 'solid');
  if (!solid) throw new Error('Safari oracle did not report the solid fixture');
  if (solid.mismatchedPixels !== 0) {
    throw new Error(`Safari native screenshot transport is not exact: ${solid.mismatchedPixels} pixels differ`);
  }
  for (const result of results.filter(({ name }) => name !== 'solid')) {
    if (!result.wrapMatches) {
      throw new Error(
        `Safari ${result.name} wrapping differs:\n${result.wrapDifferences
          .map((d) => `  line ${d.lineIndex}: canvas="${d.canvas}" dom="${d.dom}"`)
          .join('\n')}`,
      );
    }
    if (result.contentMismatchPercentage > 5) {
      throw new Error(
        `Safari ${result.name} native-DOM mismatch is ${result.contentMismatchPercentage.toFixed(2)}% (> 5%)`,
      );
    }
  }

  console.log('Actual Safari native-DOM oracle passed:');
  for (const result of results) {
    console.log(
      `  ${result.name}: ${result.mismatchedPixels} pixels, ` +
      `${result.contentMismatchPercentage.toFixed(2)}% of content, ` +
      `wrap=${result.wrapMatches ? 'exact' : 'different'}, DPR=${result.pixelRatio}`,
    );
  }
} catch (error) {
  const errorText = error instanceof Error ? error.stack : String(error);
  const hint = `${errorText}\n${driverLog}`.includes('remote automation')
    ? '\nEnable Safari remote automation first: sudo safaridriver --enable'
    : '';
  console.error(`${errorText}${hint}`);
  if (driverLog) console.error(`\nsafaridriver output:\n${driverLog.trim()}`);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    await webdriver(
      `http://127.0.0.1:${driverPort}`,
      `/session/${sessionId}`,
      'DELETE',
    ).catch(() => {});
  }
  await vite.close();
  safariDriver.kill();
}
