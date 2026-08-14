// Pan/zoom arithmetic for the .ipmt preview pane.
//
// Split out of the webview's inline script so it can be tested without a
// browser: these are the decisions (what scale is legal, where the SVG sits,
// what a zoom does to the pan offsets), with no DOM in sight. The inline
// script keeps the DOM half — reading the viewBox, writing styles, listening
// for events — and calls in here for every number.
//
// Loaded two ways, which is the point:
//   * the webview loads it with <script src=… nonce=…> (it is inside the
//     extension's `media/` localResourceRoot);
//   * the tests `require` it in plain Node.
// Hence the export shim at the bottom. Keep this file dependency-free ES5-ish
// so both environments can read it without a build step.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;          // node:test
    } else {
        root.ipmPreviewView = api;     // webview
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STEP = 1.25;
    const MIN_SCALE = 0.1;
    const MAX_SCALE = 30;
    // A zoom this close to 1 reads as "not zoomed": the overlay hides and the
    // host loses its `zoomed` class. Slack, because a fit calculation lands a
    // hair off 1 far more often than a user asks for 100.4%.
    const ZOOMED_EPSILON = 0.005;
    // Pixels of movement before a mousedown/up pair counts as a drag rather
    // than a click. Below it, a steady hand that twitches still zooms.
    const DRAG_THRESHOLD = 3;

    /** Clamp a proposed scale into the legal range. */
    function clampScale(scale) {
        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    }

    /**
     * The SVG's CSS size at scale 1: its viewBox fitted inside the viewport,
     * preserving aspect ratio. Returns null when either box is degenerate —
     * a zero-width viewport happens while the pane is still laying out, and
     * the caller must not divide by it.
     */
    function fitDimensions(viewBox, viewport) {
        if (!viewBox || !viewport) return null;
        if (!(viewBox.width > 0) || !(viewBox.height > 0)) return null;
        if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
        const fit = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
        return { baseW: viewBox.width * fit, baseH: viewBox.height * fit };
    }

    /** Pan offsets that centre a base-sized, `scale`-zoomed SVG in the viewport. */
    function centerOffsets(viewport, base, scale) {
        return {
            tx: (viewport.width - base.baseW * scale) / 2,
            ty: (viewport.height - base.baseH * scale) / 2,
        };
    }

    /**
     * Zoom to `newScale` keeping the local point (cx, cy) under the cursor.
     *
     * The identity: a point's document coordinate is (local - t) / scale, and
     * holding it fixed across a scale change gives t' = c + (t - c) * ratio.
     * Returns the view unchanged when the clamped scale is where we already
     * are, so callers can skip a re-render.
     */
    function zoomAt(view, newScale, cx, cy) {
        const clamped = clampScale(newScale);
        if (Math.abs(clamped - view.scale) < 1e-6) return view;
        const ratio = clamped / view.scale;
        return {
            scale: clamped,
            tx: cx + (view.tx - cx) * ratio,
            ty: cy + (view.ty - cy) * ratio,
        };
    }

    /** One notch in or out, anchored at (cx, cy). */
    function zoomStep(view, direction, cx, cy) {
        return zoomAt(view, direction > 0 ? view.scale * STEP : view.scale / STEP, cx, cy);
    }

    /** Smooth wheel zoom: the same curve the image preview uses. */
    function zoomByWheel(view, deltaY, cx, cy) {
        return zoomAt(view, view.scale * Math.exp(-deltaY * 0.0015), cx, cy);
    }

    /** Does this scale count as zoomed — overlay visible, `zoomed` class on? */
    function isZoomed(scale) {
        return Math.abs(scale - 1) > ZOOMED_EPSILON;
    }

    /** Did the pointer travel far enough for this to be a drag, not a click? */
    function isDrag(dx, dy) {
        return Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
    }

    /** What the zoom overlay reads at this scale. */
    function zoomLabel(scale) {
        return Math.round(scale * 100) + '%';
    }

    return {
        STEP, MIN_SCALE, MAX_SCALE, ZOOMED_EPSILON, DRAG_THRESHOLD,
        clampScale, fitDimensions, centerOffsets,
        zoomAt, zoomStep, zoomByWheel,
        isZoomed, isDrag, zoomLabel,
    };
});
