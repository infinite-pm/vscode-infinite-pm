// Pan/zoom arithmetic for the .ipmt preview pane (media/preview-view.js).
//
// This was 60 lines of geometry inside a webview's inline <script>, which no
// test could reach — the recorded demo scene photographed it and asserted that
// an iframe existed. Now the maths is a plain module the webview loads and Node
// requires, and the parts that are easy to get subtly wrong (clamping,
// cursor-anchored zoom, degenerate viewports) are pinned here.
//
// Deliberately no jsdom: the DOM half stays in the inline script, so these
// tests need nothing but numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as path from 'path';

const req = createRequire(__filename);
const V = req(path.resolve(__dirname, '..', '..', 'media', 'preview-view.js')) as {
    STEP: number; MIN_SCALE: number; MAX_SCALE: number; DRAG_THRESHOLD: number;
    clampScale(s: number): number;
    fitDimensions(vb: { width: number; height: number } | null, vp: { width: number; height: number } | null):
        { baseW: number; baseH: number } | null;
    centerOffsets(vp: { width: number; height: number }, base: { baseW: number; baseH: number }, scale: number):
        { tx: number; ty: number };
    zoomAt(view: { scale: number; tx: number; ty: number }, s: number, cx: number, cy: number):
        { scale: number; tx: number; ty: number };
    zoomStep(view: { scale: number; tx: number; ty: number }, dir: number, cx: number, cy: number):
        { scale: number; tx: number; ty: number };
    zoomByWheel(view: { scale: number; tx: number; ty: number }, deltaY: number, cx: number, cy: number):
        { scale: number; tx: number; ty: number };
    isZoomed(s: number): boolean;
    isDrag(dx: number, dy: number): boolean;
    zoomLabel(s: number): string;
};

const view = (scale = 1, tx = 0, ty = 0) => ({ scale, tx, ty });
const close = (a: number, b: number, msg?: string) =>
    assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} !== ${b}`);

// --- fitting ------------------------------------------------------------

test('a wide diagram fits by width, a tall one by height', () => {
    // 200x100 viewBox in a 400x400 viewport: width-bound, so 2x.
    assert.deepEqual(V.fitDimensions({ width: 200, height: 100 }, { width: 400, height: 400 }),
        { baseW: 400, baseH: 200 });
    // 100x200 in the same viewport: height-bound, also 2x.
    assert.deepEqual(V.fitDimensions({ width: 100, height: 200 }, { width: 400, height: 400 }),
        { baseW: 200, baseH: 400 });
});

test('fitting preserves aspect ratio', () => {
    const fit = V.fitDimensions({ width: 300, height: 200 }, { width: 450, height: 1000 })!;
    close(fit.baseW / fit.baseH, 300 / 200, 'the diagram must not be stretched');
});

test('a viewport with no area yields no fit, rather than Infinity', () => {
    // The pane reports 0x0 while it is still laying out. Dividing by that is
    // how a preview ends up with NaN offsets and an invisible diagram.
    assert.equal(V.fitDimensions({ width: 200, height: 100 }, { width: 0, height: 400 }), null);
    assert.equal(V.fitDimensions({ width: 200, height: 100 }, { width: 400, height: 0 }), null);
    assert.equal(V.fitDimensions({ width: 0, height: 0 }, { width: 400, height: 400 }), null);
    assert.equal(V.fitDimensions(null, { width: 400, height: 400 }), null);
});

// --- centring -----------------------------------------------------------

test('centring leaves equal margins, and goes negative when zoomed past the edge', () => {
    assert.deepEqual(V.centerOffsets({ width: 400, height: 300 }, { baseW: 200, baseH: 100 }, 1),
        { tx: 100, ty: 100 });
    // Zoomed to 4x the diagram is larger than the viewport: the offsets must
    // go negative so the middle stays in view, not clamp to 0.
    assert.deepEqual(V.centerOffsets({ width: 400, height: 300 }, { baseW: 200, baseH: 100 }, 4),
        { tx: -200, ty: -50 });
});

// --- zooming ------------------------------------------------------------

test('the scale is clamped at both ends', () => {
    assert.equal(V.clampScale(1000), V.MAX_SCALE);
    assert.equal(V.clampScale(0.000001), V.MIN_SCALE);
    assert.equal(V.clampScale(2), 2);
});

test('the point under the cursor stays under the cursor', () => {
    // The property the whole zoom exists for. Take a document point, find its
    // screen position before and after, and require them equal.
    const before = view(1, 30, 20);
    const cx = 250, cy = 150;
    const docX = (cx - before.tx) / before.scale;
    const docY = (cy - before.ty) / before.scale;

    for (const target of [2, 5, 0.5, 17.3]) {
        const after = V.zoomAt(before, target, cx, cy);
        close(after.tx + docX * after.scale, cx, `x drifted zooming to ${target}`);
        close(after.ty + docY * after.scale, cy, `y drifted zooming to ${target}`);
    }
});

test('zooming past a limit still anchors correctly at the clamped scale', () => {
    const before = view(20, -100, -50);
    const cx = 200, cy = 100;
    const docX = (cx - before.tx) / before.scale;
    const after = V.zoomAt(before, 1000, cx, cy);
    assert.equal(after.scale, V.MAX_SCALE);
    close(after.tx + docX * after.scale, cx, 'clamping must not break the anchor');
});

test('a zoom to where we already are is a no-op, so callers can skip a repaint', () => {
    const v = view(2, 10, 10);
    assert.equal(V.zoomAt(v, 2, 100, 100), v, 'same object back means nothing to apply');
    assert.equal(V.zoomAt(view(V.MAX_SCALE, 0, 0), 99, 5, 5).scale, V.MAX_SCALE);
});

test('one step in then one step out returns to the same view', () => {
    const start = view(1, 40, 25);
    const there = V.zoomStep(start, +1, 120, 80);
    const back = V.zoomStep(there, -1, 120, 80);
    close(back.scale, start.scale);
    close(back.tx, start.tx, 'a step out must undo the step in exactly');
    close(back.ty, start.ty);
});

test('the wheel zooms in when scrolled up and out when scrolled down', () => {
    const start = view(1, 0, 0);
    assert.ok(V.zoomByWheel(start, -100, 50, 50).scale > 1, 'scroll up zooms in');
    assert.ok(V.zoomByWheel(start, +100, 50, 50).scale < 1, 'scroll down zooms out');
});

// --- what the user sees -------------------------------------------------

test('a fit that lands a hair off 1 does not count as zoomed', () => {
    // Otherwise the overlay flickers on at "100%" the moment a diagram
    // happens to fit at 1.0001.
    assert.equal(V.isZoomed(1), false);
    assert.equal(V.isZoomed(1.001), false);
    assert.equal(V.isZoomed(1.5), true);
    assert.equal(V.isZoomed(0.5), true);
});

test('the overlay reads as a whole percentage', () => {
    assert.equal(V.zoomLabel(1), '100%');
    assert.equal(V.zoomLabel(2.5), '250%');
    assert.equal(V.zoomLabel(0.333), '33%');
});

test('a twitch is a click, a travel is a drag', () => {
    // Below the threshold a steady click still zooms; above it, the same
    // gesture pans instead. Getting this backwards makes the pane feel stuck.
    assert.equal(V.isDrag(0, 0), false);
    assert.equal(V.isDrag(V.DRAG_THRESHOLD, -V.DRAG_THRESHOLD), false);
    assert.equal(V.isDrag(V.DRAG_THRESHOLD + 1, 0), true);
    assert.equal(V.isDrag(0, -(V.DRAG_THRESHOLD + 1)), true);
});

// --- the half that stays in the webview ---------------------------------

test('the inline webview script is syntactically valid', () => {
    // The DOM half is a template string assembled in ipmtPreview.ts, so a typo
    // in it is invisible to tsc and to every test here — it surfaces as a blank
    // preview pane in an installed build. Parsing it is cheap and catches that.
    const src = fs.readFileSync(
        path.resolve(__dirname, '..', 'extension', 'ipmtPreview.ts'), 'utf8');
    const start = src.indexOf('<script nonce="${nonce}">');
    assert.notEqual(start, -1, 'the inline script tag moved; update this test');
    const body = src.slice(src.indexOf('>', start) + 1, src.indexOf('</script>', start))
        // The template is interpolated at runtime; blank the ${...} holes so
        // the remainder can be parsed as plain JavaScript.
        .replace(/\$\{[^}]*\}/g, 'null');

    assert.doesNotThrow(() => new Function(body),
        'the .ipmt preview\'s inline script does not parse');
});

test('the inline script only calls helpers the module exports', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '..', 'extension', 'ipmtPreview.ts'), 'utf8');
    const used = new Set([...src.matchAll(/\bV\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const exported = new Set(Object.keys(V));
    const missing = [...used].filter((name) => !exported.has(name));
    assert.deepEqual(missing, [],
        'the webview calls these on the shared module and it does not export them — ' +
        'a runtime TypeError in the preview, invisible to tsc');
});
