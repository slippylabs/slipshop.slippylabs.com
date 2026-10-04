// Exact Euclidean distance transform.
//
// Felzenszwalb and Huttenlocher's algorithm: squared Euclidean distance is
// separable, so a 1-D lower-envelope pass down the columns and then across the
// rows is EXACT and linear time. The 8SSEDT chamfer most people reach for is
// only almost exact -- about 0.04 px out -- and that error reads as a slightly
// uneven feather or a lumpy stroke rather than as a bug.
//
// Three things this drives, all of which are wrong in a visible way if the
// distances are wrong: Select > Modify (Expand, Contract, Feather, Border), the
// Stroke and Glow layer effects, and Bevel & Emboss's profile.

const INF = 1e20;

/**
 * One 1-D pass: for each i, min over j of (f[j] + (i-j)^2).
 *
 * @param f   the input row (squared distances so far)
 * @param n   its length
 * @param d   output, length n
 * @param v   scratch, length n   (parabola centres)
 * @param z   scratch, length n+1 (parabola boundaries)
 */
function lowerEnvelope(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    // Where does the parabola from q overtake the one currently on top?
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel where
 * `inside` is true. Pixels that are themselves inside get 0.
 *
 * @param inside  a function (i) => boolean, or a typed array treated as truthy
 * @returns Float32Array of SQUARED distances (w*h)
 */
export function distanceSqTransform(inside, w, h) {
  const n = w * h;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float32Array(n);

  const test = typeof inside === 'function' ? inside : (i) => inside[i] !== 0;
  for (let i = 0; i < n; i++) out[i] = test(i) ? 0 : INF;

  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    lowerEnvelope(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  // rows
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    lowerEnvelope(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

/** Euclidean distance, in pixels. */
export function distanceTransform(inside, w, h) {
  const sq = distanceSqTransform(inside, w, h);
  for (let i = 0; i < sq.length; i++) sq[i] = Math.sqrt(sq[i]);
  return sq;
}

/**
 * A SIGNED distance field from a coverage mask, in pixels: negative inside,
 * positive outside, measured from the 0.5 coverage boundary.
 *
 * Signed is what Expand and Contract need from one computation -- shifting
 * the threshold moves the edge in either direction, so growing and shrinking
 * are the same operation with a different number.
 */
export function signedDistance(mask, w, h, threshold = 0.5) {
  const n = w * h;
  const insideFn = (i) => mask[i] >= threshold;
  const outsideFn = (i) => mask[i] < threshold;
  const dOut = distanceTransform(insideFn, w, h);   // distance to inside
  const dIn = distanceTransform(outsideFn, w, h);   // distance to outside
  const out = new Float32Array(n);
  // The HALF PIXEL matters. A distance transform measures centre to centre, so
  // the last pixel inside a shape reports distance 1 to the first pixel
  // outside it -- but the geometric boundary runs between them, half a pixel
  // from each. Without the correction the edge sits half a pixel out on every
  // side, and Expand/Contract were off by roughly the perimeter times a half:
  // expanding a 40x40 square by 5 gave 2380 instead of 2479.
  for (let i = 0; i < n; i++) {
    out[i] = mask[i] >= threshold ? -(dIn[i] - 0.5) : (dOut[i] - 0.5);
  }
  return out;
}
