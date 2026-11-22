// 实时页整段播放：用真实实时路径跑完一段视频，收集实际播出的报警（含 track id）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i > 0 ? [a.slice(2, i), a.slice(i + 1)] : [a.slice(2), 'true'];
  }),
);
const port = Number(args.port || 9400);
const profile = `D:/guidao/tmp/edge-live-${port}`;
const out = args.out || 'D:/guidao/tmp/live_fa.json';
const videoUrl = args.videoUrl;
if (!videoUrl) {
  console.error('用法: node tmp/live_fa.mjs --videoUrl=assets/... [--port=9400] [--out=...]');
  process.exit(1);
}
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
const proc = spawn(edge, [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--window-size=1400,1000',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, tries = 80, delay = 250) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(delay);
  }
  throw new Error(`等待失败: ${url}`);
}
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
  }
  open() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error(`WebSocket: ${e.message || e.type}`));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const list = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = list.find((t) => t.type === 'page');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const ev = async (expression, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await ev(expression)) return;
      await sleep(300);
    }
    throw new Error(`超时: ${label}`);
  };

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:8080/index.html?video=${encodeURIComponent(videoUrl)}&yolo=1&debug=1` });
  await waitFor("document.readyState==='complete' && !!document.getElementById('video')", 20000, '实时页加载');
  await waitFor("document.getElementById('enginePill').textContent.includes('YOLOv8n')", 60000, 'YOLO 就绪');
  await waitFor("Number.isFinite(document.getElementById('video').duration) && document.getElementById('video').duration > 5", 30000, '视频元数据');

  const duration = await ev("document.getElementById('video').duration");
  await ev(`(() => {
    const v = document.getElementById('video');
    v.loop = false;
    v.currentTime = 0;
    v.play();
    return true;
  })()`);
  await waitFor("document.getElementById('video').ended || document.getElementById('video').currentTime >= document.getElementById('video').duration - 0.15", Math.ceil(duration * 1000) + 30000, '播放结束');
  await sleep(1500);
  const alerts = await ev('window.__guidaoAlerts || []');
  const frames = await ev('window.__guidaoFrames || []');
  const analysis = await ev('window.__guidaoAnalysis || null');
  const status = await ev("document.getElementById('enginePill').textContent");
  mkdirSync(out.replace(/[^/]+$/, ''), { recursive: true });
  writeFileSync(out, JSON.stringify({ videoUrl, duration, status, analysis, alerts, frames }, null, 2), 'utf8');
  console.log(JSON.stringify({
    videoUrl,
    duration,
    status,
    totalAlerts: alerts.length,
    targetAlerts: alerts.filter((a) => a.trackId >= 0).length,
    trackIds: [...new Set(alerts.filter((a) => a.trackId >= 0).map((a) => a.trackId))],
    env: alerts.filter((a) => a.trackId < 0).reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {}),
  }));
  cdp.close();
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
}
main().catch((e) => {
  console.error('失败:', e.message);
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  process.exitCode = 1;
});
