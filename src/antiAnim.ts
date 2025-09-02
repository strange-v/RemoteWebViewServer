import { CdpSession } from "./cdpRoot";

export async function installAntiAnimCSSAsync(session: CdpSession) {
  const antiAnimCSS = `
    * { animation: none !important; transition: none !important; }
    html, body { overscroll-behavior: none !important; }
  `;

  const script = `
    (function() {
      try {
        const style = document.createElement('style');
        style.textContent = \`${antiAnimCSS}\`;
        document.documentElement.appendChild(style);
      } catch (e) {
        console.warn('[antiAnimCSS] injection failed', e);
      }
    })();
  `;

  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: script,
  });
}
