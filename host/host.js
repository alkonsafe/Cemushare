// ─────────────────────────────────────────────────────────────────────────────
// emulatorSHARE — HOST runtime (runs ONLY inside headless Chromium).
//
// This is the single piece of code that makes "an emulator" into "a shareable
// console". It is loaded by every console's host page (via /_shared/host.js)
// BEFORE the emulator's own bundle:
//
//   1. pins the viewport / shrinks the render so a GPU-less box stays fast
//   2. shadows AudioContext.destination so game audio is captured
//   3. waits for the game to size its canvas, then encodes canvas+audio
//   4. connects to the relay, registers the console, and replays merged
//      controller state as real key / mouse events
//
// Viewers never run this. They get pixels.
// ─────────────────────────────────────────────────────────────────────────────
//
// The whole file runs inside an IIFE so it does NOT leak into the emulator's
// global scope (a console page declares its own `held`, `canvas`, etc. and a
// bare top-level `const` here would collide and break the emulator). Only
// `window.__hostStart` escapes.
(function () {
'use strict';

const params   = new URLSearchParams(location.search);
const RELAY    = params.get('relay') || 'ws://127.0.0.1:8090/host';
const TOKEN    = params.get('token') || '';
const CONSOLE  = params.get('console') || '';
const META     = { name: params.get('name') || CONSOLE, image: params.get('image') || null,
                   category: params.get('category') || null, description: params.get('desc') || null };
const FPS      = Number(params.get('fps') || 30);
const BITRATE  = Number(params.get('bitrate') || 1_800_000);
const RENDER_W = Number(params.get('w') || 480);
const RENDER_H = Number(params.get('h') || 270);

// ── PIN THE VIEWPORT (must run before the emulator's JS) ────────────────────
function pin(obj, prop, value) {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); }
    catch (err) { console.warn('[host] could not pin', prop, err); }
}

let sdlW = 0, sdlH = 0;
let renderW = RENDER_W, renderH = RENDER_H;

// Clamp the game canvas + scale the GL viewport so we render small (fast).
for (const prop of ['width', 'height']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
    Object.defineProperty(HTMLCanvasElement.prototype, prop, {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) {
            if (this.dataset && this.dataset.hostCanvas !== '1') return desc.set.call(this, v);
            if (prop === 'width') { if (v > 1) sdlW = v; return desc.set.call(this, renderW); }
            if (v > 1) sdlH = v;
            if (sdlW > 1 && sdlH > 1) renderH = Math.round(renderW * (sdlH / sdlW));
            return desc.set.call(this, renderH);
        },
    });
}

function installGlScaling(proto) {
    if (!proto) return;
    for (const fn of ['viewport', 'scissor']) {
        const orig = proto[fn];
        if (!orig) continue;
        proto[fn] = function (x, y, w, h) {
            if (sdlW > 1 && this.canvas && this.canvas._hostCanvas) {
                const s = this.drawingBufferWidth / sdlW;
                return orig.call(this, Math.round(x * s), Math.round(y * s),
                                       Math.round(w * s), Math.round(h * s));
            }
            return orig.call(this, x, y, w, h);
        };
    }
}
installGlScaling(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
installGlScaling(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

pin(window, 'innerWidth', RENDER_W);
pin(window, 'innerHeight', RENDER_H);
pin(window.screen, 'width', RENDER_W);
pin(window.screen, 'height', RENDER_H);
pin(window.screen, 'availWidth', RENDER_W);
pin(window.screen, 'availHeight', RENDER_H);

const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5 };

let ws = null, wsReady = false, wantKeyframe = true;
let videoEncoder = null, audioEncoder = null, sentVideoConfig = false, sentAudioConfig = false;
let capturedAudioStream = null;

function log(...a) {
    console.log('[host]', ...a);
    if (wsReady) try { ws.send(JSON.stringify({ t: 'log', text: a.join(' ') })); } catch {}
}

// ── Framing: [kind:u8][timestamp:f64][payload] ───────────────────────────────
function frame(kind, timestamp, payload) {
    const out = new Uint8Array(9 + payload.byteLength);
    out[0] = kind;
    new DataView(out.buffer).setFloat64(1, timestamp, true);
    out.set(new Uint8Array(payload), 9);
    return out;
}
function sendMedia(kind, timestamp, chunkBytes) {
    if (!wsReady) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) return;
    try { ws.send(frame(kind, timestamp, chunkBytes)); } catch {}
}

// ── AUDIO CAPTURE (installed before the emulator builds its context) ────────
(function patchAudioContext() {
    const Native = window.AudioContext || window.webkitAudioContext;
    if (!Native) return;
    class HostAudioContext extends Native {
        constructor(...args) {
            super(...args);
            let sink = null;
            try { sink = this.createMediaStreamDestination(); capturedAudioStream = sink.stream; }
            catch (err) { console.warn('[host] audio capture unavailable', err); }
            if (sink) Object.defineProperty(this, 'destination', { get: () => sink, configurable: true });
        }
    }
    window.AudioContext = HostAudioContext;
    window.webkitAudioContext = HostAudioContext;
})();

// ── VIDEO ENCODE ─────────────────────────────────────────────────────────────
const CODEC_CANDIDATES = [
    { codec: 'avc1.42001f', avc: { format: 'annexb' } },
    { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
    { codec: 'vp8' },
    { codec: 'vp09.00.10.08' },
];

async function pickVideoCodec(width, height) {
    for (const cand of CODEC_CANDIDATES) {
        const config = { ...cand, width, height, bitrate: BITRATE, framerate: FPS, latencyMode: 'realtime' };
        try { const s = await VideoEncoder.isConfigSupported(config); if (s && s.supported) return config; } catch {}
    }
    return null;
}

function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

async function startVideo(canvas) {
    const width = canvas.width || 640, height = canvas.height || 480;
    const config = await pickVideoCodec(width, height);
    if (!config) { log('FATAL: no supported video encoder config'); return; }
    log(`video: ${config.codec} ${width}x${height}@${FPS} ${(BITRATE / 1000) | 0}kbps`);

    videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => {
            if (!sentVideoConfig && metadata && metadata.decoderConfig) {
                const dc = metadata.decoderConfig;
                const desc = dc.description ? b64(new Uint8Array(dc.description.buffer || dc.description)) : null;
                sentVideoConfig = true;
                if (wsReady) ws.send(JSON.stringify({ t: 'vconfig', config: {
                    codec: dc.codec, codedWidth: dc.codedWidth || width, codedHeight: dc.codedHeight || height, description: desc } }));
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            sendMedia(chunk.type === 'key' ? KIND.VKEY : KIND.VDELTA, chunk.timestamp, bytes);
        },
        error: (err) => log('video encoder error:', err.message),
    });
    videoEncoder.configure(config);

    const stream = canvas.captureStream(FPS);
    const track = stream.getVideoTracks()[0];
    if (!track) { log('FATAL: canvas produced no video track'); return; }
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();

    let n = 0;
    for (;;) {
        const { value: videoFrame, done } = await reader.read();
        if (done) break;
        if (!videoEncoder || videoEncoder.state !== 'configured') { videoFrame.close(); continue; }
        if (videoEncoder.encodeQueueSize > 2) { videoFrame.close(); continue; }
        if (videoFrame.displayWidth !== config.width || videoFrame.displayHeight !== config.height) {
            log(`canvas resized to ${videoFrame.displayWidth}x${videoFrame.displayHeight} — reconfiguring`);
            videoFrame.close();
            try { reader.cancel(); } catch {}
            try { videoEncoder.close(); } catch {}
            videoEncoder = null; sentVideoConfig = false;
            startVideo(canvas);
            return;
        }
        const key = wantKeyframe || (n++ % (FPS * 2) === 0);
        wantKeyframe = false;
        try { videoEncoder.encode(videoFrame, { keyFrame: key }); } catch (err) { log('encode failed', err.message); }
        videoFrame.close();
    }
}

async function startAudio() {
    for (let i = 0; i < 600 && !capturedAudioStream; i++) await new Promise((r) => setTimeout(r, 100));
    if (!capturedAudioStream) { log('no audio stream after 60s — running silent'); return; }
    log('audio stream captured');
    const track = capturedAudioStream.getAudioTracks()[0];
    if (!track) { log('no audio track — running silent'); return; }

    audioEncoder = new AudioEncoder({
        output: (chunk, metadata) => {
            if (!sentAudioConfig && metadata && metadata.decoderConfig) {
                const dc = metadata.decoderConfig;
                const desc = dc.description ? b64(new Uint8Array(dc.description.buffer || dc.description)) : null;
                sentAudioConfig = true;
                if (wsReady) ws.send(JSON.stringify({ t: 'aconfig', config: { codec: dc.codec,
                    sampleRate: dc.sampleRate, numberOfChannels: dc.numberOfChannels, description: desc } }));
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            sendMedia(KIND.ACHUNK, chunk.timestamp, bytes);
        },
        error: (err) => log('audio encoder error:', err.message),
    });
    const settings = track.getSettings ? track.getSettings() : {};
    audioEncoder.configure({ codec: 'opus', sampleRate: settings.sampleRate || 48000,
        numberOfChannels: settings.channelCount || 2, bitrate: 96_000 });

    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for (;;) {
        const { value: audioData, done } = await reader.read();
        if (done) break;
        if (!audioEncoder || audioEncoder.state !== 'configured') { audioData.close(); continue; }
        if (audioEncoder.encodeQueueSize > 8) { audioData.close(); continue; }
        try { audioEncoder.encode(audioData); } catch {}
        audioData.close();
    }
}

// ── INPUT — merged controller from the relay, replayed as events ────────────
const held = new Set();

function keyEvent(type, code) {
    const canvas = document.querySelector('canvas[data-host-canvas="1"]');
    const init = { code, key: code, bubbles: true, cancelable: true };
    if (canvas) canvas.dispatchEvent(new KeyboardEvent(type, init));
    document.dispatchEvent(new KeyboardEvent(type, init));
    window.dispatchEvent(new KeyboardEvent(type, init));
}

function applyInput(keys) {
    const desired = new Set(keys);
    for (const code of [...held]) if (!desired.has(code)) { keyEvent('keyup', code); held.delete(code); }
    for (const code of desired) if (!held.has(code)) { keyEvent('keydown', code); held.add(code); }
}

function mouseEvent(type, x, y, button) {
    const canvas = document.querySelector('canvas[data-host-canvas="1"]');
    const target = canvas || document.body;
    const box = target.getBoundingClientRect();
    const cw = target.clientWidth || target.width || 1;
    const ch = target.clientHeight || target.height || 1;
    const cx = Math.round(x * (cw / Math.max(1, target.clientWidth || target.width || 1)));
    const cy = Math.round(y * (ch / Math.max(1, target.clientHeight || target.height || 1)));
    target.dispatchEvent(new MouseEvent(type, {
        clientX: box.left + cx, clientY: box.top + cy,
        button: button || 0, buttons: type === 'mousedown' ? 1 : 0,
        bubbles: true, cancelable: true,
    }));
}

function applyMouse(m) {
    if (!m) return;
    mouseEvent('mousemove', m.x, m.y, m.button);
}
function applyClick(m) {
    if (!m) return;
    mouseEvent('mousedown', m.x, m.y, m.button);
    setTimeout(() => mouseEvent('mouseup', m.x, m.y, m.button), 40);
}

function releaseAll() {
    for (const code of held) keyEvent('keyup', code);
    held.clear();
}

// ── Relay link ───────────────────────────────────────────────────────────────
function connect() {
    const url = RELAY + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
    ws = new WebSocket(url + (url.includes('?') ? '&' : '?') + `console=${encodeURIComponent(CONSOLE)}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        wsReady = true;
        log('relay connected');
        sentVideoConfig = false; sentAudioConfig = false; wantKeyframe = true;
        ws.send(JSON.stringify({ t: 'register', console: { key: CONSOLE, ...META } }));
    };
    ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'input') {
            applyInput(Array.isArray(msg.keys) ? msg.keys : []);
            if (msg.mouse && msg.mouse.click) applyClick(msg.mouse);
            else if (msg.mouse) applyMouse(msg.mouse);
        } else if (msg.t === 'keyframe') wantKeyframe = true;
        else if (msg.t === 'reload') { log('relay asked for a reload (video stalled)'); location.reload(); }
    };
    ws.onclose = () => {
        wsReady = false;
        releaseAll();
        setTimeout(connect, 1000);
    };
    ws.onerror = () => {};
}

// ── Boot ─────────────────────────────────────────────────────────────────────
window.__hostStart = async function hostStart() {
    const canvas = document.querySelector('canvas[data-host-canvas="1"]');
    if (!canvas) { log('FATAL: no [data-host-canvas] element'); return; }
    connect();
    const MIN_W = Math.min(64, RENDER_W), MIN_H = Math.min(64, RENDER_H);
    for (let i = 0; i < 600 && !(canvas.width >= MIN_W && canvas.height >= MIN_H); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    log(`canvas ready ${canvas.width}x${canvas.height}`);
    try { if (Module.SDL2 && Module.SDL2.audioContext) await Module.SDL2.audioContext.resume(); } catch {}
    startVideo(canvas);
    startAudio();
};

})();
