// 轻量 OSM 瓦片地图：Web Mercator、当前位置/目的地、直线指引、区域缓存和当前视图下载。
// 只用于实验导航；不是离线路网，不能做转弯级路线规划。
import { haversine, bearing, formatDistance } from './geo.js';

const TILE = 256;
const OSM_URL = 'https://tile.openstreetmap.org';
const DB_NAME = 'guidao-nav-tiles';
const STORE = 'tiles';

const lonToWorldX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToWorldY = (lat, z) => {
  const p = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * TILE * 2 ** z;
};
const worldXToLon = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
const worldYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

class TileStore {
  constructor() {
    this.db = null;
    this.memory = new Map();
    this.ready = this._open();
  }
  _open() {
    if (!('indexedDB' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => resolve();
    });
  }
  async get(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    await this.ready;
    if (!this.db) return null;
    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const blob = req.result;
        if (blob) this.memory.set(key, blob);
        resolve(blob || null);
      };
      req.onerror = () => resolve(null);
    });
  }
  async put(key, blob) {
    this.memory.set(key, blob);
    await this.ready;
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}

export class TileMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.zoom = opts.zoom ?? 16;
    this.onDestination = opts.onDestination || null;
    this.onStatus = opts.onStatus || null;
    this.position = null;
    this.destination = null;
    this.heading = null;
    this.tiles = new Map();
    this.failed = new Set();
    this.store = new TileStore();
    this.dpr = 1;
    this._resize();
    canvas.addEventListener('click', (e) => this._click(e));
    this.draw();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 320));
    const h = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 200));
    if (this.canvas.width !== w * this.dpr || this.canvas.height !== h * this.dpr) {
      this.canvas.width = w * this.dpr;
      this.canvas.height = h * this.dpr;
    }
    this.w = w;
    this.h = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setPosition(lat, lon) {
    this.position = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    this.draw();
  }

  setDestination(lat, lon) {
    this.destination = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    this.draw();
  }

  setHeading(deg) {
    this.heading = Number.isFinite(deg) ? deg : null;
    this.draw();
  }

  _tileUrl(z, x, y) {
    return `${OSM_URL}/${z}/${x}/${y}.png`;
  }

  _drawTile(img, z, x, y, originX, originY) {
    const px = x * TILE - originX;
    const py = y * TILE - originY;
    this.ctx.drawImage(img, px, py, TILE, TILE);
  }

  _loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.tiles.has(key) || this.failed.has(key)) return;
    this.tiles.set(key, null);
    this.store.get(key).then((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          this.tiles.set(key, img);
          URL.revokeObjectURL(url);
          this.draw();
        };
        img.onerror = () => {
          this.failed.add(key);
          this.tiles.delete(key);
          URL.revokeObjectURL(url);
        };
        img.src = url;
        return;
      }
      // 先 fetch 成 blob 再转 object URL：只发一次请求，画布也不会被跨域瓦片污染，
      // 这样“下载当前地图”才能导出 PNG。
      fetch(this._tileUrl(z, x, y), { mode: 'cors' })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.blob();
        })
        .then((blob) => {
          this.store.put(key, blob);
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            this.tiles.set(key, img);
            URL.revokeObjectURL(url);
            this.draw();
          };
          img.onerror = () => {
            this.failed.add(key);
            this.tiles.delete(key);
            URL.revokeObjectURL(url);
          };
          img.src = url;
        })
        .catch(() => {
          this.failed.add(key);
          this.tiles.delete(key);
        });
    });
  }

  draw() {
    this._resize();
    const ctx = this.ctx;
    ctx.fillStyle = '#e8eef2';
    ctx.fillRect(0, 0, this.w, this.h);
    const center = this.position || this.destination;
    if (!center) {
      ctx.fillStyle = '#456';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('点击“定位”后显示地图', 12, 24);
      this._drawAttribution();
      return;
    }
    const z = this.zoom;
    const cx = lonToWorldX(center.lon, z);
    const cy = latToWorldY(center.lat, z);
    const originX = cx - this.w / 2;
    const originY = cy - this.h / 2;
    const minX = Math.floor(originX / TILE);
    const minY = Math.floor(originY / TILE);
    const maxX = Math.floor((originX + this.w) / TILE);
    const maxY = Math.floor((originY + this.h) / TILE);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const key = `${z}/${x}/${y}`;
        const img = this.tiles.get(key);
        if (img) this._drawTile(img, z, x, y, originX, originY);
        else {
          this._loadTile(z, x, y);
          ctx.fillStyle = '#dfe7ec';
          ctx.fillRect(x * TILE - originX, y * TILE - originY, TILE, TILE);
        }
      }
    }
    const toScreen = (lat, lon) => ({
      x: lonToWorldX(lon, z) - originX,
      y: latToWorldY(lat, z) - originY,
    });
    if (this.position && this.destination) {
      const a = toScreen(this.position.lat, this.position.lon);
      const b = toScreen(this.destination.lat, this.destination.lon);
      ctx.strokeStyle = '#1f6feb';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.destination) {
      const d = toScreen(this.destination.lat, this.destination.lon);
      ctx.fillStyle = '#d93025';
      ctx.beginPath();
      ctx.arc(d.x, d.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.position) {
      const p = toScreen(this.position.lat, this.position.lon);
      ctx.fillStyle = '#1f6feb';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (this.heading !== null) {
        const rad = ((this.heading - 90) * Math.PI) / 180;
        ctx.strokeStyle = '#1f6feb';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.cos(rad) * 18, p.y + Math.sin(rad) * 18);
        ctx.stroke();
      }
    }
    if (this.position && this.destination) {
      const dist = haversine(this.position, this.destination);
      const brg = bearing(this.position, this.destination);
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(6, 6, 190, 22);
      ctx.fillStyle = '#123';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(`直线 ${formatDistance(dist)} · 方位 ${Math.round(brg)}°`, 10, 21);
    }
    this._drawAttribution();
  }

  _drawAttribution() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(this.w - 150, this.h - 18, 150, 18);
    ctx.fillStyle = '#345';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('© OpenStreetMap contributors', this.w - 146, this.h - 6);
  }

  _click(e) {
    if (!this.position && !this.destination) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const z = this.zoom;
    const center = this.position || this.destination;
    const originX = lonToWorldX(center.lon, z) - this.w / 2;
    const originY = latToWorldY(center.lat, z) - this.h / 2;
    const lat = worldYToLat(originY + py, z);
    const lon = worldXToLon(originX + px, z);
    if (this.onDestination) this.onDestination(lat, lon);
  }

  /** 缓存当前位置周围 (2r+1)^2 个瓦片，供短时离线查看。 */
  async cacheArea(radius = 1) {
    const center = this.position || this.destination;
    if (!center) return { ok: false, reason: 'no-position' };
    const z = this.zoom;
    const cx = Math.floor(lonToWorldX(center.lon, z) / TILE);
    const cy = Math.floor(latToWorldY(center.lat, z) / TILE);
    let saved = 0;
    let failed = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        const key = `${z}/${x}/${y}`;
        if (await this.store.get(key)) {
          saved++;
          continue;
        }
        try {
          const r = await fetch(this._tileUrl(z, x, y));
          if (!r.ok) throw new Error(String(r.status));
          const blob = await r.blob();
          await this.store.put(key, blob);
          saved++;
        } catch {
          failed++;
        }
      }
    }
    return { ok: true, saved, failed, tiles: (radius * 2 + 1) ** 2 };
  }

  /** 下载当前视图为 PNG；瓦片跨域失败时会抛错。 */
  async downloadPng(name = 'guidao-map.png') {
    const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('地图导出失败');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

export { lonToWorldX, latToWorldY, worldXToLon, worldYToLat };
