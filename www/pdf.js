/*
  PDF export without any library.
  Every page is drawn on a canvas (so Turkish characters and the app font work
  perfectly), turned into a JPEG, and embedded in a small hand-written PDF.
  On the phone the file is written in chunks (low memory) and shared with the
  system share sheet; in a browser it is downloaded.
*/
(function () {
  "use strict";
  var HD = window.HD = window.HD || {};

  var PAGE_W = 1240, PAGE_H = 1754;     // A4 at 150 dpi
  var MARGIN = 84, FOOTER_H = 50;
  var CONTENT_W = PAGE_W - 2 * MARGIN;
  var MAX_PHOTO_H = 760;
  var FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  var COLOR = { ink: "#111111", soft: "#6b6b70", line: "#cfcfd4" };

  // ---------------------------------------------------------------- PDF writer
  function strBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255;
    return out;
  }
  function pad10(n) { var s = String(n); while (s.length < 10) s = "0" + s; return s; }

  function PdfWriter(sink) {
    this.sink = sink;
    this.offset = 0;
    this.offsets = {};
    this.pages = [];
    this.nextObj = 3; // 1 = catalog, 2 = page tree
    this._write(strBytes("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
  }
  PdfWriter.prototype._write = function (bytes) {
    this.sink.write(bytes);
    this.offset += bytes.length;
  };
  PdfWriter.prototype._object = function (num, dict, stream) {
    this.offsets[num] = this.offset;
    if (stream) {
      this._write(strBytes(num + " 0 obj\n<< " + dict + " /Length " + stream.length + " >>\nstream\n"));
      this._write(stream);
      this._write(strBytes("\nendstream\nendobj\n"));
    } else {
      this._write(strBytes(num + " 0 obj\n<< " + dict + " >>\nendobj\n"));
    }
  };
  PdfWriter.prototype.addJpegPage = function (jpeg, wpx, hpx) {
    var pageNum = this.nextObj++, contentNum = this.nextObj++, imgNum = this.nextObj++;
    var W = 595.28, H = 841.89; // A4 in points
    this._object(imgNum, "/Type /XObject /Subtype /Image /Width " + wpx + " /Height " + hpx +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpeg);
    this._object(contentNum, "", strBytes("q " + W + " 0 0 " + H + " 0 0 cm /Im0 Do Q"));
    this._object(pageNum, "/Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "]" +
      " /Resources << /XObject << /Im0 " + imgNum + " 0 R >> >> /Contents " + contentNum + " 0 R");
    this.pages.push(pageNum);
  };
  PdfWriter.prototype.finish = function () {
    this._object(2, "/Type /Pages /Count " + this.pages.length + " /Kids [" +
      this.pages.map(function (n) { return n + " 0 R"; }).join(" ") + "]");
    this._object(1, "/Type /Catalog /Pages 2 0 R");
    var xrefPos = this.offset;
    var total = this.nextObj;
    var out = "xref\n0 " + total + "\n0000000000 65535 f \n";
    for (var n = 1; n < total; n++) out += pad10(this.offsets[n]) + " 00000 n \n";
    out += "trailer\n<< /Size " + total + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n";
    this._write(strBytes(out));
  };

  // -------------------------------------------------------------------- sinks
  function concat(chunks, len) {
    var all = new Uint8Array(len);
    var pos = 0;
    chunks.forEach(function (c) { all.set(c, pos); pos += c.length; });
    return all;
  }
  function toBase64(u8) {
    var out = "";
    var STEP = 30000; // multiple of 3, so slices join into one valid base64 string
    for (var i = 0; i < u8.length; i += STEP) {
      out += btoa(String.fromCharCode.apply(null, u8.subarray(i, i + STEP)));
    }
    return out;
  }
  function memorySink() {
    var chunks = [], len = 0;
    return {
      write: function (b) { chunks.push(b); len += b.length; },
      flush: function () { return Promise.resolve(); },
      bytes: function () { return concat(chunks, len); },
      blob: function () { return new Blob(chunks, { type: "application/pdf" }); }
    };
  }
  function nativeSink(FS, path) {
    var pending = [], pendingLen = 0, started = false;
    return {
      write: function (b) { pending.push(b); pendingLen += b.length; },
      flush: async function (force) {
        if (!pendingLen || (!force && pendingLen < 1000000)) return;
        var data = toBase64(concat(pending, pendingLen));
        pending = []; pendingLen = 0;
        if (!started) {
          await FS.writeFile({ path: path, data: data, directory: "CACHE", recursive: true });
          started = true;
        } else {
          await FS.appendFile({ path: path, data: data, directory: "CACHE" });
        }
      }
    };
  }

  // -------------------------------------------------------------- text layout
  function breakWord(ctx, word, maxW) {
    var parts = [], cur = "";
    for (var i = 0; i < word.length; i++) {
      var t = cur + word[i];
      if (cur && ctx.measureText(t).width > maxW) { parts.push(cur); cur = word[i]; }
      else cur = t;
    }
    if (cur) parts.push(cur);
    return parts;
  }

  // Splits text into lines that fit maxW (uses the font currently set on ctx).
  function wrapText(ctx, text, maxW) {
    var lines = [];
    String(text).split(/\r?\n/).forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(""); return; }
      var line = "";
      words.forEach(function (w) {
        var test = line ? line + " " + w : w;
        if (ctx.measureText(test).width <= maxW) { line = test; return; }
        if (line) { lines.push(line); line = ""; }
        if (ctx.measureText(w).width <= maxW) { line = w; return; }
        var parts = breakWord(ctx, w, maxW);
        for (var i = 0; i < parts.length - 1; i++) lines.push(parts[i]);
        line = parts[parts.length - 1];
      });
      if (line) lines.push(line);
    });
    return lines;
  }

  function fitText(ctx, text, maxW) {
    var t = String(text);
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  // ------------------------------------------------------------ page building
  function newPage() {
    var c = document.createElement("canvas");
    c.width = PAGE_W;
    c.height = PAGE_H;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.textBaseline = "top";
    return { c: c, ctx: ctx, y: MARGIN };
  }

  function canvasJpeg(c, quality) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (blob) {
        if (!blob) { reject(new Error("toBlob failed")); return; }
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, "image/jpeg", quality);
    });
  }

  function drawFooter(ctx, pageNo) {
    ctx.font = "400 22px " + FONT;
    ctx.fillStyle = COLOR.soft;
    ctx.textAlign = "center";
    ctx.fillText("Hata Defterim · Sayfa " + pageNo, PAGE_W / 2, PAGE_H - MARGIN + 6);
    ctx.textAlign = "left";
  }

  function divider(ctx, y) {
    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y);
    ctx.lineTo(PAGE_W - MARGIN, y);
    ctx.stroke();
  }

  async function loadScaled(file) {
    if (!file) return null;
    try {
      var src = await HD.getPhotoSrc(file);
      if (!src) return null;
      var img = await HD.loadImage(src);
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      var k = Math.min(CONTENT_W / iw, MAX_PHOTO_H / ih, 1);
      return { img: img, w: Math.round(iw * k), h: Math.round(ih * k) };
    } catch (e) {
      return null;
    }
  }

  function drawImageBlock(page, pic) {
    var x = MARGIN + Math.round((CONTENT_W - pic.w) / 2);
    page.ctx.drawImage(pic.img, x, page.y, pic.w, pic.h);
    page.ctx.strokeStyle = COLOR.line;
    page.ctx.lineWidth = 1;
    page.ctx.strokeRect(x, page.y, pic.w, pic.h);
  }

  function tagText(q) {
    var raw = Array.isArray(q.tags) ? q.tags.join(",") : String(q.tags || "");
    return raw.split(/[,;]+/).map(function (t) { return t.trim(); }).filter(Boolean)
      .map(function (t) { return "#" + t; }).join("   ");
  }

  // items: questions in print order. opts: { answers, solutions }. hooks: { aborted, progress, flush }
  async function build(items, opts, label, writer, hooks) {
    if (document.fonts && document.fonts.load) {
      try {
        await Promise.all([document.fonts.load("700 30px Inter"), document.fonts.load("400 26px Inter")]);
      } catch (e) {}
    }
    var measure = document.createElement("canvas").getContext("2d");
    var page = null, pageNo = 0;

    function startPage() { pageNo++; page = newPage(); }
    async function endPage() {
      drawFooter(page.ctx, pageNo);
      var jpeg = await canvasJpeg(page.c, 0.8);
      writer.addJpegPage(jpeg, PAGE_W, PAGE_H);
      page = null;
      await hooks.flush();
    }
    async function need(h) {
      if (page.y + h > PAGE_H - MARGIN - FOOTER_H) {
        await endPage();
        startPage();
      }
    }

    startPage();
    page.ctx.font = "800 56px " + FONT;
    page.ctx.fillStyle = COLOR.ink;
    page.ctx.fillText("Hata Defterim", MARGIN, page.y);
    page.y += 78;
    page.ctx.font = "400 28px " + FONT;
    page.ctx.fillStyle = COLOR.soft;
    page.ctx.fillText(fitText(page.ctx, label + " · " + items.length + " soru · " + HD.fmtDate(Date.now()), CONTENT_W), MARGIN, page.y);
    page.y += 56;
    divider(page.ctx, page.y);
    page.y += 40;

    var labelMap = HD.buildTopicLabelMap(HD.getQuestions());

    for (var i = 0; i < items.length; i++) {
      if (hooks.aborted()) throw new Error("aborted");
      var q = items[i];
      var pages = HD.photosOf(q);
      var photo = await loadScaled(pages[0]);

      // header + first photo stay together
      await need(58 + (photo ? photo.h + 24 : 0));
      var ctx = page.ctx;
      ctx.font = "700 30px " + FONT;
      ctx.fillStyle = COLOR.ink;
      var title = (q.subject || "Ders yok") + " › " + HD.displayTopicOf(q, labelMap);
      var dateStr = HD.fmtDate(q.createdAt);
      ctx.font = "400 24px " + FONT;
      var dateW = ctx.measureText(dateStr).width;
      ctx.font = "700 30px " + FONT;
      ctx.fillText(fitText(ctx, title, CONTENT_W - dateW - 24), MARGIN, page.y);
      ctx.font = "400 24px " + FONT;
      ctx.fillStyle = COLOR.soft;
      ctx.textAlign = "right";
      ctx.fillText(dateStr, PAGE_W - MARGIN, page.y + 5);
      ctx.textAlign = "left";
      page.y += 58;
      if (photo) {
        drawImageBlock(page, photo);
        page.y += photo.h + 24;
      }
      for (var pi = 1; pi < pages.length; pi++) { // extra pages of long questions
        var extra = await loadScaled(pages[pi]);
        if (!extra) continue;
        await need(extra.h + 24);
        drawImageBlock(page, extra);
        page.y += extra.h + 24;
      }

      if (opts.answers) {
        var ans = [];
        if (q.myAnswer) ans.push("Benim cevabım: " + q.myAnswer);
        if (q.correctAnswer) ans.push("Doğru cevap: " + q.correctAnswer);
        if (ans.length) {
          await need(46);
          page.ctx.font = "700 28px " + FONT;
          page.ctx.fillStyle = COLOR.ink;
          page.ctx.fillText(fitText(page.ctx, ans.join("        "), CONTENT_W), MARGIN, page.y);
          page.y += 46;
        }
        if (q.note) {
          measure.font = "400 26px " + FONT;
          var lines = wrapText(measure, "Not: " + q.note, CONTENT_W);
          for (var li = 0; li < lines.length; li++) {
            await need(36);
            page.ctx.font = "400 26px " + FONT;
            page.ctx.fillStyle = COLOR.ink;
            page.ctx.fillText(lines[li], MARGIN, page.y);
            page.y += 36;
          }
          page.y += 8;
        }
        var tags = tagText(q);
        if (tags) {
          await need(38);
          page.ctx.font = "400 24px " + FONT;
          page.ctx.fillStyle = COLOR.soft;
          page.ctx.fillText(fitText(page.ctx, tags, CONTENT_W), MARGIN, page.y);
          page.y += 38;
        }
      }

      if (opts.solutions && q.solutionFile) {
        var sol = await loadScaled(q.solutionFile);
        if (sol) {
          await need(44 + sol.h + 16);
          page.ctx.font = "700 26px " + FONT;
          page.ctx.fillStyle = COLOR.soft;
          page.ctx.fillText("Çözüm", MARGIN, page.y);
          page.y += 40;
          drawImageBlock(page, sol);
          page.y += sol.h + 16;
        }
      }

      await need(40);
      divider(page.ctx, page.y + 6);
      page.y += 40;
      hooks.progress(i + 1, items.length);
    }
    await endPage();
    return pageNo;
  }

  // ------------------------------------------------------------- file output
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }

  async function generate(items, opts, label, hooks) {
    var FS = HD.Plugins && HD.Plugins.Filesystem;
    var native = HD.isNative && FS;
    var name = "hata-defterim-" + stamp() + ".pdf";
    var path = "exports/" + name;
    var sink;
    if (native) {
      try { await FS.rmdir({ path: "exports", directory: "CACHE", recursive: true }); } catch (e) {}
      sink = nativeSink(FS, path);
    } else {
      sink = memorySink();
    }
    hooks.flush = function () { return sink.flush(false); };
    var writer = new PdfWriter(sink);
    await build(items, opts, label, writer, hooks);
    writer.finish();
    await sink.flush(true);
    var pages = writer.pages.length;
    if (native) {
      var res = await FS.getUri({ path: path, directory: "CACHE" });
      return { uri: res.uri, name: name, pages: pages };
    }
    return { blob: sink.blob(), name: name, pages: pages };
  }

  async function deliver(res) {
    if (res.blob) {
      var a = document.createElement("a");
      var url = URL.createObjectURL(res.blob);
      a.href = url;
      a.download = res.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      return { ok: true };
    }
    var Share = HD.Plugins && HD.Plugins.Share;
    if (!Share) {
      return { ok: false, message: "Paylaşma eklentisi bulunamadı. `npm install` ve `npx cap sync android` çalıştırıp uygulamayı yeniden yükle." };
    }
    try {
      await Share.share({ title: "Hata Defterim", text: "Hata Defterim PDF", url: res.uri, dialogTitle: "PDF'i kaydet veya paylaş" });
      return { ok: true };
    } catch (e) {
      return { ok: true }; // the person closed the share sheet
    }
  }

  // ---------------------------------------------------------------------- UI
  function open() {
    var qs = HD.getQuestions();
    if (!qs.length) {
      HD.openPanel("PDF'e Aktar", '<p class="hint">PDF için önce birkaç soru eklemelisin.</p>', { back: true });
      return;
    }
    var cur = HD.filteredQuestions();
    var scope = HD.currentScopeLabel();
    var html =
      '<div class="field"><label>Kapsam</label><select class="sel" id="pdfScope">' +
      '<option value="current">Şu anki liste: ' + HD.esc(scope) + " (" + cur.length + " soru)</option>" +
      '<option value="all">Tüm defter (' + qs.length + " soru)</option></select></div>" +
      '<label class="check-row"><input type="checkbox" id="pdfAnswers" checked> Cevap ve notları ekle</label>' +
      '<label class="check-row"><input type="checkbox" id="pdfSolutions" checked> Çözüm fotoğraflarını ekle</label>' +
      '<label class="check-row"><input type="checkbox" id="pdfDue"> Sadece tekrar gerekenler</label>' +
      '<label class="check-row"><input type="checkbox" id="pdfStar"> Sadece yıldızlılar</label>' +
      '<p class="form-err" id="pdfErr" hidden></p>' +
      '<button type="button" class="btn primary block" id="pdfStart">PDF Oluştur</button>';
    HD.openPanel("PDF'e Aktar", html, { back: true });
    document.getElementById("pdfStart").addEventListener("click", function () {
      var all = document.getElementById("pdfScope").value === "all";
      var list = all ? qs : cur;
      if (document.getElementById("pdfDue").checked) list = list.filter(HD.isDue);
      if (document.getElementById("pdfStar").checked) list = list.filter(function (q) { return q.starred; });
      if (!list.length) {
        var err = document.getElementById("pdfErr");
        err.textContent = "Bu seçimde soru yok.";
        err.hidden = false;
        return;
      }
      run(HD.sortForNotebook(list), {
        answers: document.getElementById("pdfAnswers").checked,
        solutions: document.getElementById("pdfSolutions").checked
      }, all ? "Tüm defter" : scope);
    });
  }

  async function run(items, opts, label) {
    var state = { aborted: false };
    HD.setPanel("PDF hazırlanıyor",
      '<p class="hint" id="pdfMsg">Sayfalar hazırlanıyor…</p><div class="progress"><div id="pdfBar"></div></div>' +
      '<button type="button" class="btn sm ghost" id="pdfCancel">İptal</button>',
      { onClose: function () { state.aborted = true; } });
    document.getElementById("pdfCancel").addEventListener("click", function () { HD.closePanel(false); });
    var hooks = {
      aborted: function () { return state.aborted; },
      progress: function (i, n) {
        var bar = document.getElementById("pdfBar");
        var msg = document.getElementById("pdfMsg");
        if (bar) bar.style.width = Math.round((i / n) * 100) + "%";
        if (msg) msg.textContent = i + " / " + n + " soru işlendi…";
      },
      flush: function () { return Promise.resolve(); }
    };
    try {
      var res = await generate(items, opts, label, hooks);
      if (state.aborted) return;
      var d = await deliver(res);
      HD.setPanel("PDF hazır",
        '<p class="confirm-text">' + res.pages + " sayfalık PDF oluşturuldu." + (d.ok ? "" : " " + HD.esc(d.message || "")) + "</p>" +
        '<button type="button" class="btn primary block" id="pdfAgain">Paylaş / Kaydet</button>',
        { back: true, onClose: null });
      document.getElementById("pdfAgain").addEventListener("click", function () { deliver(res); });
    } catch (e) {
      if (state.aborted || (e && e.message === "aborted")) return;
      console.error("pdf failed", e);
      HD.setPanel("PDF oluşturulamadı",
        '<p class="confirm-text">Bir sorun çıktı. Daha az soruyla tekrar dene.</p>',
        { back: true, onClose: null });
    }
  }

  HD.pdf = { open: open, _PdfWriter: PdfWriter, _wrapText: wrapText, _memorySink: memorySink, _build: build, _toBase64: toBase64 };
})();
