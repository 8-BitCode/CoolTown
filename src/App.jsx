import React, { useRef, useState, useEffect } from "react";

const N = 32;
const CELL = 16;
const blank = () => new Array(N * N).fill(0);

// Pack pixels into the firmware's format: row-major, 4 bytes/row, MSB = leftmost pixel
function pack(px) {
  const out = new Uint8Array(128);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (px[y * N + x]) out[y * 4 + (x >> 3)] |= 1 << (7 - (x & 7));
  return out;
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

const serialOk = typeof navigator !== "undefined" && "serial" in navigator;

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
  const [tool, setTool] = useState(1); // 1 = draw, 0 = erase
  const [mirror, setMirror] = useState(true);
  const [log, setLog] = useState(["Ready. Close Arduino Serial Monitor first."]);
  const [codeIn, setCodeIn] = useState("");
  const portRef = useRef(null);
  const writerRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const drawing = useRef(false);
  const last = useRef(null);
  const addLog = (m) => setLog((l) => [...l.slice(-60), m]);

  // Render main grid + small e-ink preview
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

  // Paint from the last touched cell to this one so fast swipes leave no gaps
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

  const stop = () => { drawing.current = false; last.current = null; };

  const connect = async () => {
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      // Stop DTR/RTS from holding the ESP32 in reset
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      setConnected(true);
      addLog("Connected.");
      readLoop(port);
    } catch (err) {
      addLog("Connect failed: " + err.message);
      if (err.name === "NotFoundError")
        addLog("If the device list was empty, this browser can't see the pendant's USB chip (common on phones). Use a laptop with Chrome/Edge: tap Copy link and open it there.");
    }
  };

  const readLoop = async (port) => {
    const dec = new TextDecoder();
    let buf = "";
    const reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        const lines = buf.split("\n");
        buf = lines.pop();
        lines.forEach((l) => l.trim() && addLog("< " + l.trim()));
      }
    } catch {} finally { reader.releaseLock(); }
  };

  const disconnect = async () => {
    try {
      writerRef.current?.releaseLock();
      await portRef.current?.close();
    } catch {}
    setConnected(false);
    addLog("Disconnected.");
  };

  const send = async () => {
    const data = pack(px);
    let sum = 0;
    data.forEach((b) => (sum ^= b));
    const frame = new Uint8Array(131);
    frame.set([0xc0, 0x01]);
    frame.set(data, 2);
    frame[130] = sum;
    try {
      await writerRef.current.write(frame);
      addLog("> sent 131 bytes");
    } catch (err) { addLog("Send failed: " + err.message); }
  };

  // Save / load so a phone drawing can be finished off on a laptop
  const code = toHex(pack(px));
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); addLog(`Copied ${what}.`); }
    catch { addLog(`Couldn't copy automatically - long-press and copy the ${what} manually.`); }
  };
  const link = `${window.location.origin}${window.location.pathname}#a=${code}`;
  const loadCode = () => {
    const m = codeIn.match(/a=([0-9a-fA-F]+)/);
    const n = fromHex(m ? m[1] : codeIn);
    if (n) { setPx(n); setCodeIn(""); addLog("Loaded avatar from code."); }
    else addLog("That code isn't valid (needs 256 hex characters).");
  };

  return (
    <>
      <style>{css}</style>
      <div className="wrap">
        <h1>CoolTown avatar</h1>
        <p className="sub">Draw a 32×32 avatar, then send it to the pendant over USB-C.</p>
        <div className="row">
          <div className="stage">
            <canvas
              ref={canvasRef}
              className="grid"
              width={N * CELL}
              height={N * CELL}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); paint(e); }}
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
              <button onClick={() => setPx(px.map((v) => 1 - v))}>Invert</button>
              <button onClick={() => setPx(blank())}>Clear</button>
            </div>
            <div className="lbl">Preview</div>
            <canvas ref={prevRef} className="prev" width={N} height={N} />

            <div className="lbl">Pendant</div>
            {!serialOk && (
              <div className="note">
                This browser doesn't support USB serial (iPhones/iPads and most
                phone browsers don't). Draw here, tap <b>Copy link</b>, then open
                it on a laptop with Chrome or Edge to send it.
              </div>
            )}
            {!connected
              ? <button className="go" onClick={connect} disabled={!serialOk}>Connect USB</button>
              : <>
                  <button className="go" onClick={send}>Send to pendant</button>
                  <button onClick={disconnect}>Disconnect</button>
                </>}

            <div className="lbl">Move between devices</div>
            <div className="tools">
              <button onClick={() => copy(link, "link")}>Copy link</button>
              <button onClick={() => copy(code, "code")}>Copy code</button>
            </div>
            <input value={codeIn} onChange={(e) => setCodeIn(e.target.value)}
              placeholder="Paste a code or link" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button onClick={loadCode} disabled={!codeIn}>Load</button>
          </div>
        </div>
        <div className="lbl" style={{ margin: "20px 0 6px" }}>Serial log</div>
        <pre>{log.join("\n")}</pre>
      </div>
    </>
  );
}