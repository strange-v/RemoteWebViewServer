import { mkdir } from 'fs/promises';
import { chromium } from 'playwright-core';
import { initCdpRootAsync, waitForCdpReadyAsync } from './cdpRoot.js';

const DEBUG_PORT = +(process.env.DEBUG_PORT || 9221);
const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
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

  await mkdir(USER_DATA_DIR, { recursive: true });
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-sandbox',
    '--force-device-scale-factor=1',
    '--headless=new',
    ...(PREFERS_REDUCED_MOTION ? ['--force-prefers-reduced-motion'] : []),
  ];

  if (PREFERS_REDUCED_MOTION)
    console.log('[browser] Launching with prefers-reduced-motion');

  await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args,
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
