// nexis wiki — click-to-zoom for Mermaid diagrams.
//
// astro-mermaid renders each diagram as `<pre class="mermaid" data-processed>`
// containing an <svg>. This script (loaded site-wide via Starlight's `head`
// config) opens any clicked diagram in a fullscreen lightbox with wheel/pinch
// zoom and drag-to-pan. Fully self-contained — no external dependencies, works
// offline. Uses event delegation so it also covers diagrams re-rendered on a
// light/dark theme switch.
//
// Transform model: the stage uses `transform-origin: 0 0` and is positioned at
// the overlay's top-left, so `translate(tx,ty) scale(s)` composes cleanly and
// the zoom-about-a-point math below is exact. (Getting this wrong — e.g. a
// centered transform-origin — makes "+" appear to fling the diagram into a
// corner instead of zooming.)
(function () {
  'use strict';
  if (window.__nexisMermaidZoom) return;
  window.__nexisMermaidZoom = true;

  var MIN = 0.05;
  var MAX = 16;

  function openLightbox(sourceSvg) {
    var overlay = document.createElement('div');
    overlay.className = 'nexis-zoom-overlay';

    var stage = document.createElement('div');
    stage.className = 'nexis-zoom-stage';
    var svg = sourceSvg.cloneNode(true);
    // Neutralize the page copy's inline sizing so the diagram renders at its
    // natural dimensions; we drive size purely through the stage transform.
    svg.removeAttribute('style');
    svg.style.display = 'block';
    stage.appendChild(svg);
    overlay.appendChild(stage);

    var toolbar = document.createElement('div');
    toolbar.className = 'nexis-zoom-toolbar';
    toolbar.innerHTML =
      '<button data-act="in" title="Zoom in" aria-label="Zoom in">+</button>' +
      '<button data-act="out" title="Zoom out" aria-label="Zoom out">−</button>' +
      '<button data-act="reset" title="Fit to screen" aria-label="Fit to screen">⤢</button>' +
      '<button data-act="close" title="Close (Esc)" aria-label="Close">✕</button>';
    overlay.appendChild(toolbar);

    var hint = document.createElement('div');
    hint.className = 'nexis-zoom-hint';
    hint.textContent = 'scroll to zoom · drag to pan · Esc to close';
    overlay.appendChild(hint);

    document.body.appendChild(overlay);

    // ---- natural size of the diagram (viewBox is the reliable source) --------
    var baseW = 0, baseH = 0;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width && vb.height) {
      baseW = vb.width;
      baseH = vb.height;
    } else {
      var r = svg.getBoundingClientRect();
      baseW = r.width || 800;
      baseH = r.height || 600;
    }
    // Pin the SVG to its natural pixel size; the stage transform does the rest.
    svg.setAttribute('width', baseW);
    svg.setAttribute('height', baseH);
    svg.style.maxWidth = 'none';

    var scale = 1, tx = 0, ty = 0, fitScale = 1;

    function apply() {
      stage.style.transform =
        'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }
    function clamp(s) { return Math.min(MAX, Math.max(MIN, s)); }

    function fit() {
      var vw = overlay.clientWidth;
      var vh = overlay.clientHeight;
      // fill ~92% of the viewport; allow enlarging small diagrams too
      fitScale = Math.min((vw * 0.92) / baseW, (vh * 0.9) / baseH);
      scale = clamp(fitScale);
      tx = (vw - baseW * scale) / 2;
      ty = (vh - baseH * scale) / 2;
      apply();
    }

    function zoomAt(factor, cx, cy) {
      var next = clamp(scale * factor);
      var ratio = next / scale;
      // keep the point (cx,cy) fixed on screen while scaling about origin 0,0
      tx = cx - ratio * (cx - tx);
      ty = cy - ratio * (cy - ty);
      scale = next;
      apply();
    }
    function viewportCenter() {
      return { x: overlay.clientWidth / 2, y: overlay.clientHeight / 2 };
    }

    overlay.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var rect = overlay.getBoundingClientRect();
        zoomAt(
          e.deltaY < 0 ? 1.15 : 1 / 1.15,
          e.clientX - rect.left,
          e.clientY - rect.top
        );
      },
      { passive: false }
    );

    var dragging = false, lastX = 0, lastY = 0;
    stage.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    stage.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      tx += e.clientX - lastX;
      ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    });
    function endDrag() { dragging = false; }
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    function close() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      overlay.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') { var a = viewportCenter(); zoomAt(1.25, a.x, a.y); }
      else if (e.key === '-' || e.key === '_') { var b = viewportCenter(); zoomAt(1 / 1.25, b.x, b.y); }
      else if (e.key === '0') fit();
    }
    var resizeTimer;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 120);
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close(); // click the backdrop to dismiss
    });
    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      var act = btn && btn.getAttribute('data-act');
      if (!act) return;
      var c = viewportCenter();
      if (act === 'in') zoomAt(1.3, c.x, c.y);
      else if (act === 'out') zoomAt(1 / 1.3, c.x, c.y);
      else if (act === 'reset') fit();
      else if (act === 'close') close();
    });

    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    fit(); // initial fit-to-screen (must run after the SVG is in the DOM)
  }

  document.addEventListener('click', function (e) {
    var pre = e.target.closest && e.target.closest('pre.mermaid[data-processed]');
    if (!pre) return;
    var svg = pre.querySelector('svg');
    if (svg) openLightbox(svg);
  });
})();
