/**
 * Preview inspector script (v1.12 Phase 4) — runs INSIDE the previewed
 * iframe. Injected by the parent at iframe-load time as a same-origin
 * `<script>` (the reverse proxy makes preview same-origin) so it can attach
 * DOM listeners directly without postMessage indirection for capture.
 *
 * Protocol (parent ↔ frame):
 *   parent → frame:  { kind: 'harness:set-edit-mode', value: boolean }
 *   frame  → parent: { kind: 'harness:pick', selector, rect, html, version }
 *
 * Keep the body small and dependency-free: it is shipped to the iframe as a
 * raw JS string and evaluated there, so no TS / imports / closures over
 * module state in the bundle are visible to it.
 */
export const INSPECTOR_VERSION = '2';

export const INSPECTOR_SCRIPT = `(function() {
  if (window.__harnessInspector) return;
  window.__harnessInspector = true;
  var editMode = false;
  var outline = null;
  var label = null;

  function ensureOverlay() {
    if (outline) return;
    outline = document.createElement('div');
    outline.setAttribute('data-harness-overlay', '1');
    outline.style.position = 'fixed';
    outline.style.pointerEvents = 'none';
    outline.style.border = '2px solid #2563eb';
    outline.style.background = 'rgba(37,99,235,0.08)';
    outline.style.zIndex = '2147483646';
    outline.style.transition = 'all 60ms ease-out';
    outline.style.display = 'none';
    label = document.createElement('div');
    label.setAttribute('data-harness-overlay', '1');
    label.style.position = 'fixed';
    label.style.pointerEvents = 'none';
    label.style.background = '#2563eb';
    label.style.color = '#fff';
    label.style.font = '11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace';
    label.style.padding = '2px 6px';
    label.style.borderRadius = '3px';
    label.style.zIndex = '2147483647';
    label.style.display = 'none';
    document.body.appendChild(outline);
    document.body.appendChild(label);
  }

  function hideOverlay() {
    if (outline) outline.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  function isOverlay(el) {
    return el && el.getAttribute && el.getAttribute('data-harness-overlay') === '1';
  }

  function anchorFor(node) {
    if (!node.getAttribute) return null;
    var tid = node.getAttribute('data-testid');
    if (tid && /^[\\w-]+$/.test(tid)) return '[data-testid="' + tid + '"]';
    if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) return '#' + node.id;
    return null;
  }

  function buildSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    var anchor = anchorFor(el);
    if (anchor) return anchor;
    var aria = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (aria && /^[\\w-]+$/.test(aria)) {
      var ariaSel = '[aria-label="' + aria + '"]';
      try {
        if (document.querySelectorAll(ariaSel).length === 1) return ariaSel;
      } catch (_) {
        /* ignore */
      }
    }
    // Fallback: absolute tag:nth-of-type path — deliberately WITHOUT class
    // names (vite/tailwind class hashes change between builds), anchored at
    // the nearest ancestor that has a stable data-testid / id.
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var tag = node.tagName.toLowerCase();
      var nth = '';
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (s) {
          return s.tagName === node.tagName;
        });
        if (siblings.length > 1) nth = ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(tag + nth);
      node = parent;
      if (node && node !== document.body && node.nodeType === 1) {
        var a = anchorFor(node);
        if (a) {
          parts.unshift(a);
          return parts.join(' > ');
        }
      }
    }
    return 'body > ' + parts.join(' > ');
  }

  function paintOverlay(target) {
    ensureOverlay();
    var rect = target.getBoundingClientRect();
    outline.style.left = rect.left + 'px';
    outline.style.top = rect.top + 'px';
    outline.style.width = rect.width + 'px';
    outline.style.height = rect.height + 'px';
    outline.style.display = 'block';
    label.textContent = buildSelector(target);
    label.style.left = rect.left + 'px';
    var labelTop = rect.top - 18;
    if (labelTop < 0) labelTop = rect.top + 2;
    label.style.top = labelTop + 'px';
    label.style.display = 'block';
  }

  document.addEventListener(
    'mouseover',
    function (e) {
      if (!editMode) return;
      var t = e.target;
      if (!t || isOverlay(t)) return;
      paintOverlay(t);
    },
    true
  );

  document.addEventListener(
    'mouseout',
    function (e) {
      if (!editMode) return;
      hideOverlay();
    },
    true
  );

  document.addEventListener(
    'click',
    function (e) {
      if (!editMode) return;
      var t = e.target;
      if (!t || isOverlay(t)) return;
      e.preventDefault();
      e.stopPropagation();
      var rect = t.getBoundingClientRect();
      var payload = {
        kind: 'harness:pick',
        selector: buildSelector(t),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        html: (t.outerHTML || '').slice(0, 500),
        version: '${INSPECTOR_VERSION}',
      };
      try {
        // The preview iframe is served by the dashboard via the reverse
        // proxy at /preview/<projectId>/, so it shares an origin with the
        // parent. Posting to a specific origin instead of '*' prevents a
        // third-party page that frames the dashboard from receiving the
        // DOM inspection payload (selector + clipped outerHTML + click
        // coordinates).
        window.parent.postMessage(payload, window.location.origin);
      } catch (_) {
        /* ignore */
      }
    },
    true
  );

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'harness:set-edit-mode') {
      editMode = !!data.value;
      if (!editMode) hideOverlay();
    }
  });
})();`;
