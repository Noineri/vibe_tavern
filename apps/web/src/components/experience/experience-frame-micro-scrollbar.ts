/**
 * Frame micro-scrollbar (CNR-8q) — the vanilla DOM scrollbar system shipped
 * INSIDE both opaque-origin experience documents.
 *
 * The frames are `sandbox="allow-scripts"` documents WITHOUT allow-same-origin:
 * host CSS cannot cross the boundary (CNR-8a probe D), so the app-wide custom
 * lane contract (3px resting thumb expanding to 5px over a stable invisible
 * 5px grab lane — owner-approved, mirrored from `styles.css`
 * `[data-scroll-track]`) is re-implemented here as ONE self-contained script.
 * Both document builders in `ExperienceFrame.tsx` bake it into their
 * byte-mirrored head blocks (a counted fork pair — change them together).
 *
 * Mechanics, and why: the script injects its own `<style>` (the CSP allows
 * inline styles) and never mutates user-owned elements — native chrome is
 * hidden by CSS only, and the custom lanes live in a single fixed,
 * click-through overlay layer above all content, so expansion and lane
 * mounting are paint-only. Every scroller in the document (the root/body
 * scroller, any authored-visual region, textareas) is discovered
 * automatically: a MutationObserver watches for elements and class/style
 * changes, a ResizeObserver watches tracked boxes, and a capture-phase scroll
 * listener drives thumb position (it also repositions lanes of scrollers
 * shifted by an ancestor's scroll). All work is coalesced into one
 * requestAnimationFrame pass; scroll-event handlers run before paint, so
 * nothing lags a frame.
 *
 * CNR-7h interplay: the layout policy receiver toggles
 * `data-vt-hide-content-scrollbars` on `<html>`. This script's CSS keys on
 * that attribute: when it is set, the whole overlay layer hides and the
 * native-chrome hiding stops, so textareas fall back to their NATIVE
 * scrollbar (the `:not(textarea)` exemption in the builder's
 * FRAME_MOBILE_SCROLLBAR_STYLE re-hides everyone else's). On desktop the
 * custom overlay covers textareas too, with native chrome hidden — the
 * CNR-8n default-thin precedent for form fields. Visibility flips are pure
 * CSS attribute reactions: no document regeneration, no session impact.
 *
 * The thumb color comes from the `--vt-sb-thumb` token the builders bake from
 * the host's computed `--border2`; the neutral fallback below covers a missing
 * token. One derivation home: the builders read this constant, the script's
 * CSS carries it as the var() fallback.
 */

/** Neutral thumb color when the host theme token is absent. */
export const FRAME_SCROLLBAR_NEUTRAL_THUMB = "rgba(140,140,140,0.5)";

/**
 * The vanilla micro-scrollbar runtime, baked verbatim into both frame
 * documents next to the CNR-7h policy script. Pure inline JS + CSS: no
 * network, no module system, no host references. Runs immediately (injecting
 * the style before first paint) and wires the DOM on DOMContentLoaded.
 */
export const FRAME_MICRO_SCROLLBAR_SCRIPT = String.raw`(function () {
  'use strict';
  // Vibe Tavern frame micro-scrollbar (CNR-8q): vanilla overlay chrome for
  // every scroller in this opaque-origin document. Host CSS cannot cross the
  // sandbox boundary, so this script re-implements the app-wide lane contract
  // (invisible 5px grab lane, 3px thumb expanding to 5px on lane hover or
  // drag, paint-only) inside the frame. It never mutates user-owned elements:
  // native chrome is hidden by the CSS below and the custom lanes live in one
  // fixed overlay layer. The CNR-7h phone attribute only flips visibility.
  var LANE = 5;       // grab-lane thickness (px) - stable across hover and drag
  var MIN_THUMB = 20; // shortest draggable thumb (px)

  var doc = document;
  var css = [
    // Desktop: the overlay owns the affordance - native chrome hidden on
    // every element (textareas included; the CNR-8n default-thin precedent
    // for form fields). Scoped to :not([data-vt-hide-content-scrollbars]) so
    // the phone policy can hand native chrome back to textareas.
    'html:not([data-vt-hide-content-scrollbars]),html:not([data-vt-hide-content-scrollbars]) *{scrollbar-width:none!important}',
    'html:not([data-vt-hide-content-scrollbars])::-webkit-scrollbar,html:not([data-vt-hide-content-scrollbars]) *::-webkit-scrollbar{display:none!important}',
    // One fixed, click-through layer above all content; lanes re-enable hits.
    '.vt-sb-layer{position:fixed;top:0;right:0;bottom:0;left:0;pointer-events:none;z-index:2147483647}',
    // CNR-7h phone policy: every custom track hides with the layer; native
    // textareas keep their native chrome (see FRAME_MOBILE_SCROLLBAR_STYLE).
    'html[data-vt-hide-content-scrollbars] .vt-sb-layer{display:none}',
    // The invisible grab lane: a real, stable hit target (touch drags stay on
    // the lane instead of scrolling past it).
    '.vt-sb-lane{position:absolute;pointer-events:auto;touch-action:none}',
    '.vt-sb-lane[data-axis="v"]{width:5px}',
    '.vt-sb-lane[data-axis="h"]{height:5px}',
    // Thumb: 3px at rest, hugging the lane's outer edge, fully rounded,
    // colored by the baked --vt-sb-thumb theme token.
    '.vt-sb-thumb{position:absolute;border-radius:9999px;background:var(--vt-sb-thumb,${FRAME_SCROLLBAR_NEUTRAL_THUMB})}',
    '.vt-sb-lane[data-axis="v"]>.vt-sb-thumb{width:3px;right:0;transition:width 120ms ease-out}',
    '.vt-sb-lane[data-axis="h"]>.vt-sb-thumb{height:3px;bottom:0;transition:height 120ms ease-out}',
    // Expansion only for real pointers - touch never keeps a sticky 5px thumb.
    '@media (hover:hover){.vt-sb-lane[data-axis="v"]:hover>.vt-sb-thumb{width:5px}.vt-sb-lane[data-axis="h"]:hover>.vt-sb-thumb{height:5px}}',
    // Drag latch: 5px holds through the drag even if the pointer leaves the lane.
    '.vt-sb-lane[data-axis="v"][data-dragging]>.vt-sb-thumb{width:5px}',
    '.vt-sb-lane[data-axis="h"][data-dragging]>.vt-sb-thumb{height:5px}',
    // Reduced motion: every state stays reachable, just not animated.
    '@media (prefers-reduced-motion:reduce){.vt-sb-lane>.vt-sb-thumb{transition:none}}'
  ].join('\n');

  var styleEl = doc.createElement('style');
  styleEl.id = '__vt_micro_scrollbar_style';
  styleEl.textContent = css;
  (doc.head || doc.documentElement).appendChild(styleEl);

  function install() {
    if (!doc.body) return;
    var win = window;
    var layer = doc.createElement('div');
    layer.className = 'vt-sb-layer';
    layer.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(layer);

    var root = doc.scrollingElement || doc.documentElement;
    // One entry per tracked scroller: { el, v, h } where v/h are lane bundles
    // { lane, thumb, thumbPx } or null when that axis does not overflow.
    var entries = [];
    var raf = 0;
    var scanRaf = 0;

    function metrics(el, vertical) {
      if (vertical) {
        return {
          len: el.clientHeight, full: el.scrollHeight, pos: el.scrollTop,
          set: function (v) { el.scrollTop = v; },
        };
      }
      return {
        len: el.clientWidth, full: el.scrollWidth, pos: el.scrollLeft,
        set: function (v) { el.scrollLeft = v; },
      };
    }

    function makeLane(axis) {
      var lane = doc.createElement('div');
      lane.className = 'vt-sb-lane';
      lane.setAttribute('data-axis', axis);
      var thumb = doc.createElement('div');
      thumb.className = 'vt-sb-thumb';
      lane.appendChild(thumb);
      return { lane: lane, thumb: thumb, thumbPx: 0 };
    }

    function wireDrag(entry, axis) {
      var vertical = axis === 'v';
      var lane = entry[axis].lane;
      var drag = null;
      lane.addEventListener('pointerdown', function (ev) {
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        var bundle = entry[axis];
        var m = metrics(entry.el, vertical);
        var trackPx = vertical ? lane.offsetHeight : lane.offsetWidth;
        drag = {
          id: ev.pointerId,
          startPx: vertical ? ev.clientY : ev.clientX,
          startPos: m.pos,
          max: Math.max(0, m.full - m.len),
          span: Math.max(1, trackPx - bundle.thumbPx),
        };
        lane.setPointerCapture(ev.pointerId);
        lane.setAttribute('data-dragging', '');
        ev.preventDefault();
      });
      lane.addEventListener('pointermove', function (ev) {
        if (!drag || ev.pointerId !== drag.id) return;
        var m = metrics(entry.el, vertical);
        var delta = ((vertical ? ev.clientY : ev.clientX) - drag.startPx) / drag.span * drag.max;
        m.set(Math.max(0, Math.min(drag.max, drag.startPos + delta)));
      });
      function release(ev) {
        if (!drag || ev.pointerId !== drag.id) return;
        drag = null;
        lane.removeAttribute('data-dragging');
        if (lane.hasPointerCapture && lane.hasPointerCapture(ev.pointerId)) {
          lane.releasePointerCapture(ev.pointerId);
        }
      }
      lane.addEventListener('pointerup', release);
      lane.addEventListener('pointercancel', release);
    }

    function rectFor(el) {
      if (el === root) {
        return { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight };
      }
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    function updateAxis(entry, axis, rect) {
      var vertical = axis === 'v';
      var m = metrics(entry.el, vertical);
      var overflows = m.full - m.len > 1;
      var bundle = entry[axis];
      if (!overflows) {
        if (bundle) {
          bundle.lane.remove();
          entry[axis] = null;
        }
        return;
      }
      if (!bundle) {
        bundle = entry[axis] = makeLane(axis);
        layer.appendChild(bundle.lane);
        wireDrag(entry, axis);
      }
      if (vertical) {
        bundle.lane.style.left = (rect.left + rect.width - LANE) + 'px';
        bundle.lane.style.top = rect.top + 'px';
        bundle.lane.style.height = rect.height + 'px';
      } else {
        bundle.lane.style.top = (rect.top + rect.height - LANE) + 'px';
        bundle.lane.style.left = rect.left + 'px';
        bundle.lane.style.width = rect.width + 'px';
      }
      var track = vertical ? rect.height : rect.width;
      var thumbPx = Math.max(MIN_THUMB, Math.round(m.len / m.full * track));
      if (thumbPx > track) thumbPx = track;
      bundle.thumbPx = thumbPx;
      var max = Math.max(0, m.full - m.len);
      var frac = max > 0 ? m.pos / max : 0;
      if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
      var offset = Math.round(frac * (track - thumbPx));
      if (vertical) {
        bundle.thumb.style.height = thumbPx + 'px';
        bundle.thumb.style.top = offset + 'px';
      } else {
        bundle.thumb.style.width = thumbPx + 'px';
        bundle.thumb.style.left = offset + 'px';
      }
    }

    function update() {
      raf = 0;
      // A visual may replace <body>; the layer must stay in the live document.
      if (!layer.isConnected) {
        if (!doc.body) return;
        doc.body.appendChild(layer);
      }
      for (var i = 0; i < entries.length; i++) {
        var rect = rectFor(entries[i].el);
        updateAxis(entries[i], 'v', rect);
        updateAxis(entries[i], 'h', rect);
      }
    }

    function schedule() {
      if (!raf) raf = win.requestAnimationFrame(update);
    }

    function findEntry(el) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].el === el) return entries[i];
      }
      return null;
    }

    var ro = null;
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(function () { schedule(); });
    }

    function track(el, keep) {
      var entry = findEntry(el);
      if (!entry) {
        entry = { el: el, v: null, h: null };
        entries.push(entry);
        if (ro) ro.observe(el);
      }
      keep.push(entry);
    }

    function isCandidate(el) {
      if (el === layer || layer.contains(el)) return false;
      var cs = win.getComputedStyle(el);
      return cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay' ||
        cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'overlay';
    }

    function rescan() {
      if (!doc.body) return;
      var keep = [];
      // The root scroller is tracked unconditionally: the viewport scrolls
      // even with overflow:visible, and the phone policy needs its lane too.
      track(root, keep);
      var all = doc.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        // track() dedupes: an already-tracked scroller is only re-marked as
        // kept, so surviving candidates never churn through drop/re-add.
        if (isCandidate(el)) track(el, keep);
      }
      for (var j = entries.length - 1; j >= 0; j--) {
        var entry = entries[j];
        if (keep.indexOf(entry) === -1 || !entry.el.isConnected) {
          if (entry.v) entry.v.lane.remove();
          if (entry.h) entry.h.lane.remove();
          if (ro) ro.unobserve(entry.el);
          entries.splice(j, 1);
        }
      }
      update();
    }

    function rescanSoon() {
      if (!scanRaf) {
        scanRaf = win.requestAnimationFrame(function () { scanRaf = 0; rescan(); });
      }
    }

    // Scroll does not bubble, but capture hears every scroller in the
    // document; one coalesced pass per frame repositions thumbs AND lanes
    // shifted by an ancestor's scroll.
    doc.addEventListener('scroll', schedule, { capture: true, passive: true });
    win.addEventListener('resize', schedule);

    // Dynamic coverage: new elements, removed elements and class/style
    // changes (an authored visual may gain or lose a scroll region at any
    // time; the realtime loop mutates the DOM every tick). Mutations inside
    // the overlay layer are our own writes and are ignored; text-only edits
    // only move thumbs, they cannot create scrollers.
    if (typeof win.MutationObserver === 'function') {
      var mo = new win.MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes') {
            if (!layer.contains(m.target)) { rescanSoon(); return; }
          } else if (m.type === 'childList') {
            if (!layer.contains(m.target)) { rescanSoon(); return; }
          } else {
            schedule();
            return;
          }
        }
      });
      mo.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
        attributeFilter: ['class', 'style'],
      });
    }

    rescan();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();`;
