/*
  Text recognition (OCR) with the optional @capacitor-mlkit/text-recognition plugin.
  The text read from a question photo is stored in question.ocrText and is used by the
  search box. Everything here is a no-op when the plugin is not installed.
*/
(function () {
  "use strict";
  var HD = window.HD = window.HD || {};

  var MAX_TEXT = 4000;
  var queue = Promise.resolve();

  function plugin() {
    var P = HD.Plugins || (window.Capacitor && window.Capacitor.Plugins) || {};
    return P.TextRecognition || null;
  }

  function available() {
    return !!(HD.isNative && plugin());
  }

  function unavailableMessage() {
    return HD.isNative
      ? "Yazı okuma eklentisi yüklü değil. Proje klasöründe `npm install @capacitor-mlkit/text-recognition` ve `npx cap sync android` çalıştırıp uygulamayı yeniden yükle."
      : "Yazı okuma yalnızca Android uygulamasında çalışır.";
  }

  // Pulls the plain text out of whatever shape the plugin returns.
  function extractText(res) {
    if (!res) return "";
    if (typeof res.text === "string" && res.text.trim()) return res.text;
    var blocks = res.textBlocks || res.blocks || [];
    return blocks.map(function (b) { return (b && (b.text || "")) || ""; }).filter(Boolean).join("\n");
  }

  async function recognizeFile(file) {
    var P = plugin();
    var FS = HD.Plugins && HD.Plugins.Filesystem;
    if (!P || !FS || !file) return "";
    var uri = (await FS.getUri({ path: "photos/" + file, directory: "DATA" })).uri;
    var fn = P.processImage || P.recognize || P.recognizeText;
    if (!fn) throw new Error("TextRecognition has no processImage method");
    var res = await fn.call(P, { path: uri });
    return extractText(res).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
  }

  // Reads the text of one question (all its pages) and stores it. Runs one at a time.
  function runForQuestion(id) {
    var job = queue.then(async function () {
      var q = HD.getQuestions().filter(function (x) { return x.id === id; })[0];
      if (!q || !available()) return false;
      var texts = [];
      var pages = HD.photosOf(q);
      for (var i = 0; i < pages.length; i++) {
        try {
          var t = await recognizeFile(pages[i]);
          if (t) texts.push(t);
        } catch (e) {
          console.warn("ocr failed for page", e);
        }
      }
      var joined = texts.join("\n\n").slice(0, MAX_TEXT);
      await HD.updateQuestion(id, { ocrText: joined, ocrDone: true });
      return !!joined;
    });
    queue = job.catch(function () {});
    return job;
  }

  // Scans every question that has a photo but has not been scanned yet.
  async function runBatch(onProgress) {
    var todo = HD.getQuestions().filter(function (q) { return q.photoFile && !q.ocrDone; });
    var read = 0;
    for (var i = 0; i < todo.length; i++) {
      if (await runForQuestion(todo[i].id)) read++;
      if (onProgress) onProgress(i + 1, todo.length);
    }
    return { total: todo.length, read: read };
  }

  HD.ocr = {
    available: available,
    unavailableMessage: unavailableMessage,
    runForQuestion: runForQuestion,
    runBatch: runBatch,
    _extractText: extractText
  };
})();
