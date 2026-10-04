// Run a snippet of JS in headless Chromium and get its result back.
//
// chromium-headless-shell with --dump-dom is enough and needs no Playwright:
// the page writes its answer into a <pre> as base64 and we parse it out of the
// dumped DOM. Two rules learned the hard way on this box:
//   * --virtual-time-budget fast-forwards timers, which beats any async encode
//     (canvas.toBlob) and reports empty results that look like bugs. Anything
//     synchronous is fine, and everything here is synchronous.
//   * the page must set its own completion flag; readyState is not enough.

import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const SHELL = '/usr/lib/chromium/chromium-headless-shell';

/**
 * @param body  JS source. Must assign a string to `window.__out`.
 * @returns     that string
 */
export function runInBrowser(body, { timeoutMs = 120000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slipshop-'));
  const page = join(dir, 'p.html');
  writeFileSync(page, `<!doctype html><body><pre id="o"></pre><script>
try { ${body} } catch (e) { window.__out = 'ERROR: ' + (e && e.stack || e); }
document.getElementById('o').textContent = window.__out;
</script></body>`);
  try {
    const out = execFileSync(SHELL, [
      '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--virtual-time-budget=20000',
      '--dump-dom', `file://${page}`,
    ], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
    const m = out.match(/<pre id="o">([\s\S]*?)<\/pre>/);
    if (!m) throw new Error('no <pre id="o"> in the dumped DOM');
    const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (text.startsWith('ERROR:')) throw new Error(`page threw -- ${text}`);
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Decode a base64 payload the page produced. */
export function b64bytes(s) { return new Uint8Array(Buffer.from(s, 'base64')); }

/**
 * The same, but cached by the content of the snippet.
 *
 * The result of asking Chromium what its canvas does depends only on the
 * snippet, not on any of our code, so it is a REFERENCE and caching it is no
 * different from checking a reference table into the repo. It matters because
 * controls.sh runs an oracle once per mutation -- two hundred times -- and a
 * headless browser launch is most of a minute of that.
 *
 * Keyed on a hash of the snippet, so changing a single case invalidates it,
 * and kept in the system temp directory rather than the repo, so a fresh
 * checkout still asks the real browser once.
 */
export function runInBrowserCached(body, opts = {}) {
  const key = createHash('sha256').update(body).digest('hex').slice(0, 32);
  const file = join(tmpdir(), `slipshop-ref-${key}.txt`);
  if (existsSync(file)) {
    try {
      const cached = readFileSync(file, 'utf8');
      if (cached.length) return cached;
    } catch (e) { /* fall through and ask the browser */ }
  }
  const out = runInBrowser(body, opts);
  try { writeFileSync(file, out); } catch (e) { /* a cache miss is not a failure */ }
  return out;
}
