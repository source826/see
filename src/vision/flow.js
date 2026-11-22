// 金字塔 Lucas-Kanade 光流（前向加性），手写实现。
import { sampleBilinear } from './image.js';
import { blur5, downsample2 } from './image.js';

export function buildPyramid(img, levels = 3) {
  const pyr = [img];
  for (let i = 1; i < levels; i++) {
    pyr.push(downsample2(blur5(pyr[i - 1])));
  }
  return pyr;
}

function trackPyramid(prevPyr, nextPyr, prevPts, opts, out) {
  const n = prevPts.length >> 1;
  const levels = Math.min(prevPyr.length, nextPyr.length);
  const win = opts.window ?? 2;
  const iters = opts.iterations ?? 4;
  const minEig = opts.minEig ?? 0.4;
  const maxStep = opts.maxStep ?? 3;
  const boundary = win + 1;

  const nextPts = out.nextPts;
  const status = out.status;
  const errors = out.errors;
  const flow = out.flow;
  nextPts.set(prevPts);
  status.fill(0);
  errors.fill(0);
  flow.fill(0);

  let guess = new Float64Array(n * 2);
  const alive = new Uint8Array(n).fill(1);

  for (let l = levels - 1; l >= 0; l--) {
    const scale = 1 / (1 << l);
    const P = prevPyr[l];
    const N = nextPyr[l];
    const { gx, gy } = P.gradients();
    const nextGuess = new Float64Array(n * 2);
    const pw = P.w;

    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const px = prevPts[2 * i] * scale;
      const py = prevPts[2 * i + 1] * scale;
      if (px < boundary || py < boundary || px >= P.w - boundary || py >= P.h - boundary) {
        alive[i] = 0;
        continue;
      }
      let dx = l === levels - 1 ? 0 : guess[2 * i] * 2;
      let dy = l === levels - 1 ? 0 : guess[2 * i + 1] * 2;
      const ix0 = Math.round(px);
      const iy0 = Math.round(py);

      for (let it = 0; it < iters; it++) {
        let Axx = 0;
        let Axy = 0;
        let Ayy = 0;
        let bx = 0;
        let by = 0;
        let cnt = 0;
        for (let wy = -win; wy <= win; wy++) {
          const sy = iy0 + wy;
          if (sy < 1 || sy >= P.h - 1) continue;
          const sampleY = py + wy + dy;
          for (let wx = -win; wx <= win; wx++) {
            const sx = ix0 + wx;
            if (sx < 1 || sx >= P.w - 1) continue;
            const jv = sampleBilinear(N, px + wx + dx, sampleY);
            if (jv < 0) continue;
            const ii = sy * pw + sx;
            const ix = gx[ii];
            const iy = gy[ii];
            const dt = jv - P.data[ii];
            Axx += ix * ix;
            Axy += ix * iy;
            Ayy += iy * iy;
            bx += ix * dt;
            by += iy * dt;
            cnt++;
          }
        }
        if (cnt < (2 * win + 1) * (2 * win + 1) * 0.5) {
          alive[i] = 0;
          break;
        }
        const det = Axx * Ayy - Axy * Axy;
        const trace = Axx + Ayy;
        const minEigen = trace * 0.5 - Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
        if (!(minEigen > minEig) || Math.abs(det) < 1e-9) break;
        const inv = 1 / det;
        const ux = -(Ayy * bx - Axy * by) * inv;
        const uy = -(-Axy * bx + Axx * by) * inv;
        dx += ux < -maxStep ? -maxStep : ux > maxStep ? maxStep : ux;
        dy += uy < -maxStep ? -maxStep : uy > maxStep ? maxStep : uy;
        if (ux * ux + uy * uy < 0.0025) break;
      }

      if (!alive[i]) continue;
      if (px + dx < 0 || py + dy < 0 || px + dx > N.w - 1 || py + dy > N.h - 1) {
        alive[i] = 0;
        continue;
      }
      nextGuess[2 * i] = dx;
      nextGuess[2 * i + 1] = dy;

      if (l === 0) {
        nextPts[2 * i] = prevPts[2 * i] + dx;
        nextPts[2 * i + 1] = prevPts[2 * i + 1] + dy;
        flow[2 * i] = dx;
        flow[2 * i + 1] = dy;
        // 最终窗口 SAD
        let errSum = 0;
        let errCnt = 0;
        for (let wy = -win; wy <= win; wy++) {
          for (let wx = -win; wx <= win; wx++) {
            const jv = sampleBilinear(N, px + wx + dx, py + wy + dy);
            if (jv < 0) continue;
            errSum += Math.abs(jv - P.data[(iy0 + wy) * pw + (ix0 + wx)]);
            errCnt++;
          }
        }
        errors[i] = errCnt > 0 ? errSum / errCnt : 255;
        status[i] = 1;
      }
    }
    guess = nextGuess;
  }
  return out;
}

/**
 * @param {Array} prevPyr
 * @param {Array} nextPyr
 * @param {Float32Array} prevPts 展平的 x,y
 * @returns {{nextPts:Float32Array,status:Uint8Array,errors:Float32Array,flow:Float32Array}}
 */
export function lkTrack(prevPyr, nextPyr, prevPts, opts = {}) {
  const n = prevPts.length >> 1;
  const out = {
    nextPts: new Float32Array(prevPts),
    status: new Uint8Array(n),
    errors: new Float32Array(n),
    flow: new Float32Array(n * 2),
  };
  return trackPyramid(prevPyr, nextPyr, prevPts, opts, out);
}

/** 前后向一致性检查，剔除漂移点。 */
export function lkTrackFB(prevPyr, nextPyr, prevPts, opts = {}) {
  const out = lkTrack(prevPyr, nextPyr, prevPts, opts);
  const n = prevPts.length >> 1;
  const fb = lkTrack(nextPyr, prevPyr, out.nextPts, opts);
  const maxFb = opts.maxFbError ?? 1.5;
  for (let i = 0; i < n; i++) {
    if (!out.status[i]) continue;
    if (!fb.status[i]) {
      out.status[i] = 0;
      continue;
    }
    const ex = fb.nextPts[2 * i] - prevPts[2 * i];
    const ey = fb.nextPts[2 * i + 1] - prevPts[2 * i + 1];
    if (ex * ex + ey * ey > maxFb * maxFb) out.status[i] = 0;
  }
  return out;
}
