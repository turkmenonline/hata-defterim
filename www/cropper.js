/*
  Photo cropper: shows a full-screen editor where the person can drag a crop
  rectangle (move / resize from corners and edges) and rotate the picture.
  HD.crop.open(canvas) resolves a new canvas (cropped) or null (cancelled).
*/
(function () {
  "use strict";
  var HD = window.HD = window.HD || {};

  var HANDLE_R = 30; // touch radius around corners/edges (px)
  var MIN_SIZE = 56; // smallest crop rectangle (px)

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ----- pure geometry (unit tested) -----
  // rect = { x, y, w, h } in display pixels. Returns the drag mode under the pointer.
  function hitTest(rect, px, py, r) {
    var L = rect.x, T = rect.y, R = rect.x + rect.w, B = rect.y + rect.h;
    var nearL = Math.abs(px - L) <= r, nearR = Math.abs(px - R) <= r;
    var nearT = Math.abs(py - T) <= r, nearB = Math.abs(py - B) <= r;
    var inX = px >= L - r && px <= R + r, inY = py >= T - r && py <= B + r;
    if (nearL && nearT) return "nw";
    if (nearR && nearT) return "ne";
    if (nearL && nearB) return "sw";
    if (nearR && nearB) return "se";
    if (nearT && inX) return "n";
    if (nearB && inX) return "s";
    if (nearL && inY) return "w";
    if (nearR && inY) return "e";
    if (px > L && px < R && py > T && py < B) return "move";
    return null;
  }

  function applyDrag(mode, rect, dx, dy, bounds, min) {
    var L = rect.x, T = rect.y, R = rect.x + rect.w, B = rect.y + rect.h;
    if (mode === "move") {
      return {
        x: clamp(L + dx, 0, Math.max(0, bounds.w - rect.w)),
        y: clamp(T + dy, 0, Math.max(0, bounds.h - rect.h)),
        w: rect.w,
        h: rect.h
      };
    }
    if (mode.indexOf("w") !== -1) L = clamp(L + dx, 0, R - min);
    if (mode.indexOf("e") !== -1) R = clamp(R + dx, L + min, bounds.w);
    if (mode.indexOf("n") !== -1) T = clamp(T + dy, 0, B - min);
    if (mode.indexOf("s") !== -1) B = clamp(B + dy, T + min, bounds.h);
    return { x: L, y: T, w: R - L, h: B - T };
  }

  // ----- editor state -----
  var src = null;        // source canvas (rotations are applied to it)
  var rect = null;       // crop rectangle in SOURCE pixels
  var scale = 1;         // display px per source px
  var drag = null;
  var resolveFn = null;

  function screenEl() { return document.getElementById("cropScreen"); }

  function toDisplay(r) { return { x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale }; }
  function fromDisplay(r) { return { x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }; }

  function layout() {
    var stage = document.getElementById("cropStage");
    var canvas = document.getElementById("cropCanvas");
    if (!stage || !canvas || !src) return;
    var availW = (stage.clientWidth || window.innerWidth || 360) - 12;
    var availH = (stage.clientHeight || (window.innerHeight || 640) * 0.6) - 12;
    scale = Math.min(availW / src.width, availH / src.height);
    var cw = Math.max(1, Math.round(src.width * scale));
    var ch = Math.max(1, Math.round(src.height * scale));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    canvas._dpr = dpr;
    canvas._cw = cw;
    canvas._ch = ch;
    draw();
  }

  function draw() {
    var canvas = document.getElementById("cropCanvas");
    if (!canvas || !src || !rect) return;
    var ctx = canvas.getContext("2d");
    var cw = canvas._cw, ch = canvas._ch, dpr = canvas._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);
    var r = toDisplay(rect);
    ctx.fillStyle = "rgba(0,0,0,.58)";
    ctx.fillRect(0, 0, cw, r.y);
    ctx.fillRect(0, r.y + r.h, cw, ch - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, cw - r.x - r.w, r.h);
    // rule-of-thirds guides
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 1; i < 3; i++) {
      ctx.moveTo(r.x + (r.w * i) / 3, r.y); ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
      ctx.moveTo(r.x, r.y + (r.h * i) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    }
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    // handles
    ctx.fillStyle = "#ffffff";
    var s = 12, xs = [r.x, r.x + r.w / 2, r.x + r.w], ys = [r.y, r.y + r.h / 2, r.y + r.h];
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        if (a === 1 && b === 1) continue;
        ctx.fillRect(xs[a] - s / 2, ys[b] - s / 2, s, s);
      }
    }
  }

  function pointerPos(e) {
    var canvas = document.getElementById("cropCanvas");
    var box = canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  function onDown(e) {
    if (!rect) return;
    var p = pointerPos(e);
    var mode = hitTest(toDisplay(rect), p.x, p.y, HANDLE_R);
    if (!mode) return;
    drag = { mode: mode, start: toDisplay(rect), x: p.x, y: p.y };
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    var canvas = document.getElementById("cropCanvas");
    var p = pointerPos(e);
    var next = applyDrag(drag.mode, drag.start, p.x - drag.x, p.y - drag.y, { w: canvas._cw, h: canvas._ch }, MIN_SIZE);
    rect = fromDisplay(next);
    draw();
    e.preventDefault();
  }

  function onUp() { drag = null; }

  function initialRect() {
    var mx = src.width * 0.05, my = src.height * 0.05;
    return { x: mx, y: my, w: src.width - 2 * mx, h: src.height - 2 * my };
  }

  function rotate() {
    if (!src) return;
    var c = document.createElement("canvas");
    c.width = src.height;
    c.height = src.width;
    var ctx = c.getContext("2d");
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);
    src = c;
    rect = initialRect();
    layout();
  }

  function cropped() {
    var w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
    var out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    var ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, Math.round(rect.x), Math.round(rect.y), w, h, 0, 0, w, h);
    return out;
  }

  function finish(result) {
    if (!resolveFn) return;
    var done = resolveFn;
    resolveFn = null;
    var el = screenEl();
    el.hidden = true;
    el.innerHTML = "";
    window.removeEventListener("resize", layout);
    var out = result;
    src = null;
    rect = null;
    drag = null;
    done(out);
    var st = history.state;
    if (st && st.overlay === "crop") history.back(); // the popstate handler ignores the already-hidden screen
  }

  function open(canvas) {
    return new Promise(function (resolve) {
      if (resolveFn) { resolve(null); return; }
      resolveFn = resolve;
      src = canvas;
      rect = initialRect();
      var el = screenEl();
      el.innerHTML =
        '<div class="crop-head">' +
        '<button type="button" class="btn sm" id="cropCancel">Vazgeç</button>' +
        '<span style="font-weight:600;">Fotoğrafı Kırp</span>' +
        '<button type="button" class="btn sm" id="cropRotate">↻ Döndür</button>' +
        "</div>" +
        '<div class="crop-stage" id="cropStage"><canvas id="cropCanvas"></canvas></div>' +
        '<div class="crop-foot">' +
        '<button type="button" class="btn" id="cropFull">Olduğu gibi kullan</button>' +
        '<button type="button" class="btn primary" id="cropOk">Kırp ve Kaydet</button>' +
        "</div>";
      el.hidden = false;
      HD.pushOverlayState("crop");

      document.getElementById("cropCancel").addEventListener("click", function () { finish(null); });
      document.getElementById("cropRotate").addEventListener("click", rotate);
      document.getElementById("cropFull").addEventListener("click", function () { finish(src); });
      document.getElementById("cropOk").addEventListener("click", function () { finish(cropped()); });
      var canvasEl = document.getElementById("cropCanvas");
      canvasEl.addEventListener("pointerdown", onDown);
      canvasEl.addEventListener("pointermove", onMove);
      canvasEl.addEventListener("pointerup", onUp);
      canvasEl.addEventListener("pointercancel", onUp);
      window.addEventListener("resize", layout);
      // layout after the screen is visible so the stage has its real size
      if (window.requestAnimationFrame) window.requestAnimationFrame(layout);
      else layout();
    });
  }

  // Called by the back button (popstate): behaves like "Vazgeç".
  function cancel() { finish(null); }

  HD.crop = { open: open, cancel: cancel, _pure: { hitTest: hitTest, applyDrag: applyDrag } };
})();
