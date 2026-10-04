// Oracle: text layout and warping.
//
// Layout is arithmetic over glyph widths, so the way to test it exactly is to
// supply the widths. With a synthetic metric -- every character exactly ten
// units wide, no kerning -- the right answer for wrapping, alignment,
// tracking, justification and the block box is a number you can work out on
// paper, and the oracle asserts that number rather than a tolerance.
//
// Then the same layout is run against the browser's real font metrics, where
// the question is not "is this the right width" but "does our per-character
// placement agree with what the browser draws when handed the whole string".
// Those are two different claims and they need two different references.
//
// The warp is checked three ways: a bend of zero is the identity for all
// sixteen styles, each style's extent is bounded, and warp followed by unwarp
// is the identity to 1e-13 -- which is the property the rasteriser actually
// depends on, because it resamples through the inverse.

import {
  textDefaults, cssFont, layoutText, wrapParagraph, ALIGNMENTS,
  WARP_STYLES, warpPoint, unwarpPoint, isIdentityWarp, warpedExtent,
  warpDefaults, bendRange, polylineArc, pointAtArc, placeOnPath,
  TEXT_FIELDS, WARP_FIELDS,
} from '../js/core/text.js';
import { ok, eq, worst, note, done } from './_harness.mjs';
import { runInBrowser } from './_browser.mjs';
import { mulberry32 } from '../js/core/util.js';

/** Every character ten wide, so every expected number is an integer. */
const UNIT = 10;
const flat = (s) => [...s].length * UNIT;

// --------------------------------------------------------------- the spec

{
  const d = textDefaults();
  for (const [, key] of TEXT_FIELDS) ok(key in d, `TEXT_FIELDS: ${key} has a default`);
  for (const [, key] of WARP_FIELDS) ok(key in warpDefaults(), `WARP_FIELDS: ${key} has a default`);
  ok(ALIGNMENTS.includes(d.align), 'the default alignment is one of the listed ones');
  eq(cssFont({ fontStyle: 'italic', fontWeight: 'bold', fontSize: 20, fontFamily: 'serif' }),
    'italic bold 20px serif', 'cssFont builds the canvas shorthand');
  eq(cssFont({}), 'normal normal 48px sans-serif', 'cssFont fills the defaults in');
  // A warp of zero bend is the identity, so the rasteriser can skip a whole
  // resampling pass -- and must, or every unwarped text layer pays for it.
  ok(isIdentityWarp(null), 'no warp is the identity');
  ok(isIdentityWarp({ style: 'arc', bend: 0, horizontal: 0, vertical: 0 }), 'a zero bend is the identity');
  ok(!isIdentityWarp({ style: 'arc', bend: 0.3 }), 'a real bend is not');
  ok(isIdentityWarp({ style: 'none', bend: 1 }), 'style none is the identity whatever the bend');
}

// ------------------------------------------------------------------ wrapping

{
  // 10 units a character, a 50-unit box: five characters a line.
  eq(wrapParagraph('abcde fghij', 50, flat).join('|'), 'abcde|fghij', 'wraps at the box width');
  // "abc de" is six characters, so 60 -- over the 50 box. The greedy answer
  // is "abc" alone and then "de fg", which is exactly 50.
  eq(wrapParagraph('abc de fg', 50, flat).join('|'), 'abc|de fg', 'packs as many words as fit');
  // The decisive case for the trailing space, and it has to be a word that is
  // NOT the first on its line: "ab cd " is 60 with its space and 50 without,
  // so the line holds. Checking it on the first word instead proves nothing,
  // because the "is there already something on this line" guard skips it.
  eq(wrapParagraph('ab cd ef', 50, flat).join('|'), 'ab cd|ef',
    'a line that exactly fits without its trailing space is kept');
  eq(wrapParagraph('abcdefghij', 50, flat).join('|'), 'abcde|fghij',
    'a word longer than the line is broken by character');
  eq(wrapParagraph('', 50, flat).join('|'), '', 'an empty paragraph is one empty line');
  eq(wrapParagraph('abcde fghij', null, flat).length, 1, 'no width means no wrapping');
  eq(wrapParagraph('abcde fghij', 0, flat).length, 1, 'nor does a width of zero');

  // A trailing space must not decide the break. "abcde " is 60 wide with the
  // space and 50 without; the space is invisible at the end of a line, so the
  // line holds. Measuring with it wraps "abcde fg" to three lines instead of
  // two, which is the classic off-by-one-space bug.
  eq(wrapParagraph('abcde fg', 50, flat).join('|'), 'abcde|fg', 'a trailing space does not force a break');

  // Every line that is not a forced character break fits the box.
  const rnd = mulberry32(7);
  const words = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'];
  for (let t = 0; t < 60; t++) {
    const n = 2 + Math.floor(rnd() * 10);
    const para = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
    const width = 30 + Math.floor(rnd() * 70);
    const lines = wrapParagraph(para, width, flat);
    for (const line of lines) {
      const single = !line.includes(' ');
      const wd = flat(line);
      ok(wd <= width || single, `wrapped line fits (${wd} <= ${width}): "${line}"`);
    }
    // Nothing is lost and nothing is invented. Compared with the spaces
    // stripped, because a word too long for the line is broken by character
    // and rejoining with a space would invent one that was never there.
    eq(lines.join('').replace(/\s/g, ''), para.replace(/\s/g, ''),
      'wrapping preserves every character');
  }
}

// -------------------------------------------------------------------- layout

{
  const base = { fontSize: 20, lineHeight: 1.5, x: 100, y: 200, content: 'ab\ncdef' };
  const L = layoutText(base, flat, { ascent: 16, descent: 4 });
  eq(L.lines.length, 2, 'one line per newline');
  eq(L.lines[0].y, 200, 'the first baseline is at y');
  eq(L.lines[1].y, 230, 'the next is one line height down (20 * 1.5)');
  eq(L.lineHeight, 30, 'line height is a multiple of the font size');
  eq(L.lines[0].width, 20, 'line width is the sum of the advances');
  eq(L.lines[1].width, 40, 'and for the longer line');
  // The box top is the first baseline minus the ascent, and its height spans
  // from that to the last descender.
  eq(L.box.y, 184, 'the box top is the baseline minus the ascent');
  eq(L.box.h, 50, 'the box height spans ascent + the drop + descent');
  eq(L.box.x, 100, 'left-aligned, the box starts at x');
  eq(L.box.w, 40, 'and is as wide as the widest line');

  // Alignment, with the block 40 wide and the short line 20.
  for (const [align, wantX] of [['left', 100], ['center', 110], ['right', 120]]) {
    const A = layoutText({ ...base, align }, flat, { ascent: 16, descent: 4 });
    eq(A.lines[0].x, wantX, `${align}: the short line starts at ${wantX}`);
    eq(A.lines[1].x, 100, `${align}: the widest line still starts at 100`);
  }

  // Tracking adds its gap BETWEEN characters, not after the last one: four
  // characters at 10 with 3 of tracking is 40 + 3*3 = 49, not 52. Counting the
  // trailing one makes every centred line sit half a tracking step left.
  const T = layoutText({ ...base, tracking: 3 }, flat, { ascent: 16, descent: 4 });
  eq(T.lines[1].width, 49, 'tracking is applied between characters only');
  eq(T.lines[1].chars[0].x, 100, 'the first character is not shifted by tracking');
  eq(T.lines[1].chars[3].x, 100 + 30 + 9, 'the last character carries three tracking steps');

  // Empty content lays out without throwing and claims no height.
  const E = layoutText({ content: '' }, flat, { ascent: 16, descent: 4 });
  eq(E.lines.length, 1, 'empty content is one empty line');
  eq(E.lines[0].width, 0, 'with no width');

  // Character positions sum to the line's own width.
  for (const content of ['hello', 'a b c', 'xyzzy plugh', '']) {
    const C = layoutText({ ...base, content }, flat, { ascent: 16, descent: 4 });
    for (const line of C.lines) {
      if (!line.chars.length) continue;
      const last = line.chars[line.chars.length - 1];
      eq(last.x + last.width - line.x, line.width, `"${line.text}": the characters span the line width`);
      for (const c of line.chars) eq(c.width, UNIT, `"${line.text}": each advance is the metric`);
    }
  }
}

// ---------------------------------------------------------------- justify

{
  // Justify stretches the GAPS. "ab cd" is 50 wide with one gap; in a box of
  // 80 the gap grows by 30, so the second word starts 30 further right -- and
  // the glyphs are untouched.
  // The paragraph HAS to wrap for any of this to apply: a paragraph that fits
  // on one line is entirely its own last line, so it is never justified. The
  // first version of this check used a single-line paragraph and read the
  // correct answer -- zero slack -- as a bug.
  const J = layoutText({
    content: 'ab cd ef gh', boxWidth: 100, align: 'justify', fontSize: 20, x: 0, y: 0,
  }, flat, { ascent: 16, descent: 4 });
  eq(J.lines.length, 2, 'the paragraph wraps, so there is a line to justify');
  const first = J.lines[0];
  eq(first.text, 'ab cd ef', 'the first line holds three words');
  // 8 characters at 10 = 80; the box is 100; two gaps share 20.
  eq(first.extraPerGap, 10, 'the slack is shared between the gaps');
  const chars = first.chars;
  eq(chars[0].x, 0, 'the first character is where it was');
  eq(chars[3].x, 30 + 10, 'the character after one gap carries one share');
  eq(chars[6].x, 60 + 20, 'and after two gaps, two shares');
  // The last line of a paragraph is NOT justified -- and to see that, the last
  // line has to have a GAP and some slack. "gh" alone has neither, so its
  // share is zero either way and the check was vacuous.
  const K = layoutText({
    content: 'ab cd ef gh ij', boxWidth: 100, align: 'justify', fontSize: 20, x: 0, y: 0,
  }, flat, { ascent: 16, descent: 4 });
  eq(K.lines.length, 2, 'two lines');
  eq(K.lines[1].text, 'gh ij', 'the last line has a gap in it');
  ok(K.lines[1].width < 100, `and slack to stretch into (${K.lines[1].width} of 100)`);
  eq(K.lines[1].extraPerGap, 0, 'the last line of a paragraph is left alone');

  // A line with no gaps cannot be justified and must not divide by zero.
  const N = layoutText({ content: 'abcdefgh\nmore', boxWidth: 200, align: 'justify' }, flat, {});
  ok(Number.isFinite(N.lines[0].extraPerGap), 'a gapless line gets a finite share');
  eq(N.lines[0].extraPerGap, 0, 'and that share is zero');
}

// ------------------------------------------------------- paragraphs and indent

{
  const P = layoutText({
    content: 'one\ntwo', fontSize: 10, lineHeight: 1, paragraphSpacing: 7, x: 0, y: 0,
  }, flat, { ascent: 8, descent: 2 });
  eq(P.lines[1].y, 17, 'a paragraph gap is added on top of the line height');

  const I = layoutText({
    content: 'aa bb cc dd', boxWidth: 40, firstLineIndent: 20, fontSize: 10, x: 0, y: 0,
  }, flat, { ascent: 8, descent: 2 });
  eq(I.lines[0].x, 20, 'the first line of a paragraph is indented');
  eq(I.lines[1].x, 0, 'the rest are not');
  // The indent eats into the available width, so the first line holds less.
  ok(I.lines[0].width <= 20, `the indented line fits the remaining width (${I.lines[0].width})`);
}

// ------------------------------------------------------------ text on a path

{
  // A straight horizontal path must reproduce the flat layout exactly, which
  // is the only statement here that needs no geometry: turning a path on must
  // not reflow the text.
  const L = layoutText({ content: 'abcdef', fontSize: 10, x: 0, y: 0 }, flat, {});
  const line = L.lines[0];
  const path = [{ x: 0, y: 50 }, { x: 500, y: 50 }];
  const placed = placeOnPath(line.chars, path, { x0: line.x });
  eq(placed.length, 6, 'every character is placed');
  placed.forEach((c, i) => {
    eq(c.angle, 0, `char ${i}: a horizontal path has no rotation`);
    eq(c.cy, 50, `char ${i}: sits on the path`);
    // Each glyph is centred on its own advance, so its centre is half a
    // width right of where its left edge was.
    eq(c.cx, i * UNIT + UNIT / 2, `char ${i}: centred on its advance`);
  });

  // Arc length and the point along it.
  const poly = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }];
  const acc = polylineArc(poly);
  eq(acc[0], 0, 'arc length starts at zero');
  eq(acc[1], 5, 'a 3-4-5 segment is 5 long');
  eq(acc[2], 15, 'and the next adds 10');
  const mid = pointAtArc(poly, acc, 2.5);
  eq(mid.x, 1.5, 'halfway along the first segment: x');
  eq(mid.y, 2, 'halfway along the first segment: y');
  const on2 = pointAtArc(poly, acc, 10);
  eq(on2.x, 3, 'five into the second segment: x');
  eq(on2.y, 9, 'five into the second segment: y');
  eq(Math.round(on2.angle * 1e9) / 1e9, Math.round((Math.PI / 2) * 1e9) / 1e9,
    'the second segment points straight down');
  // Past the end it extrapolates rather than piling up on the last point --
  // clamping would stack every overflowing glyph in one place, which reads as
  // a bug rather than as "the path is too short".
  const past = pointAtArc(poly, acc, 25);
  eq(past.y, 24, 'past the end, the terminal segment is extended');
  // Degenerate paths do not throw.
  ok(Number.isFinite(pointAtArc([], [], 5).x), 'an empty path gives a finite point');
  ok(Number.isFinite(pointAtArc([{ x: 1, y: 2 }], [0], 5).x), 'a one-point path too');
  eq(placeOnPath(line.chars, [{ x: 0, y: 0 }], {}).length, 6, 'a path too short to use falls back to the flat line');

  // On a vertical path, the glyphs rotate a quarter turn and march downward.
  const down = [{ x: 20, y: 0 }, { x: 20, y: 500 }];
  const pv = placeOnPath(line.chars, down, { x0: 0 });
  pv.forEach((c, i) => {
    eq(c.angle, Math.PI / 2, `vertical path char ${i}: rotated a quarter turn`);
    eq(c.cy, i * UNIT + UNIT / 2, `vertical path char ${i}: marches down`);
    eq(c.cx, 20, `vertical path char ${i}: stays on the path`);
  });
  // `below` flips the text and reverses which way is up.
  const pb = placeOnPath(line.chars, path, { x0: 0, side: 'below' });
  eq(pb[0].angle, Math.PI, 'below the path, the glyphs are turned over');
  eq(pb[0].ny, 1, 'and "up" points the other way');
}

// ------------------------------------------------------------------ the warp

{
  // A bend of zero is the identity for every style, which is the claim the
  // rasteriser's fast path rests on.
  for (const style of WARP_STYLES) {
    for (const u of [-1, -0.4, 0, 0.6, 1]) {
      for (const v of [-1, 0, 0.3, 1]) {
        const [x, y] = warpPoint(style, u, v, { bend: 0, horizontal: 0, vertical: 0 });
        eq(x, u, `${style}: bend 0 leaves u alone at (${u},${v})`);
        eq(y, v, `${style}: bend 0 leaves v alone at (${u},${v})`);
      }
    }
  }

  // The centre of the block. No style moves it SIDEWAYS -- these are shapes
  // applied about the middle, and one that slid the centre left or right would
  // be an offset error. The five vertical bows do move it down or up, because
  // bowing the whole block is what they are; everything else leaves it exactly
  // where it was.
  const BOWS = ['arc', 'arcLower', 'arcUpper', 'arch', 'rise'];
  for (const style of WARP_STYLES) {
    const [x, y] = warpPoint(style, 0, 0, { bend: 0.7 });
    eq(x, 0, `${style}: the centre does not move sideways`);
    if (BOWS.includes(style)) ok(Math.abs(y) > 1e-9, `${style}: a vertical bow moves the centre (${y})`);
    else eq(y, 0, `${style}: the centre is a fixed point`);
  }

  // warp -> unwarp is the identity. This is the load-bearing one: the
  // rasteriser samples the flat render through the inverse, so an inverse that
  // is 0.5 out puts the text half a block away. Plain Newton overshot on
  // `twist` and `inflate` at a large bend and left 12 of 1600 points with a
  // residual around 0.5; the damped version lands every one at 1e-13.
  let maxResidual = 0;
  for (const style of WARP_STYLES) {
    const [lo, hi] = bendRange(style);
    for (const bend of [lo, -0.5, -0.1, 0, 0.1, 0.5, hi]) {
      for (const horizontal of [0, 0.4]) {
        for (const vertical of [0, -0.3]) {
          const p = { bend, horizontal, vertical };
          for (let i = 0; i <= 8; i++) {
            for (let j = 0; j <= 8; j++) {
              const u = -1 + i / 4, v = -1 + j / 4;
              const [x, y] = warpPoint(style, u, v, p);
              const [bu, bv] = unwarpPoint(style, x, y, p);
              const [rx, ry] = warpPoint(style, bu, bv, p);
              const d = Math.hypot(rx - x, ry - y);
              if (d > maxResidual) maxResidual = d;
            }
          }
        }
      }
    }
  }
  // 1e-6, not 1e-13, for one reason: `fisheye` at the bottom of its range
  // magnifies the centre of the block twenty-fold, so the inverse there is
  // ill-conditioned and converges to 1.45e-8 rather than to the 1e-13 every
  // other combination reaches. 1e-8 of a normalised half-block is a ten-
  // thousandth of a pixel; the tolerance separates that from a real failure,
  // which shows up as a tenth of the block.
  ok(maxResidual < 1e-6, `the warp inverse round-trips (worst residual ${maxResidual.toExponential(2)})`);
  note(`warp inverse worst residual ${maxResidual.toExponential(2)} over ${WARP_STYLES.length} styles`);

  // The extent is a real bound, and it is NOT the four corners. `inflate` and
  // `twist` move interior points further out than any corner, so a
  // corners-only bound clips the middle of the text off -- which is why
  // warpedExtent samples the whole square.
  for (const style of WARP_STYLES) {
    const e = warpedExtent(style, { bend: bendRange(style)[1] });
    ok(e.x1 >= e.x0 && e.y1 >= e.y0, `${style}: the extent is a real rectangle`);
  }
  // ...and the reason it samples the square at all, stated as a measurement:
  // `inflate` pushes an INTERIOR point further out than any of the four
  // corners, so a corners-only bound would clip the middle of the text. It is
  // the only style that does, which is exactly why the trap is easy to miss.
  {
    const p = { bend: 0.8 };
    const corner = (style) => Math.max(...[[-1, -1], [1, -1], [-1, 1], [1, 1]]
      .map(([u, v]) => Math.abs(warpPoint(style, u, v, p)[1])));
    const inner = (style) => {
      let m = 0;
      for (let i = 0; i <= 60; i++) for (let j = 0; j <= 60; j++) {
        m = Math.max(m, Math.abs(warpPoint(style, -1 + i / 30, -1 + j / 30, p)[1]));
      }
      return m;
    };
    ok(inner('inflate') > corner('inflate') + 0.02,
      `inflate reaches ${inner('inflate').toFixed(3)} but its corners only ${corner('inflate').toFixed(3)}`);
    note(`inflate at bend 0.8: interior ${inner('inflate').toFixed(3)} vs corners ${corner('inflate').toFixed(3)}`);
  }
  // The extent is a bound, not an estimate: nothing on a much finer grid than
  // the one it sampled escapes it.
  for (const style of WARP_STYLES) {
    for (const bend of [bendRange(style)[0], 0.5, bendRange(style)[1]]) {
      for (const horizontal of [0, 0.7]) {
        const p = { bend, horizontal, vertical: -0.5 };
        const e = warpedExtent(style, p);
        let escaped = 0;
        for (let i = 0; i <= 120; i++) {
          for (let j = 0; j <= 120; j++) {
            const [x, y] = warpPoint(style, -1 + i / 60, -1 + j / 60, p);
            if (x < e.x0 || x > e.x1 || y < e.y0 || y > e.y1) escaped++;
          }
        }
        eq(escaped, 0, `${style} bend ${bend} h${horizontal}: ${escaped} points escaped the extent`);
      }
    }
  }

  // The two shears are shears: a pure horizontal distortion moves x by a
  // multiple of y and leaves y alone.
  for (const hz of [-0.6, 0.3]) {
    const [x, y] = warpPoint('none', 0.2, 0.5, { bend: 0, horizontal: hz, vertical: 0 });
    eq(y, 0.5, 'a horizontal distortion does not move y');
    eq(x, 0.2 + hz * 0.5 * 0.5, 'and moves x in proportion to y');
  }
}

// ----------------------------------------------- against the browser's fonts

{
  // The synthetic metric proves the arithmetic. This proves the CONVENTION:
  // our per-character x values, derived from measuring each prefix, have to
  // land where the browser puts the glyphs when it is handed the whole string.
  // Measuring each character on its own instead would drift by a pixel per
  // kerned pair, which is invisible in a sans at 16px and glaring in a serif
  // at 200px -- so the comparison runs at a large size in a serif.
  const got = JSON.parse(runInBrowser(`
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 300;
    const g = cv.getContext('2d');
    const out = {};
    for (const [name, font] of [['serif', 'normal normal 160px serif'], ['sans', 'normal normal 160px sans-serif']]) {
      g.font = font;
      const text = 'AVToWa.Ij';
      const prefixes = [];
      for (let i = 0; i <= text.length; i++) prefixes.push(g.measureText(text.slice(0, i)).width);
      const singles = [...text].map((c) => g.measureText(c).width);
      const m = g.measureText('Hg');
      out[name] = {
        text, prefixes, singles,
        ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent,
        whole: g.measureText(text).width,
      };
    }
    // The harness wraps this in a try block, so a bare return is a syntax
    // error with no stack worth reading: the contract is to assign a STRING.
    window.__out = JSON.stringify(out);
  `));

  for (const name of ['serif', 'sans']) {
    const d = got[name];
    const measure = (s) => d.prefixes[s.length];
    const L = layoutText({ content: d.text, fontSize: 160, x: 0, y: 0 }, measure,
      { ascent: d.ascent, descent: d.descent });
    const line = L.lines[0];
    eq(line.width, d.whole, `${name}: the line width is the browser's own measurement`, 1e-9);
    // Every character sits at its prefix width, exactly.
    line.chars.forEach((c, i) => {
      eq(c.x, d.prefixes[i], `${name}: char ${i} sits at the prefix width`, 1e-9);
    });
    // The box uses the FONT's ascent, not the ink of the string: a line of
    // "xxx" has no ascenders but still occupies a full line box.
    eq(L.box.y, -d.ascent, `${name}: the box top is the font ascent above the baseline`, 1e-9);
    eq(L.box.h, d.ascent + d.descent, `${name}: one line is one line box tall`, 1e-9);
  }

  // And the reason prefix measurement is the right choice, stated as a
  // measurement rather than asserted: summing single-character widths does
  // NOT give the browser's own total for a kerning face.
  const serif = got.serif;
  const summed = serif.singles.reduce((a, b) => a + b, 0);
  note(`serif "AVToWa.Ij" at 160px: prefixes total ${serif.whole.toFixed(2)}, single glyphs summed ${summed.toFixed(2)}`);
  ok(Math.abs(summed - serif.whole) > 10,
    `summing single glyph widths is ${(summed - serif.whole).toFixed(2)}px out over nine characters -- which is why the layout measures prefixes`);
}

done(`text: layout exact on a synthetic metric, ${WARP_STYLES.length} warp styles invertible, placement pinned to the browser`);
