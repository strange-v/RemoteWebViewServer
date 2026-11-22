// Optional Home Assistant auto-login: builds a browser script that seeds a
// long-lived access token into the HA pages the server renders, so displays
// survive reboots without a manual DevTools login.

export type HaAuthEnv = {
  HA_AUTH_TOKEN?: string | undefined;
  HA_URL?: string | undefined;
};

// HA_URL is comma-separated base URLs (e.g. internal + external URL); the token
// is only seeded on their origins.
function parseOrigins(haUrl: string): string[] {
  const entries = haUrl.split(",").map(s => s.trim()).filter(s => s !== "");
  if (entries.length === 0)
    throw new Error("HA_AUTH_TOKEN is set but HA_URL is empty; set HA_URL to the Home Assistant base URL(s), e.g. https://ha.example.com");
  // A Set keeps the first occurrence: internal_url === external_url must not
  // yield a duplicate origin.
  return [...new Set(entries.map(entry => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`HA_URL entry is not a valid URL: "${entry}"`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error(`HA_URL entry must be an http(s) URL: "${entry}"`);
    return url.origin;
  }))];
}

// Pure builder (env passed in) so tests can exercise every input. Returns
// undefined when no token is configured: auto-login fully off.
export function buildHaAuthScript(env: HaAuthEnv): string | undefined {
  const token = (env.HA_AUTH_TOKEN ?? "").trim();
  if (token === "") return undefined;
  const origins = parseOrigins((env.HA_URL ?? "").trim());
  // The config is embedded as JSON: the token may contain any characters.
  const config = JSON.stringify({ origins, token });
  return `(() => {
  // A failure here must not break the page or scripts injected after this one.
  try {
    const C = ${config};
    // The token must never reach an origin other than the configured HA ones.
    const origin = location.origin;
    if (!C.origins.includes(origin)) return;
    localStorage.setItem("hassTokens", JSON.stringify({
      access_token: C.token, refresh_token: C.token, hassUrl: origin, clientId: origin + "/",
      expires: Date.now() + 3650 * 864e5, expires_in: 3650 * 86400,
    }));
    if (/^\\/auth\\//.test(location.pathname)) {
      let dest = origin + "/";
      try {
        const redirect = new URLSearchParams(location.search).get("redirect_uri");
        if (redirect && new URL(redirect, location.href).origin === origin) dest = redirect;
      } catch { }
      location.replace(dest);
    }
  } catch (e) {
    console.warn("[ha-auth] injected script failed:", e);
  }
})();`;
}
