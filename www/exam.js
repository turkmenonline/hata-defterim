/*
  Exam mode: pick subject/topic, number of questions and a time limit, then
  go through random questions. Each answer ("Doğru yaptım" / "Yanlış yaptım")
  updates the spaced-repetition schedule and the statistics, like normal review.
*/
(function () {
  "use strict";
  var HD = window.HD = window.HD || {};

  // ----- pure helpers (unit tested) -----
  function shuffle(arr, rnd) {
    var a = arr.slice();
    var r = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // opts = { subject: "", topic: "", dueOnly: false }; deps = { isDue, subjectKey, topicKey }
  function buildPool(questions, opts, deps) {
    return questions.filter(function (q) {
      if (opts.subject && deps.subjectKey(q.subject) !== deps.subjectKey(opts.subject)) return false;
      if (opts.topic && deps.topicKey(q.topic) !== opts.topic) return false;
      if (opts.dueOnly && !deps.isDue(q)) return false;
      return true;
    });
  }

  function pickQuestions(pool, count, rnd) {
    var s = shuffle(pool, rnd);
    return count > 0 ? s.slice(0, count) : s;
  }

  function fmtClock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(total / 60), s = total % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ----- state -----
  var S = null;          // running exam
  var timer = null;
  var lastCfg = { subject: "", topic: "", dueOnly: false, count: 10, minutes: 0 };

  function deps() {
    return { isDue: HD.isDue, subjectKey: HD.subjectKey, topicKey: HD.topicKey };
  }

  function subjectsList() {
    var seen = {}, out = [];
    HD.getQuestions().forEach(function (q) {
      var k = HD.subjectKey(q.subject);
      if (q.subject && !seen[k]) { seen[k] = true; out.push(q.subject); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b, "tr"); });
  }

  function topicsFor(subject) {
    var labelMap = HD.buildTopicLabelMap(HD.getQuestions());
    var seen = {}, out = [];
    HD.getQuestions().forEach(function (q) {
      if (subject && HD.subjectKey(q.subject) !== HD.subjectKey(subject)) return;
      var k = HD.topicKey(q.topic);
      if (!seen[k]) { seen[k] = true; out.push({ key: k, label: labelMap[k] || "Konusuz" }); }
    });
    return out.sort(function (a, b) { return a.label.localeCompare(b.label, "tr"); });
  }

  function options(list, selected) {
    return list.map(function (o) {
      return '<option value="' + HD.esc(o[0]) + '"' + (String(o[0]) === String(selected) ? " selected" : "") + ">" + HD.esc(o[1]) + "</option>";
    }).join("");
  }

  // ----- setup panel -----
  function open() {
    var qs = HD.getQuestions();
    if (!qs.length) {
      HD.openPanel("Sınav Modu", '<p class="hint">Sınav için önce birkaç soru eklemelisin.</p>', { back: true });
      return;
    }
    var subjOpts = [["", "Tüm dersler"]].concat(subjectsList().map(function (s) { return [s, s]; }));
    var html =
      '<div class="field"><label>Ders</label><select class="sel" id="exSubject">' + options(subjOpts, lastCfg.subject) + "</select></div>" +
      '<div class="field"><label>Konu</label><select class="sel" id="exTopic"></select></div>' +
      '<div class="field"><label>Sorular</label><select class="sel" id="exSource">' +
      options([["all", "Tüm sorular"], ["due", "Sadece tekrar zamanı gelenler"]], lastCfg.dueOnly ? "due" : "all") + "</select></div>" +
      '<div class="two-col">' +
      '<div class="field"><label>Soru sayısı</label><select class="sel" id="exCount">' +
      options([[5, "5"], [10, "10"], [20, "20"], [30, "30"], [50, "50"], [0, "Hepsi"]], lastCfg.count) + "</select></div>" +
      '<div class="field"><label>Süre</label><select class="sel" id="exMinutes">' +
      options([[0, "Süresiz"], [5, "5 dk"], [10, "10 dk"], [15, "15 dk"], [20, "20 dk"], [30, "30 dk"], [45, "45 dk"], [60, "60 dk"]], lastCfg.minutes) + "</select></div>" +
      "</div>" +
      '<p class="hint" id="exInfo"></p>' +
      '<p class="form-err" id="exErr" hidden></p>' +
      '<button type="button" class="btn primary block" id="exStart">Sınavı Başlat</button>';
    HD.openPanel("Sınav Modu", html, { back: true });

    function fillTopics() {
      var subj = document.getElementById("exSubject").value;
      var list = [["", "Tüm konular"]].concat(topicsFor(subj).map(function (t) { return [t.key, t.label]; }));
      var keep = list.some(function (o) { return o[0] === lastCfg.topic; }) ? lastCfg.topic : "";
      document.getElementById("exTopic").innerHTML = options(list, keep);
    }
    function readCfg() {
      return {
        subject: document.getElementById("exSubject").value,
        topic: document.getElementById("exTopic").value,
        dueOnly: document.getElementById("exSource").value === "due",
        count: parseInt(document.getElementById("exCount").value, 10) || 0,
        minutes: parseInt(document.getElementById("exMinutes").value, 10) || 0
      };
    }
    function updateInfo() {
      var cfg = readCfg();
      var n = buildPool(HD.getQuestions(), cfg, deps()).length;
      var used = cfg.count > 0 ? Math.min(cfg.count, n) : n;
      document.getElementById("exInfo").textContent = n + " uygun soru · sınavda " + used + " soru";
      document.getElementById("exErr").hidden = true;
    }
    fillTopics();
    updateInfo();
    document.getElementById("exSubject").addEventListener("change", function () { lastCfg.topic = ""; fillTopics(); updateInfo(); });
    ["exTopic", "exSource", "exCount", "exMinutes"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", updateInfo);
    });
    document.getElementById("exStart").addEventListener("click", function () {
      var cfg = readCfg();
      var pool = buildPool(HD.getQuestions(), cfg, deps());
      if (!pool.length) {
        var err = document.getElementById("exErr");
        err.textContent = "Bu seçime uygun soru yok.";
        err.hidden = false;
        return;
      }
      lastCfg = cfg;
      start(pickQuestions(pool, cfg.count), cfg.minutes);
    });
  }

  // ----- running the exam -----
  function start(questions, minutes) {
    HD.leavePanelFor("exam");
    S = {
      qs: questions,
      idx: 0,
      results: [],
      startedAt: Date.now(),
      deadline: minutes > 0 ? Date.now() + minutes * 60000 : 0,
      timedOut: false
    };
    var screen = document.getElementById("examScreen");
    screen.hidden = false;
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    renderQuestion();
  }

  function tick() {
    if (!S) return;
    var el = document.getElementById("exTimer");
    if (S.deadline) {
      var left = S.deadline - Date.now();
      if (left <= 0) { S.timedOut = true; renderResult(); return; }
      if (el) { el.textContent = fmtClock(left); el.classList.toggle("low", left < 60000); }
    } else if (el) {
      el.textContent = fmtClock(Date.now() - S.startedAt);
    }
  }

  var X_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  async function renderQuestion() {
    if (!S) return;
    if (S.idx >= S.qs.length) { renderResult(); return; }
    var esc = HD.esc;
    var screen = document.getElementById("examScreen");
    var q = S.qs[S.idx];
    var srcs = (await Promise.all(HD.photosOf(q).map(HD.getPhotoSrc))).filter(Boolean);
    if (!S || S.qs[S.idx] !== q) return; // closed or moved on while loading
    var tDisp = HD.displayTopicOf(q);
    screen.innerHTML =
      '<div class="review-head"><button type="button" class="closex" id="exClose" aria-label="Kapat">' + X_SVG + "</button>" +
      '<span class="exam-timer mono" id="exTimer">' + (S.deadline ? fmtClock(S.deadline - Date.now()) : fmtClock(Date.now() - S.startedAt)) + "</span>" +
      '<span class="prog mono">' + (S.idx + 1) + " / " + S.qs.length + "</span></div>" +
      '<div class="review-body"><div class="review-card">' +
      srcs.map(function (u, i) { return '<img class="ex-img" data-i="' + i + '" src="' + u + '" alt="">'; }).join("") +
      '<div class="review-sub"><span class="subj-chip" style="background:' + HD.colorFor(q.subject) + '">' + esc(q.subject || "") + "</span>" +
      '<span class="disp" style="font-size:.95rem;">' + esc(tDisp) + "</span></div>" +
      '<div id="exAnswer"></div></div>' +
      '<div class="review-foot" id="exFoot"><button type="button" class="btn block" id="exReveal">Cevabı Göster</button></div></div>';

    document.getElementById("exClose").addEventListener("click", function () { close(false); });
    Array.prototype.forEach.call(screen.querySelectorAll(".ex-img"), function (img) {
      img.addEventListener("click", function () { HD.openPhotoZoom(img.getAttribute("src")); });
    });
    document.getElementById("exReveal").addEventListener("click", async function () {
      var solSrc = q.solutionFile ? await HD.getPhotoSrc(q.solutionFile) : null;
      if (!S || S.qs[S.idx] !== q) return;
      document.getElementById("exAnswer").innerHTML =
        '<div class="review-answer">' +
        (q.correctAnswer ? '<div><div class="lbl">Doğru Cevap</div><div>' + esc(q.correctAnswer) + "</div></div>" : "") +
        (q.myAnswer ? '<div><div class="lbl">Önceki Cevabın</div><div>' + esc(q.myAnswer) + "</div></div>" : "") +
        (q.note ? '<div><div class="lbl">Not</div><div>' + esc(q.note) + "</div></div>" : "") +
        (solSrc ? '<div><div class="lbl">Çözüm</div><img class="sol-img" src="' + solSrc + '" alt="Çözüm"></div>' : "") +
        "</div>";
      document.getElementById("exFoot").innerHTML =
        '<button type="button" class="btn" id="exWrong">Yanlış Yaptım</button>' +
        '<button type="button" class="btn good" id="exRight">Doğru Yaptım</button>';
      document.getElementById("exWrong").addEventListener("click", function () { answer(false); });
      document.getElementById("exRight").addEventListener("click", function () { answer(true); });
    });
  }

  function answer(ok) {
    if (!S) return;
    var q = S.qs[S.idx];
    var live = HD.getQuestions().filter(function (x) { return x.id === q.id; })[0] || q;
    if (ok) HD.scheduleNext(live); else HD.resetSchedule(live);
    live.reviewCount = (live.reviewCount || 0) + 1;
    live.lastReviewedAt = Date.now();
    HD.logReview(ok);
    HD.saveQuestions();
    S.results.push({ id: q.id, ok: ok, subject: q.subject || "", topic: HD.displayTopicOf(q) });
    S.idx++;
    renderQuestion();
  }

  function renderResult() {
    if (!S) return;
    clearInterval(timer);
    timer = null;
    var esc = HD.esc;
    var total = S.qs.length;
    var answered = S.results.length;
    var right = S.results.filter(function (r) { return r.ok; }).length;
    var wrong = S.results.filter(function (r) { return !r.ok; });
    var pct = answered ? Math.round((right / answered) * 100) : 0;
    var elapsed = fmtClock(Math.min(Date.now(), S.deadline || Date.now()) - S.startedAt);
    var screen = document.getElementById("examScreen");
    screen.innerHTML =
      '<div class="review-head"><button type="button" class="closex" id="exClose" aria-label="Kapat">' + X_SVG + "</button>" +
      '<span class="prog mono">Sonuç</span></div>' +
      '<div class="review-body"><div class="review-card exam-result">' +
      '<div class="exam-score mono">' + right + " / " + total + "</div>" +
      "<p>%" + pct + " doğru · süre " + elapsed + "</p>" +
      (S.timedOut ? '<p class="hint">Süre doldu, ' + (total - answered) + " soru cevaplanmadı.</p>" : "") +
      (wrong.length
        ? '<div class="exam-wrong"><div class="st-h">Yanlış yaptıkların</div><ul style="list-style:none;padding:0;margin:0;">' +
          wrong.map(function (w) { return "<li>" + esc(w.subject) + " › " + esc(w.topic) + "</li>"; }).join("") + "</ul></div>"
        : (answered ? '<p class="hint">Hepsi doğru, tebrikler!</p>' : "")) +
      '</div><div class="review-foot"><button type="button" class="btn primary block" id="exDone">Kapat</button></div></div>';
    document.getElementById("exClose").addEventListener("click", function () { close(false); });
    document.getElementById("exDone").addEventListener("click", function () { close(false); });
  }

  function close(fromPopstate) {
    if (fromPopstate !== true && history.state && history.state.overlay === "exam") {
      history.back();
      return;
    }
    clearInterval(timer);
    timer = null;
    S = null;
    var screen = document.getElementById("examScreen");
    screen.hidden = true;
    screen.innerHTML = "";
    HD.render(); // counters changed
  }

  HD.exam = { open: open, close: close, _pure: { shuffle: shuffle, buildPool: buildPool, pickQuestions: pickQuestions, fmtClock: fmtClock } };
})();
