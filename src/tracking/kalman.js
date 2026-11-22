// 6 状态（位置/速度/加速度）卡尔曼滤波，手写矩阵运算。
import { clamp } from '../math/matrix.js';

const F = new Float64Array([
  1, 0, 1, 0, 0.5, 0,
  0, 1, 0, 1, 0, 0.5,
  0, 0, 1, 0, 1, 0,
  0, 0, 0, 1, 0, 1,
  0, 0, 0, 0, 1, 0,
  0, 0, 0, 0, 0, 1,
]);

const Q = new Float64Array([
  0.25, 0, 0.5, 0, 0, 0,
  0, 0.25, 0, 0.5, 0, 0,
  0.5, 0, 1, 0, 0, 0,
  0, 0.5, 0, 1, 0, 0,
  0, 0, 0, 0, 0.01, 0,
  0, 0, 0, 0, 0, 0.01,
]);

function mul6(A, B) {
  const C = new Float64Array(36);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += A[r * 6 + k] * B[k * 6 + c];
      C[r * 6 + c] = s;
    }
  }
  return C;
}

function transpose6(A) {
  const T = new Float64Array(36);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) T[c * 6 + r] = A[r * 6 + c];
  return T;
}

export class KalmanCV {
  constructor(x, y, opts = {}) {
    this.x = new Float64Array([x, y, 0, 0, 0, 0]);
    this.P = new Float64Array(36);
    const pv = opts.posVar ?? 9;
    const vv = opts.velVar ?? 6;
    const av = opts.accVar ?? 0.25;
    this.P[0] = this.P[7] = pv;
    this.P[14] = this.P[21] = vv;
    this.P[28] = this.P[35] = av;
    this.q = opts.q ?? 0.7;
    this.maxAcc = opts.maxAcc ?? 1.5;
    this.maxVel = opts.maxVel ?? 40;
  }

  predict(egoDx = 0, egoDy = 0) {
    const s = this.x;
    const nvx = clamp(s[2] + s[4], -this.maxVel, this.maxVel);
    const nvy = clamp(s[3] + s[5], -this.maxVel, this.maxVel);
    const ax = clamp(s[4], -this.maxAcc, this.maxAcc);
    const ay = clamp(s[5], -this.maxAcc, this.maxAcc);
    const nx = s[0] + nvx + 0.5 * ax + egoDx;
    const ny = s[1] + nvy + 0.5 * ay + egoDy;
    s[0] = nx;
    s[1] = ny;
    s[2] = nvx;
    s[3] = nvy;
    s[4] = ax;
    s[5] = ay;

    const FP = mul6(F, this.P);
    const FPFt = mul6(FP, transpose6(F));
    for (let i = 0; i < 36; i++) this.P[i] = FPFt[i] + Q[i] * this.q;
  }

  update(zx, zy, sigma) {
    const P = this.P;
    const r = Math.max(1, sigma * sigma);
    const S00 = P[0] + r;
    const S01 = P[1];
    const S10 = P[6];
    const S11 = P[7] + r;
    const det = S00 * S11 - S01 * S10;
    if (Math.abs(det) < 1e-9) return;

    const i00 = S11 / det;
    const i01 = -S01 / det;
    const i10 = -S10 / det;
    const i11 = S00 / det;

    // K = P * H^T * S^-1, H 只取前两维
    const K = new Float64Array(12);
    for (let i = 0; i < 6; i++) {
      const p0 = P[i * 6];
      const p1 = P[i * 6 + 1];
      K[i * 2] = p0 * i00 + p1 * i10;
      K[i * 2 + 1] = p0 * i01 + p1 * i11;
    }
    const ix = zx - this.x[0];
    const iy = zy - this.x[1];
    for (let i = 0; i < 6; i++) this.x[i] += K[i * 2] * ix + K[i * 2 + 1] * iy;

    // P = (I - K H) P
    const HP0 = [P[0], P[1], P[2], P[3], P[4], P[5]];
    const HP1 = [P[6], P[7], P[8], P[9], P[10], P[11]];
    for (let i = 0; i < 6; i++) {
      const k0 = K[i * 2];
      const k1 = K[i * 2 + 1];
      for (let j = 0; j < 6; j++) {
        P[i * 6 + j] -= k0 * HP0[j] + k1 * HP1[j];
      }
    }
  }

  get position() {
    return { x: this.x[0], y: this.x[1] };
  }

  get velocity() {
    return { x: this.x[2], y: this.x[3] };
  }
}
