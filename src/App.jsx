import React, { useRef, useState, useEffect } from "react";

const N = 32;
const CELL = 16;
const blank = () => new Array(N * N).fill(0);
const HISTORY_LIMIT = 30;

// Brush sizes offered below the canvas. 1 = single pixel (old behaviour).
const BRUSH_SIZES = [1, 2, 3, 4, 6, 8];

// Ghost / hover preview tints. Kept low-opacity so the pixels underneath
// stay readable; the erase ghost uses the accent so the two modes are
// visually distinct before you touch the canvas.
const GHOST_DRAW  = "rgba(20,20,20,0.22)";
const GHOST_ERASE = "rgba(217,79,43,0.28)";

// Must match the firmware UUIDs
const AVATAR_SERVICE_UUID = "c0017000-1234-5678-9abc-def012345678";
const AVATAR_CHAR_UUID    = "c0017001-1234-5678-9abc-def012345678";

// While the pendant is in Pairing mode it also runs its own open WiFi
// hotspot at this fixed address (see startPairingAP() in the firmware).
const WIFI_HOST = "192.168.4.1";
const wifiUrl = (path) => `http://${WIFI_HOST}${path}`;

async function fetchWithTimeout(url, opts = {}, ms = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

// Pack pixels into the firmware's format: row-major, 4 bytes/row, MSB = leftmost pixel
function pack(px) {
  const out = new Uint8Array(128);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (px[y * N + x]) out[y * 4 + (x >> 3)] |= 1 << (7 - (x & 7));
  return out;
}
// Inverse of pack(): turn 128 raw avatar bytes back into a pixel array.
function unpack(bytes) {
  const px = blank();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (bytes[y * 4 + (x >> 3)] & (1 << (7 - (x & 7)))) px[y * N + x] = 1;
  return px;
}
// The pendant's characteristic value is [hasAvatar flag, ...128 avatar bytes].
function unpackFrame(bytes) {
  if (!bytes || bytes.length < 1 + 128) return null;
  if (bytes[0] !== 1) return null;
  return unpack(bytes.slice(1, 1 + 128));
}
const toHex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
function fromHex(h) {
  const c = (h || "").replace(/[^0-9a-f]/gi, "");
  if (c.length !== 256) return null;
  const px = blank();
  for (let i = 0; i < 128; i++) {
    const b = parseInt(c.substr(i * 2, 2), 16);
    for (let bit = 0; bit < 8; bit++)
      px[((i / 4) | 0) * N + (i % 4) * 8 + bit] = (b >> (7 - bit)) & 1;
  }
  return px;
}

const btOk = typeof navigator !== "undefined" && "bluetooth" in navigator;
const isBlank = (p) => !p || p.every((v) => !v);

// Rough classifier for "this wasn't a normal HTTP error, the browser
// wouldn't even let the request out". Only used on the WiFi path to decide
// whether to surface the network-help panel - the exact cause still gets
// logged verbatim either way.
const looksLikeNetworkBlock = (err) => {
  const m = (err && err.message) || String(err || "");
  return /failed to fetch|networkerror|load failed|blocked|mixed content|local network|err_/i.test(m);
};

// Tiny read-only preview of a 32x32 pixel array
function MiniAvatar({ pixels }) {
  const ref = useRef(null);
  useEffect(() => {
    const ctx = ref.current.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, N, N);
    ctx.fillStyle = "#000";
    (pixels || []).forEach((v, i) => {
      if (!v) return;
      ctx.fillRect(i % N, (i / N) | 0, 1, 1);
    });
  }, [pixels]);
  return <canvas ref={ref} className="prev" width={N} height={N} />;
}

const css = `
  :root { --paper:#e8e4d8; --ink:#141414; --accent:#d94f2b; --mute:#7a766b; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:var(--paper); color:var(--ink);
    font-family:'Courier New',ui-monospace,monospace; }
  .wrap { max-width:860px; margin:0 auto; padding:28px 20px;
    padding-left:max(20px, env(safe-area-inset-left));
    padding-right:max(20px, env(safe-area-inset-right));
    padding-bottom:max(28px, env(safe-area-inset-bottom)); }
  h1 { font-size:34px; letter-spacing:-1px; margin:0 0 4px; }
  .sub { color:var(--mute); margin:0 0 20px; }
  .row { display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start; }
  .stage { flex:1 1 320px; max-width:512px; width:100%; }
  canvas.grid { width:100%; height:auto; aspect-ratio:1; display:block; border:3px solid var(--ink);
    background:#fff; touch-action:none; user-select:none; -webkit-user-select:none;
    -webkit-touch-callout:none; cursor:crosshair; }
  .side { flex:1 1 220px; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .tools { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  button { font:inherit; min-height:44px; padding:9px 12px; background:var(--paper); color:var(--ink);
    border:2px solid var(--ink); cursor:pointer; text-align:left; }
  button:active:not(:disabled) { background:var(--ink); color:var(--paper); }
  button.on { background:var(--ink); color:var(--paper); }
  button.go { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.4; cursor:not-allowed; }
  .lbl { font-size:12px; text-transform:uppercase; letter-spacing:2px; color:var(--mute); margin-top:6px; }
  .prev { border:2px solid var(--ink); background:#fff; image-rendering:pixelated;
    width:64px; height:64px; align-self:flex-start; }
  .hint { border:2px solid var(--ink); padding:10px; font-size:13px; line-height:1.4;
    background:#fff; }

  /* Blank-canvas / status banner. Sits directly above the Pendant buttons.
     Flat, 2px ink border and 13px/1.4 metrics match .hint exactly - only
     the accent fill and white bold text set it apart as an alert. */
  .notice { background:var(--accent); color:#fff; border:2px solid var(--ink);
    padding:10px; font-size:13px; font-weight:bold; line-height:1.4; }

  /* Instructions / help panel. Same chrome as .hint but with an accent
     left edge so it reads as a "you need to do something" callout. */
  .help { border:2px solid var(--ink); border-left:6px solid var(--accent);
    padding:12px; font-size:13px; line-height:1.45; background:#fff; }
  .help h3 { margin:0 0 6px; font-size:14px; }
  .help p { margin:6px 0; }
  .help ol { margin:6px 0 6px 18px; padding:0; }
  .help ol li { margin:6px 0; }
  .help .substep { display:block; color:var(--mute); font-size:12px; margin-top:2px; }
  .help code { background:rgba(20,20,20,.08); padding:1px 4px; font-size:12px; }

  /* Quiet secondary link-style button used under the primary actions. */
  .link { background:none; border:none; padding:4px 0; min-height:0;
    color:var(--mute); font-size:12px; text-decoration:underline;
    text-underline-offset:2px; text-align:left; }
  .link:active { background:none; color:var(--accent); }

  /* Small muted caption under a disabled control. */
  .caption { font-size:12px; color:var(--mute); line-height:1.4; }

  /* ---- Conflict resolution: "which avatar wins?" ----
     The two previews are the buttons. A padded, transparent-bordered frame
     wraps each so the tap area extends past the canvas itself, and hover /
     focus lights that frame in the accent so it's obvious which one a tap
     will pick. The action label always shows (so touch users see it too)
     and just gains the accent on hover. */
  .choice-row { display:flex; gap:12px; flex-wrap:wrap; }
  .choice { display:flex; flex-direction:column; gap:6px; align-items:flex-start;
    padding:8px; background:none; border:2px solid transparent;
    cursor:pointer; text-align:left; min-height:0;
    transition: border-color .12s ease, background .12s ease; }
  .choice:hover, .choice:focus-visible {
    border-color: var(--accent); background: rgba(217,79,43,.08); outline:none; }
  .choice:active { background: rgba(217,79,43,.18); }
  /* The inner preview's own border also goes accent on hover, so the
     highlight reads as one continuous frame rather than a floating box. */
  .choice:hover .prev, .choice:focus-visible .prev { border-color: var(--accent); }
  .choice-action { font-size:11px; text-transform:uppercase;
    letter-spacing:1.5px; color:var(--mute); transition: color .12s ease; }
  .choice:hover .choice-action, .choice:focus-visible .choice-action {
    color: var(--accent); font-weight:bold; }

  /* Brush-size picker under the canvas. */
  .brush-section { margin-top:14px; }
  .brush-row { display:flex; gap:8px; flex-wrap:wrap; }
  .brush { display:flex; align-items:center; gap:8px; min-height:44px;
    padding:6px 10px; background:var(--paper); color:var(--ink);
    border:2px solid var(--ink); cursor:pointer; font:inherit;
    text-align:left; }
  .brush:active:not(:disabled) { background:var(--ink); color:var(--paper); }
  .brush.on { background:var(--ink); color:var(--paper); }
  .brush-swatch { display:inline-flex; align-items:center; justify-content:center;
    width:22px; height:22px; border:1px solid currentColor; flex:0 0 auto; }
  .brush-dot { display:block; background:currentColor; }

  .steps { list-style:none; margin:4px 0 0; padding:0; }
  .steps li { display:flex; align-items:center; gap:10px;
    padding:7px 0; font-size:14px; }
  .steps li:not(:last-child) { border-bottom:1px dashed #ccc; }
  .steps li::before { content:"•"; flex:0 0 auto; color:var(--accent); font-size:20px;
    font-weight:bold; line-height:1; }
  input { font:inherit; font-size:16px; min-height:44px; width:100%; padding:8px;
    border:2px solid var(--ink); background:#fff; color:var(--ink); }
  pre { background:var(--ink); color:#b8e08a; padding:10px; height:130px; overflow:auto;
    font-size:12px; margin:0; white-space:pre-wrap; word-break:break-word; }
  @media (max-width:560px) {
    h1 { font-size:26px; }
    .wrap { padding-top:16px; }
  }
`;

export default function App() {
  const canvasRef = useRef(null);
  const prevRef = useRef(null);
  const [px, setPx] = useState(() => {
    const m = (window.location.hash || "").match(/a=([0-9a-fA-F]+)/);
    return (m && fromHex(m[1])) || blank();
  });
  const [tool, setTool] = useState(1);
  const [mirror, setMirror] = useState(true);
  const [brushSize, setBrushSize] = useState(1);
  const [log, setLog] = useState([
    "Ready. Put the pendant in Pair mode (MID on Avatars), then tap Connect & send.",
  ]);
  const [codeIn, setCodeIn] = useState("");
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState(null); // null | "ble" | "wifi"
  const [deviceName, setDeviceName] = useState("");
  const [conflict, setConflict] = useState(null);
  const [history, setHistory] = useState([]);

  // Cell under the pointer, or null when it's off the canvas.
  const [hover, setHover] = useState(null);

  // ---- Transient on-screen banner (blank canvas, etc.) ----
  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(null);

  // ---- WiFi mode ----
  const [wifiMode, setWifiMode] = useState(false);
  const [showWifiHelp, setShowWifiHelp] = useState(false);
  const useWifi = !btOk || wifiMode;

  // ---- Local-network access (WiFi path only) ----
  const [lnaState, setLnaState] = useState("checking"); // checking | granted | prompt | denied | unsupported
  const [showNetworkHelp, setShowNetworkHelp] = useState(false);

  // ---- Pendant hotspot detection (WiFi path only) ----
  const [wifiDetected, setWifiDetected] = useState(false);

  const clearNotice = () => {
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(null);
  };

  const showNotice = (text) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, 3500);
  };

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    if (!isBlank(px) && noticeTimer.current) clearNotice();
  }, [px]);

  // Query the local-network-access permission on mount, and again whenever
  // the tab regains focus or the user flips into WiFi mode.
  useEffect(() => {
    if (!useWifi) return;
    let cancelled = false;
    let statusRef = null;

    const check = async () => {
      if (!navigator.permissions?.query) {
        if (!cancelled) setLnaState("unsupported");
        return;
      }
      try {
        const status = await navigator.permissions.query({
          name: "local-network-access",
        });
        if (cancelled) return;
        statusRef = status;
        setLnaState(status.state);
        status.onchange = () => {
          if (!cancelled) setLnaState(status.state);
        };
      } catch {
        if (!cancelled) setLnaState("unsupported");
      }
    };

    check();
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
      if (statusRef) statusRef.onchange = null;
    };
  }, [useWifi]);

  // Background poll for the pendant's hotspot.
  useEffect(() => {
    if (transport) return;
    let cancelled = false;
    const tick = async () => {
      try {
        await fetchWithTimeout(wifiUrl("/avatar"), {}, 1200);
        if (!cancelled) setWifiDetected(true);
      } catch {
        if (!cancelled) setWifiDetected(false);
      }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [transport]);

  const requestLocalNetwork = async () => {
    if (lnaState === "denied") {
      setShowNetworkHelp(true);
      addLog("Local network access is blocked in site settings - open the panel for steps.");
      return;
    }
    addLog("Asking the browser for local network access...");
    try {
      await fetchWithTimeout(wifiUrl("/avatar"), {}, 8000);
      addLog("Request sent. If you saw a prompt, choose Allow.");
    } catch {
      addLog("Request didn't complete - if a Block option was shown, re-allow it in site settings.");
    }
  };

  const drawing = useRef(false);
  const last = useRef(null);
  const btDeviceRef = useRef(null);
  const btCharRef = useRef(null);
  const pxRef = useRef(px);
  useEffect(() => { pxRef.current = px; }, [px]);
  const addLog = (m) => setLog((l) => [...l.slice(-60), m]);

  const brushRef = useRef(brushSize);
  useEffect(() => { brushRef.current = brushSize; }, [brushSize]);

  useEffect(() => {
    const c = canvasRef.current.getContext("2d");
    c.fillStyle = "#fff";
    c.fillRect(0, 0, N * CELL, N * CELL);
    c.strokeStyle = "#ddd";
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      c.moveTo(i * CELL, 0); c.lineTo(i * CELL, N * CELL);
      c.moveTo(0, i * CELL); c.lineTo(N * CELL, i * CELL);
    }
    c.stroke();
    const p = prevRef.current.getContext("2d");
    p.fillStyle = "#fff";
    p.fillRect(0, 0, N, N);
    px.forEach((v, i) => {
      if (!v) return;
      const x = i % N, y = (i / N) | 0;
      c.fillStyle = "#141414";
      c.fillRect(x * CELL, y * CELL, CELL, CELL);
      p.fillStyle = "#000";
      p.fillRect(x, y, 1, 1);
    });

    if (hover) {
      const size = brushSize;
      const half = Math.floor((size - 1) / 2);
      c.fillStyle = tool ? GHOST_DRAW : GHOST_ERASE;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const x = hover[0] - half + dx;
          const y = hover[1] - half + dy;
          if (x < 0 || x >= N || y < 0 || y >= N) continue;
          c.fillRect(x * CELL, y * CELL, CELL, CELL);
          if (mirror) c.fillRect((N - 1 - x) * CELL, y * CELL, CELL, CELL);
        }
      }
    }

    if (mirror) {
      c.strokeStyle = "#d94f2b";
      c.beginPath();
      c.moveTo(N * CELL / 2, 0); c.lineTo(N * CELL / 2, N * CELL);
      c.stroke();
    }
  }, [px, mirror, hover, brushSize, tool]);

  const cellAt = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const cl = (v) => Math.max(0, Math.min(N - 1, v));
    return [cl(Math.floor(((e.clientX - r.left) / r.width) * N)),
            cl(Math.floor(((e.clientY - r.top) / r.height) * N))];
  };

  const updateHover = (e) => {
    const [x, y] = cellAt(e);
    setHover((h) => (h && h[0] === x && h[1] === y ? h : [x, y]));
  };

  const snapshot = (current) => {
    setHistory((h) => {
      const next = [...h, current];
      if (next.length > HISTORY_LIMIT) next.shift();
      return next;
    });
  };

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setPx(h[h.length - 1]);
      return h.slice(0, -1);
    });
  };

  const stamp = (n, cx, cy) => {
    const size = brushRef.current;
    const half = Math.floor((size - 1) / 2);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = cx - half + dx;
        const y = cy - half + dy;
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        n[y * N + x] = tool;
        if (mirror) n[y * N + (N - 1 - x)] = tool;
      }
    }
  };

  const paint = (e) => {
    const [x1, y1] = cellAt(e);
    const [x0, y0] = last.current || [x1, y1];
    last.current = [x1, y1];
    setPx((old) => {
      const n = old.slice();
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= steps; i++) {
        const cx = Math.round(x0 + ((x1 - x0) * i) / steps);
        const cy = Math.round(y0 + ((y1 - y0) * i) / steps);
        stamp(n, cx, cy);
      }
      return n;
    });
  };

  const startStroke = (e) => {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateHover(e);
    snapshot(px);
    paint(e);
  };

  const stop = () => { drawing.current = false; last.current = null; };

  const doClear = () => { snapshot(px); setPx(blank()); };
  const doInvert = () => { snapshot(px); setPx(px.map((v) => 1 - v)); };

  const sendFrame = async (ch, pixels) => {
    const data = pack(pixels);
    let sum = 0;
    data.forEach((b) => (sum ^= b));
    const frame = new Uint8Array(131);
    frame.set([0xc0, 0x01]);
    frame.set(data, 2);
    frame[130] = sum;

    const CHUNK = 20;
    for (let i = 0; i < frame.length; i += CHUNK) {
      const slice = frame.slice(i, Math.min(i + CHUNK, frame.length));
      await ch.writeValueWithResponse(slice);
    }
  };

  const connectBT = async () => {
    const tryOnce = async (options, label) => {
      addLog(`Scanning (${label})... pendant must be on the PAIRING screen`);
      const device = await navigator.bluetooth.requestDevice(options);
      addLog("Found: " + (device.name || "(unnamed)"));
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(AVATAR_SERVICE_UUID);
      const ch = await service.getCharacteristic(AVATAR_CHAR_UUID);
      return { device, ch };
    };

    try {
      let r;
      try {
        r = await tryOnce(
          {
            filters: [{ services: [AVATAR_SERVICE_UUID] }],
            optionalServices: [AVATAR_SERVICE_UUID],
          },
          "by service UUID"
        );
      } catch (err) {
        if (err.name !== "NotFoundError") throw err;
        addLog("Nothing matched the UUID filter - trying name prefix...");
        r = await tryOnce(
          {
            filters: [{ namePrefix: "CoolTown" }],
            optionalServices: [AVATAR_SERVICE_UUID],
          },
          "by name prefix"
        );
      }

      const { device, ch } = r;
      btDeviceRef.current = device;
      btCharRef.current = ch;
      device.addEventListener("gattserverdisconnected", () => {
        btCharRef.current = null;
        setConnected(false);
        setTransport(null);
        setDeviceName("");
        addLog("Disconnected.");
      });
      setConnected(true);
      setTransport("ble");
      setDeviceName(device.name || "pendant");
      addLog("Connected via Bluetooth.");

      let loaded = null;
      try {
        const val = await ch.readValue();
        const bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
        loaded = unpackFrame(bytes);
      } catch (err) {
        addLog("Couldn't check for an existing avatar (" + err.message + ") - sending current design.");
      }

      if (resolveAfterConnect(loaded, "ble")) {
        addLog("> sending avatar...");
        await sendFrame(ch, pxRef.current);
        addLog("> sent 131 bytes over BLE");
      }
    } catch (err) {
      if (err.name === "NotFoundError") {
        addLog(
          "No pendant found. Check: (1) pendant shows PAIRING with the blinking square, " +
          "(2) phone Bluetooth is on, (3) Chrome on Android, (4) the site is HTTPS."
        );
      } else {
        addLog("BT connect failed: " + err.message);
      }
    }
  };

  const disconnectBT = async () => {
    try { btDeviceRef.current?.gatt?.disconnect(); } catch {}
    btCharRef.current = null;
    setConnected(false);
    setTransport(null);
    setDeviceName("");
    setConflict(null);
    addLog("Disconnected.");
  };

  const resolveAfterConnect = (loaded, transportName) => {
    const canvasBlank = isBlank(pxRef.current);

    if (loaded && !canvasBlank) {
      setConflict({ avatar: loaded, transport: transportName });
      addLog("Pendant already has an avatar, and you've drawn one too - pick which to keep.");
      return false;
    }
    if (loaded) {
      snapshot(pxRef.current);
      setPx(loaded);
      addLog("Pendant already has an avatar - loaded it here for editing. Make your changes, then tap 'Send again'.");
      return false;
    }
    if (canvasBlank) {
      showNotice("Canvas is blank — draw something first, then send.");
      addLog("Canvas is blank - draw something before sending.");
      return false;
    }
    return true;
  };

  const refreshLnaState = async () => {
    if (!useWifi) return;
    if (!navigator.permissions?.query) return;
    try {
      const s = await navigator.permissions.query({ name: "local-network-access" });
      setLnaState(s.state);
    } catch {}
  };

  const wifiGetAvatar = async () => {
    const r = await fetchWithTimeout(wifiUrl("/avatar"), {}, 1500);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    const [flag, hex] = text.split(":");
    return flag === "1" ? fromHex(hex) : null;
  };

  const wifiSendFrame = async (pixels) => {
    const hex = toHex(pack(pixels));
    const r = await fetchWithTimeout(
      wifiUrl("/avatar"),
      { method: "POST", headers: { "Content-Type": "text/plain" }, body: hex },
      4000
    );
    if (!r.ok) throw new Error((await r.text()) || ("HTTP " + r.status));
  };

  const connectWifi = async () => {
    addLog("Connecting over WiFi...");
    try {
      const loaded = await wifiGetAvatar();
      setConnected(true);
      setTransport("wifi");
      setDeviceName("pendant");
      setShowNetworkHelp(false);
      addLog("Connected via WiFi.");
      if (resolveAfterConnect(loaded, "wifi")) {
        addLog("> sending avatar...");
        await wifiSendFrame(pxRef.current);
        addLog("> sent avatar over WiFi");
      }
    } catch (err) {
      addLog("WiFi connect failed: " + err.message + " - make sure you've joined the pendant's network.");
      if (looksLikeNetworkBlock(err)) {
        setShowNetworkHelp(true);
        refreshLnaState();
      }
    }
  };

  const disconnectWifi = () => {
    setConnected(false);
    setTransport(null);
    setDeviceName("");
    setConflict(null);
    addLog("Disconnected.");
  };

  const canConnect = useWifi ? wifiDetected : true;

  const connectPendant = () => {
    if (!canConnect) {
      addLog("Pendant hotspot not detected - make sure you've joined the CoolTown-XXXX network.");
      return;
    }
    if (!useWifi) return connectBT();
    return connectWifi();
  };

  const send = async () => {
    if (isBlank(px)) {
      showNotice("Canvas is blank — draw something first, then send.");
      addLog("Canvas is blank - draw something before sending.");
      return;
    }
    try {
      if (transport === "ble") {
        const ch = btCharRef.current;
        if (!ch) return;
        await sendFrame(ch, px);
        addLog("> sent 131 bytes over BLE");
      } else if (transport === "wifi") {
        await wifiSendFrame(px);
        addLog("> sent avatar over WiFi");
      }
    } catch (err) {
      addLog("Send failed: " + err.message);
      if (transport === "wifi") {
        if (looksLikeNetworkBlock(err)) {
          setShowNetworkHelp(true);
          refreshLnaState();
        }
        setConnected(false);
        setTransport(null);
        setDeviceName("");
      }
    }
  };

  const disconnect = () => {
    if (transport === "ble") disconnectBT();
    else if (transport === "wifi") disconnectWifi();
  };

  const keepMine = async () => {
    const t = conflict?.transport;
    setConflict(null);
    try {
      addLog("> sending your avatar...");
      if (t === "ble") {
        await sendFrame(btCharRef.current, pxRef.current);
        addLog("> sent 131 bytes over BLE");
      } else {
        await wifiSendFrame(pxRef.current);
        addLog("> sent avatar over WiFi");
      }
    } catch (err) {
      addLog("Send failed: " + err.message);
      if (looksLikeNetworkBlock(err)) {
        setShowNetworkHelp(true);
        refreshLnaState();
      }
    }
  };

  const usePendantAvatar = () => {
    snapshot(pxRef.current);
    setPx(conflict.avatar);
    setConflict(null);
    addLog("Loaded the pendant's avatar for editing. Make your changes, then tap 'Send again'.");
  };

  const code = toHex(pack(px));
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); addLog(`Copied ${what}.`); }
    catch { addLog(`Couldn't copy automatically - long-press and copy the ${what} manually.`); }
  };
  const link = `${window.location.origin}${window.location.pathname}#a=${code}`;
  const loadCode = () => {
    const m = codeIn.match(/a=([0-9a-fA-F]+)/);
    const n = fromHex(m ? m[1] : codeIn);
    if (n) { snapshot(px); setPx(n); setCodeIn(""); addLog("Loaded avatar from code."); }
    else addLog("That code isn't valid (needs 256 hex characters).");
  };

  const enterWifiMode = () => {
    setWifiMode(true);
    setShowWifiHelp(true);
    setShowNetworkHelp(false);
    addLog("Switched to WiFi. Follow the steps above, then tap Connect & send.");
  };
  const exitWifiMode = () => {
    setWifiMode(false);
    setShowWifiHelp(false);
    setShowNetworkHelp(false);
    addLog("Back to Bluetooth mode.");
  };

  return (
    <>
      <style>{css}</style>
      <div className="wrap">
        <h1>CoolTown avatar</h1>
        <p className="sub">Draw a 32×32 avatar, then send it to the pendant.</p>

        <div className="hint" style={{ marginBottom: 16 }}>
          <b>How to send</b>
          <ol className="steps">
            <li>On the pendant: <b>Avatars</b> → <b>MID</b> to start Pairing</li>
            {useWifi && <li>Press <b>UP</b> on the pendant to switch it to WiFi</li>}
            {useWifi && <li>Join WiFi network <b>CoolTown-XXXX</b> on this device</li>}
            <li>Tap <b>Connect &amp; send</b> below</li>
          </ol>
        </div>

        <div className="row">
          <div className="stage">
            <canvas
              ref={canvasRef}
              className="grid"
              width={N * CELL}
              height={N * CELL}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={startStroke}
              onPointerMove={(e) => {
                updateHover(e);
                if (drawing.current) paint(e);
              }}
              onPointerUp={stop}
              onPointerCancel={stop}
              onPointerLeave={() => setHover(null)}
            />
            <div className="brush-section">
              <div className="lbl">Brush size</div>
              <div className="brush-row">
                {BRUSH_SIZES.map((s) => (
                  <button
                    key={s}
                    className={`brush ${brushSize === s ? "on" : ""}`}
                    onClick={() => setBrushSize(s)}
                    aria-pressed={brushSize === s}
                    title={`${s}×${s} pixels`}
                  >
                    <span className="brush-swatch" aria-hidden="true">
                      <span
                        className="brush-dot"
                        style={{ width: s * 2, height: s * 2 }}
                      />
                    </span>
                    {s}×{s}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="side">
            <div className="lbl">Tools</div>
            <div className="tools">
              <button className={tool ? "on" : ""} onClick={() => setTool(1)}>Draw</button>
              <button className={!tool ? "on" : ""} onClick={() => setTool(0)}>Erase</button>
              <button className={mirror ? "on" : ""} onClick={() => setMirror(!mirror)}>
                Mirror: {mirror ? "on" : "off"}
              </button>
              <button onClick={undo} disabled={!history.length}>
                Undo ({history.length})
              </button>
              <button onClick={doInvert}>Invert</button>
              <button onClick={doClear}>Clear</button>
            </div>
            <div className="lbl">Preview</div>
            <canvas ref={prevRef} className="prev" width={N} height={N} />

            <div className="lbl">Pendant</div>

            {notice && (
              <div className="notice" role="status" aria-live="polite">
                {notice}
              </div>
            )}

            {!connected && (
              <>
                <button
                  className="go"
                  onClick={connectPendant}
                  disabled={!canConnect}
                  style={{ opacity: canConnect ? 1 : 0.3 }}
                  title={canConnect ? "" : "Waiting for the pendant's WiFi network"}
                >
                  Connect &amp; send
                </button>
                {useWifi && !wifiDetected && (
                  <div className="caption">
                    Waiting for the pendant's WiFi network. Join{" "}
                    <b>CoolTown-XXXX</b> in your device's WiFi settings.
                  </div>
                )}
              </>
            )}

            {connected && conflict && (
              <div className="hint" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <b>Pendant already has an avatar, and you've drawn one too.</b>
                <div style={{ fontSize: 12, color: "var(--mute)" }}>
                  Tap the one you want to keep.
                </div>
                {/* The two previews are themselves the buttons. Hover (or
                    keyboard focus) lights up an accent frame around whichever
                    one you're about to pick. */}
                <div className="choice-row">
                  <button
                    className="choice"
                    onClick={keepMine}
                    aria-label="Keep my avatar and send it to the pendant"
                  >
                    <div className="lbl" style={{ marginTop: 0 }}>Yours</div>
                    <MiniAvatar pixels={px} />
                    <div className="choice-action">Keep this</div>
                  </button>
                  <button
                    className="choice"
                    onClick={usePendantAvatar}
                    aria-label="Load the pendant's avatar into the editor"
                  >
                    <div className="lbl" style={{ marginTop: 0 }}>Pendant's</div>
                    <MiniAvatar pixels={conflict.avatar} />
                    <div className="choice-action">Use this</div>
                  </button>
                </div>
              </div>
            )}

            {connected && !conflict && (
              <>
                <button className="go" onClick={send}>Send again</button>
                <button onClick={disconnect}>Disconnect</button>
                <div style={{ fontSize: 12, color: "var(--mute)" }}>
                  Connected: {deviceName} ({transport === "ble" ? "Bluetooth" : "WiFi"})
                </div>
              </>
            )}

            {useWifi && (lnaState === "prompt" || lnaState === "denied") && !showNetworkHelp && !connected && (
              <button className="go" onClick={requestLocalNetwork}>
                {lnaState === "denied"
                  ? "Open permission settings"
                  : "Allow local network access"}
              </button>
            )}
            {useWifi && lnaState === "granted" && !showNetworkHelp && !connected && (
              <div className="notice" role="status">
                Local network access allowed.
              </div>
            )}
            {useWifi && showNetworkHelp && (
              <div className="help" role="region" aria-label="Network access help">
                <h3>Allow this site to reach your pendant</h3>
                <p>
                  Your browser is blocking requests to{" "}
                  <code>192.168.4.1</code> — the pendant's pairing hotspot.
                  This usually means the site was set to <b>Block</b> at
                  some point, and the browser won't ask again on its own.
                </p>
                <ol>
                  <li>
                    <b>Chrome desktop:</b>
                    <span className="substep">
                      Settings → Privacy and security → Site settings →
                      Additional permissions → <b>Local network access</b>{" "}
                      → set this site to <b>Allow</b>. Then reload.
                    </span>
                  </li>
                  <li>
                    <b>Chrome Android:</b>
                    <span className="substep">
                      Tap the <b>lock</b> or <b>tune</b> icon in the address
                      bar → <b>Permissions</b> → <b>Local network</b> →{" "}
                      <b>Allow</b>. Then reload.
                    </span>
                  </li>
                </ol>
                <div className="tools" style={{ marginTop: 10 }}>
                  <button onClick={() => window.location.reload()}>
                    Reload page
                  </button>
                  <button onClick={() => setShowNetworkHelp(false)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {useWifi && !showNetworkHelp && (lnaState === "unsupported" || lnaState === "granted") && !connected && (
              <button className="link" onClick={() => setShowNetworkHelp(true)}>
                Trouble connecting?
              </button>
            )}

            {btOk && !useWifi && !connected && (
              <button className="link" onClick={enterWifiMode}>
                Having problems? Try connecting via WiFi
              </button>
            )}
            {btOk && wifiMode && !connected && (
              <button className="link" onClick={exitWifiMode}>
                Back to Bluetooth
              </button>
            )}

            <div className="lbl">Move between devices</div>
            <div className="tools">
              <button onClick={() => copy(link, "link")}>Copy link</button>
              <button onClick={() => copy(code, "code")}>Copy code</button>
            </div>
            <input
              value={codeIn}
              onChange={(e) => setCodeIn(e.target.value)}
              placeholder="Paste a code or link"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button onClick={loadCode} disabled={!codeIn}>Load</button>
          </div>
        </div>

        <div className="lbl" style={{ margin: "20px 0 6px" }}>Log</div>
        <pre>{log.join("\n")}</pre>
      </div>
    </>
  );
}