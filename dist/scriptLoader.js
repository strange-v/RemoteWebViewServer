let cachedUrl;
let cachedScript;
function isAllowedProtocol(url, allowHttp) {
    if (url.protocol === "https:")
        return true;
    if (allowHttp && url.protocol === "http:")
        return true;
    return false;
}
export async function getInjectScriptFromUrl(cfg) {
    if (!cfg.url) {
        console.warn("[inject] INJECT_JS_URL is not set; script injection skipped");
        return undefined;
    }
    if (cachedUrl === cfg.url && cachedScript) {
        return cachedScript;
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(cfg.url);
    }
    catch {
        console.warn("[inject] Invalid INJECT_JS_URL; script injection skipped");
        return undefined;
    }
    if (!isAllowedProtocol(parsedUrl, cfg.allowHttp)) {
        console.warn("[inject] INJECT_JS_URL must use https (or http when INJECT_JS_ALLOW_HTTP=true)");
        return undefined;
    }
    if (typeof fetch !== "function") {
        console.warn("[inject] fetch is not available in this Node runtime; script injection skipped");
        return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(parsedUrl, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "Accept": "application/javascript, text/javascript, text/plain;q=0.9, */*;q=0.8",
            },
        });
        if (!response.ok) {
            console.warn(`[inject] Failed to download script: HTTP ${response.status}; script injection skipped`);
            return undefined;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const script = bytes.toString("utf8");
        if (!script.trim()) {
            console.warn("[inject] Downloaded script is empty; script injection skipped");
            return undefined;
        }
        cachedUrl = cfg.url;
        cachedScript = script;
        return script;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[inject] Failed to download script: ${message}; script injection skipped`);
        return undefined;
    }
    finally {
        clearTimeout(timeout);
    }
}
