import React, { useRef, useState, useEffect } from "react";

const N = 32;
const CELL = 16;
const blank = () => new Array(N * N).fill(0);
const HISTORY_LIMIT = 30;

// Must match the firmware UUIDs
const AVATAR_SERVICE_UUID = "c0017000-1234-5678-9abc-def012345678";
const AVATAR_CHAR_UUID    = "c0017001-1234-5678-9abc-def012345678";

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
// Returns a pixel array if the pendant already has an avatar set, else null.
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
  .note { border:2px dashed var(--accent); padding:10px; font-size:13px; line-height:1.4; }
  .hint { border:2px solid var(--ink); padding:10px; font-size:13px; line-height:1.4;
    background:#fff; }
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
  const [log, setLog] = useState([
    "Ready. Put the pendant in Pair mode (MID on Avatars), then tap Connect Bluetooth.",
  ]);
  const [codeIn, setCodeIn] = useState("");
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [history, setHistory] = useState([]);   // stack of past px states

  const drawing = useRef(false);
  const last = useRef(null);
  const btDeviceRef = useRef(null);
  const btCharRef = useRef(null);
  const addLog = (m) => setLog((l) => [...l.slice(-60), m]);

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
    if (mirror) {
      c.strokeStyle = "#d94f2b";
      c.beginPath();
      c.moveTo(N * CELL / 2, 0); c.lineTo(N * CELL / 2, N * CELL);
      c.stroke();
    }
  }, [px, mirror]);

  const cellAt = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const cl = (v) => Math.max(0, Math.min(N - 1, v));
    return [cl(Math.floor(((e.clientX - r.left) / r.width) * N)),
            cl(Math.floor(((e.clientY - r.top) / r.height) * N))];
  };

  // ---- Undo helpers ----
  // Snapshot the current pixel array onto the history stack. Call this
  // immediately BEFORE any mutating action (start of stroke, clear, etc).
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

  const paint = (e) => {
    const [x1, y1] = cellAt(e);
    const [x0, y0] = last.current || [x1, y1];
    last.current = [x1, y1];
    setPx((old) => {
      const n = old.slice();
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= steps; i++) {
        const x = Math.round(x0 + ((x1 - x0) * i) / steps);
        const y = Math.round(y0 + ((y1 - y0) * i) / steps);
        n[y * N + x] = tool;
        if (mirror) n[y * N + (N - 1 - x)] = tool;
      }
      return n;
    });
  };

  const startStroke = (e) => {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshot(px);           // one snapshot per stroke
    paint(e);
  };

  const stop = () => { drawing.current = false; last.current = null; };

  const doClear = () => { snapshot(px); setPx(blank()); };
  const doInvert = () => { snapshot(px); setPx(px.map((v) => 1 - v)); };

  // ---- BLE ----
  const sendFrame = async (ch, pixels) => {
    const data = pack(pixels);
    let sum = 0;
    data.forEach((b) => (sum ^= b));
    const frame = new Uint8Array(131);
    frame.set([0xc0, 0x01]);
    frame.set(data, 2);
    frame[130] = sum;

    // Default ATT MTU is 23 -> 20 byte writes are universally safe.
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
        setDeviceName("");
        addLog("Disconnected.");
      });
      setConnected(true);
      setDeviceName(device.name || "pendant");
      addLog("Connected via Bluetooth.");

      // Check whether the pendant already has an avatar before doing anything
      // to it: if it does, load it onto the canvas so the user can edit their
      // existing design instead of silently overwriting it.
      let loaded = null;
      try {
        const val = await ch.readValue();
        const bytes = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
        loaded = unpackFrame(bytes);
      } catch (err) {
        addLog("Couldn't check for an existing avatar (" + err.message + ") - sending current design.");
      }

      if (loaded) {
        snapshot(px);
        setPx(loaded);
        addLog("Pendant already has an avatar - loaded it here for editing. Make your changes, then tap 'Send again'.");
      } else {
        // Nothing on the pendant yet (or we couldn't read it) - send what's on screen.
        addLog("> sending avatar...");
        await sendFrame(ch, px);
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
    setDeviceName("");
    addLog("Disconnected.");
  };

  // Used by the "Send to pendant" button (for re-sends after editing)
  const send = async () => {
    const ch = btCharRef.current;
    if (!ch) return;
    try {
      await sendFrame(ch, px);
      addLog("> sent 131 bytes over BLE");
    } catch (err) {
      addLog("Send failed: " + err.message);
    }
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

  return (
    <>
      <style>{css}</style>
      <div className="wrap">
        <h1>CoolTown avatar</h1>
        <p className="sub">Draw a 32×32 avatar, then send it to the pendant.</p>

        <div className="hint" style={{ marginBottom: 16 }}>
          <b>How to send:</b> on the pendant, go to <b>Avatars</b> and press{" "}
          <b>MID</b> so the display shows <b>PAIRING…</b> with a blinking square.
          {btOk ? (
            <> Then tap <b>Connect &amp; send</b> below. If the pendant doesn't
            have an avatar yet, whatever's on screen here is sent automatically.
            If it already has one, that avatar is loaded here first so you can
            edit it instead of overwriting it - tap "Send again" when you're ready.</>
          ) : (
            <> This browser can't do direct Bluetooth, but the pendant also runs
            its own WiFi hotspot while pairing - see below.</>
          )}
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
              onPointerMove={(e) => drawing.current && paint(e)}
              onPointerUp={stop}
              onPointerCancel={stop}
            />
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
            {!btOk && (
              <div className="note">
                No Web Bluetooth here (expected on iPhone/Safari, Firefox, etc) -
                no problem, no app needed. Put the pendant in <b>Pairing</b> mode,
                then on this device go to <b>WiFi settings</b> and join the
                network named <b>CoolTown-XXXX</b> (shown on the pendant's
                screen, no password). Then open{" "}
                <b>http://192.168.4.1</b> in your browser - the pendant serves
                its own draw-and-send page there.
              </div>
            )}
            {btOk && (!connected
              ? (
                <button className="go" onClick={connectBT}>
                  Connect &amp; send
                </button>
              )
              : (
                <>
                  <button className="go" onClick={send}>Send again</button>
                  <button onClick={disconnectBT}>Disconnect</button>
                  <div style={{ fontSize: 12, color: "var(--mute)" }}>
                    Connected: {deviceName}
                  </div>
                </>
              ))}

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