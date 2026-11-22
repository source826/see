// 灰度图、模糊、下采样与双线性采样。全部手写。
// 像素值范围 0..255，使用 Float32Array 保存。

export class GrayImage {
  constructor(w, h, data) {
    this.w = w;
    this.h = h;
    this.data = data;
    this._gx = null;
    this._gy = null;
  }

  static fromRGBA(rgba, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return new GrayImage(w, h, out);
  }

  gradients() {
    if (!this._gx) {
      const g = computeGradients(this);
      this._gx = g.gx;
      this._gy = g.gy;
    }
    return { gx: this._gx, gy: this._gy };
  }
}

function clampi(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 5 阶二项式高斯核 [1,4,6,4,1]/16 的可分离卷积。 */
export function blur5(img) {
  const { w, h, data } = img;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = clampi(x - 2, 0, w - 1);
      const xm1 = clampi(x - 1, 0, w - 1);
      const xp1 = clampi(x + 1, 0, w - 1);
      const xp2 = clampi(x + 2, 0, w - 1);
      tmp[row + x] =
        (data[row + xm2] + 4 * data[row + xm1] + 6 * data[row + x] + 4 * data[row + xp1] + data[row + xp2]) / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = clampi(y - 2, 0, h - 1) * w;
    const ym1 = clampi(y - 1, 0, h - 1) * w;
    const yp1 = clampi(y + 1, 0, h - 1) * w;
    const yp2 = clampi(y + 2, 0, h - 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      out[row + x] =
        (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[row + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 16;
    }
  }
  return new GrayImage(w, h, out);
}

export function downsample2(img) {
  const w = img.w >> 1;
  const h = img.h >> 1;
  const out = new Float32Array(w * h);
  const src = img.data;
  const sw = img.w;
  for (let y = 0; y < h; y++) {
    const r0 = (y * 2) * sw;
    const r1 = r0 + sw;
    const orow = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x * 2;
      out[orow + x] = (src[r0 + x0] + src[r0 + x0 + 1] + src[r1 + x0] + src[r1 + x0 + 1]) * 0.25;
    }
  }
  return new GrayImage(w, h, out);
}

/** 双线性采样；越界返回 -1。 */
export function sampleBilinear(img, x, y) {
  const { w, h, data } = img;
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return -1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * w;
  const r1 = y1 * w;
  const v00 = data[r0 + x0];
  const v10 = data[r0 + x1];
  const v01 = data[r1 + x0];
  const v11 = data[r1 + x1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

export function computeGradients(img) {
  const { w, h, data } = img;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      gx[i] = (data[i + 1] - data[i - 1]) * 0.5;
      gy[i] = (data[i + w] - data[i - w]) * 0.5;
    }
  }
  return { gx, gy };
}
