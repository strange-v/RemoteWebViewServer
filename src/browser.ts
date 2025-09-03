import { chromium } from 'playwright';
import { initCdpRootAsync, waitForCdpReadyAsync } from './cdpRoot.js';

const DEBUG_PORT = +(process.env.DEBUG_PORT || 9221);
const USER_DATA_DIR = process.env.USER_DATA_DIR || (process.platform === 'win32'
  ? 'C:\\Temp\\remotewebview-profile'
  : '/var/temp/remotewebview-profile');

async function fetchJsonVersionAsync(): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function startHeadlessIfNeededAsync(): Promise<void> {
  const info = await fetchJsonVersionAsync();
  if (info?.webSocketDebuggerUrl) return;

  await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: [
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--no-sandbox',
      '--force-device-scale-factor=1',
      '--headless=new',
    ],
  });

  const t0 = Date.now();
  for (;;) {
    const j = await fetchJsonVersionAsync();
    if (j?.webSocketDebuggerUrl) return;
    if (Date.now() - t0 > 10000) throw new Error('Timed out waiting for CDP /json/version');
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function bootstrapAsync(): Promise<void> {
  await startHeadlessIfNeededAsync();

  const info = await fetchJsonVersionAsync();
  if (!info?.webSocketDebuggerUrl) throw new Error('CDP not available');

  await initCdpRootAsync(info.webSocketDebuggerUrl);
  await waitForCdpReadyAsync();
  console.log('[cdp] ready:', info.webSocketDebuggerUrl);
}
