import env from "env-var";
import { getRotatedDimensions } from "./util.js";
const DEFAULTS = {
    tileSize: 32,
    fullFrameTileCount: 4,
    fullFrameAreaThreshold: 0.5,
    fullFrameEvery: 50,
    everyNthFrame: 1,
    minFrameInterval: 80,
    jpegQuality: 85,
    maxBytesPerMessage: 14336,
    rotation: 0,
};
const TRUE_RE = /^(1|true|yes|on)$/i;
function parseBool(value, defaultValue = false) {
    if (value == null || value.trim() === "")
        return defaultValue;
    return TRUE_RE.test(value);
}
const store = new Map();
export function getConfigFor(id) {
    const cfg = store.get(id);
    if (!cfg)
        throw new Error(`config for id="${id}" not found`);
    return cfg;
}
export function setConfigFor(id, cfg) {
    store.set(id, cfg);
}
function num(input) {
    if (input == null)
        return undefined;
    const v = Number(input);
    if (!Number.isFinite(v))
        throw new Error(`invalid number: "${input}"`);
    return v;
}
function intPos(input) {
    const v = num(input);
    if (v == null)
        return undefined;
    if (!Number.isInteger(v) || v <= 0)
        throw new Error(`invalid positive integer: "${input}"`);
    return v;
}
function intNonNeg(input) {
    const v = num(input);
    if (v == null)
        return undefined;
    if (!Number.isInteger(v) || v < 0)
        throw new Error(`invalid non-negative integer: "${input}"`);
    return v;
}
function float01(input) {
    const v = num(input);
    if (v == null)
        return undefined;
    if (v < 0 || v > 1)
        throw new Error(`invalid 0..1 number: "${input}"`);
    return v;
}
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
function readEnvFallbacks() {
    const val = (name) => env.get(name).asString() ?? undefined;
    const out = {};
    const TS = val("TILE_SIZE");
    const FFTC = val("FULL_FRAME_TILE_COUNT");
    const FFAT = val("FULL_FRAME_AREA_THRESHOLD");
    const FFE = val("FULL_FRAME_EVERY");
    const ENF = val("EVERY_NTH_FRAME");
    const MFI = val("MIN_FRAME_INTERVAL_MS");
    const Q = val("JPEG_QUALITY");
    const MBPM = val("MAX_BYTES_PER_MESSAGE");
    if (TS)
        out.tileSize = intPos(TS);
    if (FFTC)
        out.fullFrameTileCount = intPos(FFTC);
    if (FFAT != null)
        out.fullFrameAreaThreshold = float01(FFAT);
    if (FFE)
        out.fullFrameEvery = intPos(FFE);
    if (ENF)
        out.everyNthFrame = intPos(ENF);
    if (MFI != null)
        out.minFrameInterval = intNonNeg(MFI);
    if (Q)
        out.jpegQuality = clamp(intPos(Q), 1, 100);
    if (MBPM)
        out.maxBytesPerMessage = intPos(MBPM);
    return out;
}
export function makeConfigFromParams(params) {
    const envFallbacks = readEnvFallbacks();
    // required
    let height = intPos(params.get("h")) ?? envFallbacks.height;
    let width = intPos(params.get("w")) ?? envFallbacks.width;
    if (!height || !width)
        throw new Error(`missing required params "h" and/or "w"`);
    // optional
    const tileSize = intPos(params.get("ts")) ?? envFallbacks.tileSize ?? DEFAULTS.tileSize;
    const fullFrameTileCount = intPos(params.get("fftc")) ?? envFallbacks.fullFrameTileCount ?? DEFAULTS.fullFrameTileCount;
    const fullFrameAreaThreshold = float01(params.get("ffat")) ?? envFallbacks.fullFrameAreaThreshold ?? DEFAULTS.fullFrameAreaThreshold;
    const fullFrameEvery = intPos(params.get("ffe")) ?? envFallbacks.fullFrameEvery ?? DEFAULTS.fullFrameEvery;
    const minFrameInterval = intNonNeg(params.get("mfi")) ?? envFallbacks.minFrameInterval ?? DEFAULTS.minFrameInterval;
    const everyNthFrame = intPos(params.get("enf")) ?? envFallbacks.everyNthFrame ?? DEFAULTS.everyNthFrame;
    const jpegQuality = clamp(intPos(params.get("q")) ?? envFallbacks.jpegQuality ?? DEFAULTS.jpegQuality, 1, 100);
    const maxBytesPerMessage = intPos(params.get("mbpm")) ?? envFallbacks.maxBytesPerMessage ?? DEFAULTS.maxBytesPerMessage;
    const rotation = intNonNeg(params.get("r"))
        ?? DEFAULTS.rotation;
    const dimensions = getRotatedDimensions(width, height, rotation);
    return {
        height: dimensions.height,
        width: dimensions.width,
        tileSize,
        fullFrameTileCount,
        fullFrameAreaThreshold,
        fullFrameEvery,
        minFrameInterval,
        everyNthFrame,
        jpegQuality,
        maxBytesPerMessage,
        rotation,
    };
}
export function deviceConfigsEqual(a, b, eps = 1e-6) {
    return (a.width === b.width &&
        a.height === b.height &&
        a.tileSize === b.tileSize &&
        a.fullFrameTileCount === b.fullFrameTileCount &&
        Math.abs(a.fullFrameAreaThreshold - b.fullFrameAreaThreshold) <= eps &&
        a.fullFrameEvery === b.fullFrameEvery &&
        a.everyNthFrame === b.everyNthFrame &&
        a.minFrameInterval === b.minFrameInterval &&
        a.jpegQuality === b.jpegQuality &&
        a.maxBytesPerMessage === b.maxBytesPerMessage &&
        a.rotation === b.rotation);
}
export function logDeviceConfig(id, cfg) {
    const entries = [
        ["width", cfg.width],
        ["height", cfg.height],
        ["tileSize", cfg.tileSize],
        ["fullFrameTileCount", cfg.fullFrameTileCount],
        ["fullFrameAreaThreshold", cfg.fullFrameAreaThreshold.toFixed(3)],
        ["fullFrameEvery", cfg.fullFrameEvery],
        ["everyNthFrame", cfg.everyNthFrame],
        ["minFrameInterval", cfg.minFrameInterval],
        ["jpegQuality", cfg.jpegQuality],
        ["maxBytesPerMessage", cfg.maxBytesPerMessage],
        ["rotation", cfg.rotation],
    ];
    const head = `[client_connect] id=${id}`;
    const body = entries.map(([k, v]) => `  ${k}=${v}`).join('\n');
    console.info(`${head}\n${body}`);
}
export function readInjectScriptConfig() {
    const urlRaw = env.get("INJECT_JS_URL").asString();
    const url = urlRaw && urlRaw.trim() !== "" ? urlRaw.trim() : undefined;
    const allowHttpRaw = env.get("INJECT_JS_ALLOW_HTTP").asString();
    const allowHttp = parseBool(allowHttpRaw, false);
    return {
        url,
        allowHttp,
    };
}
