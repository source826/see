// 3x3 矩阵与单应矩阵手写实现。不依赖任何第三方库。
// 约定：矩阵按行优先存放，长度为 9 的 Float64Array / 普通数组均可。

export function solveLinear(A, b, n) {
  // 高斯消元 + 部分主元；A 为 n*n 行优先，b 长度 n
  const W = n + 1;
  const M = new Float64Array(n * W);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < n; c++) M[i * W + c] = A[i * n + c];
    M[i * W + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col * W + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * W + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) return null;
    if (piv !== col) {
      for (let c = col; c <= n; c++) {
        const t = M[col * W + c];
        M[col * W + c] = M[piv * W + c];
        M[piv * W + c] = t;
      }
    }
    const p = M[col * W + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * W + col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r * W + c] -= f * M[col * W + c];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * W + n];
    for (let c = i + 1; c < n; c++) s -= M[i * W + c] * x[c];
    x[i] = s / M[i * W + i];
    if (!Number.isFinite(x[i])) return null;
  }
  return x;
}

export function mat3Mul(A, B) {
  const C = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

export function mat3Inv(A) {
  const [a, b, c, d, e, f, g, h, i] = A;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return new Float64Array([
    (e * i - f * h) * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    (f * g - d * i) * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    (d * h - e * g) * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ]);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
  const px = (H[0] * x + H[1] * y + H[2]) / w;
  const py = (H[3] * x + H[4] * y + H[5]) / w;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { x: px, y: py };
}

export function isFiniteMat3(H) {
  for (let i = 0; i < 9; i++) if (!Number.isFinite(H[i])) return false;
  return true;
}

function normalizeTransform(pts, idx) {
  let mx = 0;
  let my = 0;
  const n = idx.length;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    mx += pts[2 * i];
    my += pts[2 * i + 1];
  }
  mx /= n;
  my /= n;
  let mean = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    mean += Math.hypot(pts[2 * i] - mx, pts[2 * i + 1] - my);
  }
  mean /= n;
  const s = mean > 1e-6 ? Math.SQRT2 / mean : 1;
  return new Float64Array([s, 0, -s * mx, 0, s, -s * my, 0, 0, 1]);
}

/** 归一化 DLT：至少 4 组对应点，返回 3x3 单应矩阵（src -> dst）。 */
export function estimateHomography(src, dst, idx) {
  if (!idx || idx.length < 4) return null;
  const Ts = normalizeTransform(src, idx);
  const Td = normalizeTransform(dst, idx);
  const A = new Float64Array(64);
  const bv = new Float64Array(8);
  const r1 = new Float64Array(8);
  const r2 = new Float64Array(8);
  const n = idx.length;

  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const x = src[2 * i];
    const y = src[2 * i + 1];
    const u = dst[2 * i];
    const v = dst[2 * i + 1];
    const nx = Ts[0] * x + Ts[2];
    const ny = Ts[4] * y + Ts[5];
    const nu = Td[0] * u + Td[2];
    const nv = Td[4] * v + Td[5];

    r1[0] = nx; r1[1] = ny; r1[2] = 1; r1[3] = 0; r1[4] = 0; r1[5] = 0;
    r1[6] = -nx * nu; r1[7] = -ny * nu;
    r2[0] = 0; r2[1] = 0; r2[2] = 0; r2[3] = nx; r2[4] = ny; r2[5] = 1;
    r2[6] = -nx * nv; r2[7] = -ny * nv;

    for (let a = 0; a < 8; a++) {
      const ra = r1[a];
      const rb = r2[a];
      if (ra !== 0) {
        for (let b = 0; b < 8; b++) A[a * 8 + b] += ra * r1[b];
        bv[a] += ra * nu;
      }
      if (rb !== 0) {
        for (let b = 0; b < 8; b++) A[a * 8 + b] += rb * r2[b];
        bv[a] += rb * nv;
      }
    }
  }

  const hv = solveLinear(A, bv, 8);
  if (!hv) return null;
  const Hn = new Float64Array([hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1]);
  const TdInv = mat3Inv(Td);
  if (!TdInv) return null;
  let H = mat3Mul(TdInv, mat3Mul(Hn, Ts));
  if (!isFiniteMat3(H)) return null;
  if (Math.abs(H[8]) > 1e-9) {
    const s = 1 / H[8];
    for (let i = 0; i < 9; i++) H[i] *= s;
  }
  return H;
}

/** 对称转移误差（像素）：正向与反向各取平均。 */
export function symmetricError(H, Hinv, x, y, u, v) {
  const p = applyH(H, x, y);
  if (!p) return Infinity;
  const q = applyH(Hinv, u, v);
  if (!q) return Infinity;
  const e1 = Math.hypot(p.x - u, p.y - v);
  const e2 = Math.hypot(q.x - x, q.y - y);
  return (e1 + e2) * 0.5;
}

/** H 的不动点（FOE/缩放中心）。返回 null 表示在无穷远。 */
export function fixedPointOfH(H) {
  const rows = [
    [H[0] - 1, H[1], H[2]],
    [H[3], H[4] - 1, H[5]],
    [H[6], H[7], H[8] - 1],
  ];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  let c = cross(rows[0], rows[1]);
  if (Math.hypot(c[0], c[1], c[2]) < 1e-9) c = cross(rows[0], rows[2]);
  if (Math.hypot(c[0], c[1], c[2]) < 1e-9) c = cross(rows[1], rows[2]);
  const norm = Math.hypot(c[0], c[1], c[2]);
  if (norm < 1e-9) return null;
  if (Math.abs(c[2]) < 1e-7 * norm) return null;
  return { x: c[0] / c[2], y: c[1] / c[2] };
}

export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
