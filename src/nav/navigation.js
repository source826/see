// GPS 目的地导航：只做“直线方向 + 距离 + 到达”提示，不做转弯级路网规划。
// 语音优先级由外部 canSpeak 控制；路面危险语音应压住导航语音。
import { haversine, bearing, guidanceText, isArrived, formatDistance } from './geo.js';

const ARRIVE_M = 8;
const REPEAT_MS = 8000;
const BUCKETS = [200, 100, 50, 20, 10, 5];

export class NavigationController {
  constructor(opts = {}) {
    this.onStatus = opts.onStatus || (() => {});
    this.onPosition = opts.onPosition || (() => {});
    this.onHeading = opts.onHeading || (() => {});
    this.canSpeak = opts.canSpeak || (() => true);
    this.speak = opts.speak || (() => {});
    this.destination = null;
    this.destinationLabel = opts.destinationLabel || '目的地';
    this.position = null;
    this.heading = null;
    this.watchId = null;
    this.orientationStarted = false;
    this.lastSpeakAt = 0;
    this.lastBucket = null;
    this.arrivedAnnounced = false;
    this.started = false;
    this.lastError = null;
  }

  setDestination(lat, lon, label = '目的地') {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this.destination = null;
      this._emit('未设置目的地。');
      return false;
    }
    this.destination = { lat, lon };
    this.destinationLabel = label || '目的地';
    this.arrivedAnnounced = false;
    this.lastBucket = null;
    this._emit(this._text());
    if (this.started) this._announce(true);
    return true;
  }

  locateOnce() {
    if (!('geolocation' in navigator)) {
      this._emit('浏览器不支持定位。');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => this._onPosition(pos),
      (err) => this._onError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  start() {
    if (!this.destination) {
      this._emit('请先设置目的地。');
      return false;
    }
    if (!('geolocation' in navigator)) {
      this._emit('浏览器不支持定位。');
      return false;
    }
    this.started = true;
    this.arrivedAnnounced = false;
    this.lastBucket = null;
    this._startOrientation();
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(pos),
      (err) => this._onError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
    this._emit(this._text() || '正在定位…');
    return true;
  }

  stop() {
    this.started = false;
    if (this.watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
    this._emit('导航已停止。');
  }

  query() {
    this._announce(true);
    this._emit(this._text());
  }

  cancelSpeech() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  handleCommand(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s) return false;
    if (/停止|结束|退出/.test(s)) {
      this.stop();
      return true;
    }
    if (/开始|导航|带我去|出发/.test(s)) {
      return this.start();
    }
    if (/多远|距离|还有|前方|是不是|到了吗|目的地/.test(s)) {
      this.query();
      return true;
    }
    return false;
  }

  _text() {
    if (!this.position) return this.destination ? '正在定位…' : '未设置目的地。';
    if (!this.destination) return '未设置目的地。';
    const distance = haversine(this.position, this.destination);
    const brg = bearing(this.position, this.destination);
    return guidanceText({
      distance,
      bearing: brg,
      heading: this.heading,
      destinationLabel: this.destinationLabel,
      arrivedThreshold: ARRIVE_M,
    });
  }

  _emit(text, extra = {}) {
    this.onStatus({
      text,
      position: this.position,
      destination: this.destination,
      heading: this.heading,
      started: this.started,
      error: this.lastError,
      ...extra,
    });
  }

  _onPosition(pos) {
    const c = pos.coords;
    this.position = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy };
    if (Number.isFinite(c.heading) && c.heading !== null && c.speed > 0.5) {
      this.heading = c.heading;
    }
    this.lastError = null;
    this.onPosition(this.position);
    if (this.destination) {
      const distance = haversine(this.position, this.destination);
      const brg = bearing(this.position, this.destination);
      const text = guidanceText({
        distance,
        bearing: brg,
        heading: this.heading,
        destinationLabel: this.destinationLabel,
        arrivedThreshold: ARRIVE_M,
      });
      this._emit(text, { distance, bearing: brg });
      if (isArrived(distance, ARRIVE_M)) {
        if (!this.arrivedAnnounced) {
          this.arrivedAnnounced = true;
          if (this.canSpeak()) this.speak(`已到达${this.destinationLabel}附近。`, { urgent: true });
        }
        return;
      }
      const bucket = BUCKETS.find((b) => distance <= b);
      const crossed = bucket !== undefined && bucket !== this.lastBucket;
      this.lastBucket = bucket;
      const now = performance.now();
      if (crossed || now - this.lastSpeakAt > REPEAT_MS) {
        this._announce(false);
      }
    } else {
      this._emit('未设置目的地。');
    }
  }

  _announce(force) {
    if (!this.destination || !this.position) return;
    // 路面危险语音优先：任何导航语音都必须让 canSpeak 通过。
    if (!this.canSpeak()) return;
    const distance = haversine(this.position, this.destination);
    const brg = bearing(this.position, this.destination);
    const text = guidanceText({
      distance,
      bearing: brg,
      heading: this.heading,
      destinationLabel: this.destinationLabel,
      arrivedThreshold: ARRIVE_M,
    });
    this.speak(text, { urgent: false });
    this.lastSpeakAt = performance.now();
  }

  _onError(err) {
    this.lastError = err && err.code ? err.code : -1;
    const msg =
      this.lastError === 1
        ? '定位权限被拒绝，请在浏览器里允许定位。'
        : this.lastError === 2
          ? '暂时无法获取位置，请到开阔处再试。'
          : '定位超时，请重试。';
    this._emit(msg, { error: this.lastError });
  }

  _startOrientation() {
    if (this.orientationStarted || !('DeviceOrientationEvent' in window)) return;
    this.orientationStarted = true;
    const handler = (e) => {
      let h = null;
      if (Number.isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if (Number.isFinite(e.alpha)) h = (360 - e.alpha) % 360;
      if (h !== null) {
        this.heading = h;
        this.onHeading(h);
        if (this.started) this._emit(this._text());
      }
    };
    window.addEventListener('deviceorientationabsolute', handler, true);
    window.addEventListener('deviceorientation', handler, true);
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
  }
}
