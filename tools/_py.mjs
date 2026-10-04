// Run a Python snippet against the reference libraries and exchange arrays as
// raw float64, not JSON: an oracle that compares a million pixels should not
// spend its time in a text parser, and binary removes any question of decimal
// round-tripping changing the numbers being compared.
//
// The venv at .venv holds numpy, scipy, scikit-image and Pillow. The system
// python has none of them and is PEP 668 locked, so it cannot be used.

import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PY = join(ROOT, '.venv', 'bin', 'python');

export function havePython() { return existsSync(PY); }

/**
 * @param src   Python source. Gets `IN` (a float64 numpy array, or None),
 *              `SHAPE` (the shape you asked for) and must assign `OUT` to a
 *              float64-able numpy array. `np` is already imported.
 * @param input Float64Array | null
 * @param shape reshape IN to this before handing it over
 */
export function runPython(src, input = null, shape = null) {
  const dir = mkdtempSync(join(tmpdir(), 'slipshop-py-'));
  const inF = join(dir, 'in.f64');
  const outF = join(dir, 'out.f64');
  const scriptF = join(dir, 's.py');
  try {
    if (input) writeFileSync(inF, Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    writeFileSync(scriptF, `
import numpy as np
SHAPE = ${shape ? JSON.stringify(shape) : 'None'}
IN = None
try:
    IN = np.fromfile(${JSON.stringify(inF)}, dtype=np.float64)
    if SHAPE is not None:
        IN = IN.reshape(SHAPE)
except FileNotFoundError:
    pass
OUT = None
${src}
assert OUT is not None, "the snippet never assigned OUT"
np.ascontiguousarray(OUT, dtype=np.float64).tofile(${JSON.stringify(outF)})
`);
    execFileSync(PY, [scriptF], { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 1 << 28 });
    const buf = readFileSync(outF);
    return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
