import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { buildHaAuthScript } from "../src/haAuth.js";

// The generated script runs in the rendered page; these tests execute it in a
// fresh V8 context with only the browser globals it may touch.
const HA = "https://ha.example.com";
const HA2 = "http://ha.local:8123";

type Page = {
  href: string;
  localStorage?: Pick<Storage, "getItem" | "setItem">;
};

function runInPage(script: string, page: Page) {
  const storage = new Map<string, string>();
  const url = new URL(page.href);
  const replaced: string[] = [];
  vm.runInNewContext(script, {
    location: {
      origin: url.origin,
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      replace: (dest: string) => { replaced.push(dest); },
    },
    localStorage: page.localStorage ?? {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    },
    URL,
    URLSearchParams,
    console: { warn: () => { } },
  });
  return {
    hassTokens: () => JSON.parse(storage.get("hassTokens") ?? "null") as Record<string, unknown> | null,
    replaced,
  };
}

describe("buildHaAuthScript", () => {
  it("returns undefined without HA_AUTH_TOKEN", () => {
    expect(buildHaAuthScript({})).toBeUndefined();
    expect(buildHaAuthScript({ HA_AUTH_TOKEN: "  ", HA_URL: HA })).toBeUndefined();
  });

  it("fails fast when the token is set but HA_URL is empty", () => {
    expect(() => buildHaAuthScript({ HA_AUTH_TOKEN: "t" })).toThrow(/HA_URL/);
    expect(() => buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: " , " })).toThrow(/HA_URL/);
  });

  it("fails fast on a HA_URL entry that is not a valid http(s) URL", () => {
    expect(() => buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: "ha.example.com" })).toThrow(/ha\.example\.com/);
    expect(() => buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: `${HA},ftp://ha.example.com` })).toThrow(/ftp/);
  });

  it("does nothing on a foreign origin", () => {
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: HA })!;
    const page = runInPage(script, { href: "https://other.example.net/lovelace/0" });
    expect(page.hassTokens()).toBeNull();
    expect(page.replaced).toEqual([]);
  });

  it("seeds tokens on every configured origin", () => {
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: "secret", HA_URL: `${HA},${HA2}` })!;
    for (const origin of [HA, HA2]) {
      const page = runInPage(script, { href: `${origin}/lovelace/0` });
      const tokens = page.hassTokens()!;
      expect(tokens.access_token).toBe("secret");
      expect(tokens.refresh_token).toBe("secret");
      expect(tokens.hassUrl).toBe(origin);
      expect(tokens.clientId).toBe(`${origin}/`);
      // A ten-year expiry keeps the seeded session from expiring.
      expect(tokens.expires).toBeGreaterThan(Date.now() + 9 * 365 * 864e5);
      expect(tokens.expires_in).toBe(3650 * 86400);
      expect(page.replaced).toEqual([]);
    }
  });

  it("seeds each origin once when HA_URL lists it twice", () => {
    // internal_url === external_url must not duplicate the origin in the
    // script's embedded config (a trailing slash is the same origin).
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: `${HA},${HA}/` })!;
    const config = JSON.parse(script.match(/const C = (\{.*\});/)![1]) as { origins: string[] };
    expect(config.origins).toEqual([HA]);
  });

  it("redirects a /auth page to a same-origin redirect_uri", () => {
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: HA })!;
    const target = `${HA}/lovelace/0`;
    const page = runInPage(script, {
      href: `${HA}/auth/authorize?redirect_uri=${encodeURIComponent(target)}`,
    });
    expect(page.replaced).toEqual([target]);
  });

  it("redirects a /auth page to the origin when redirect_uri is foreign", () => {
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: HA })!;
    const page = runInPage(script, {
      href: `${HA}/auth/authorize?redirect_uri=${encodeURIComponent("https://evil.example.net/steal")}`,
    });
    expect(page.replaced).toEqual([`${HA}/`]);
  });

  it("embeds tokens containing quotes, </script> and $& intact", () => {
    const token = 'a"b</script>$&\\c';
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: token, HA_URL: HA })!;
    const page = runInPage(script, { href: `${HA}/lovelace/0` });
    expect(page.hassTokens()!.access_token).toBe(token);
    expect(page.hassTokens()!.refresh_token).toBe(token);
  });

  it("cannot break the page when localStorage throws", () => {
    const script = buildHaAuthScript({ HA_AUTH_TOKEN: "t", HA_URL: HA })!;
    expect(() => runInPage(script, {
      href: `${HA}/lovelace/0`,
      localStorage: {
        getItem: () => null,
        setItem: () => { throw new Error("boom"); },
      },
    })).not.toThrow();
  });
});
