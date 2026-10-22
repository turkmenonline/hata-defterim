(function () {
  "use strict";

  // ---------- Capacitor plugin access ----------
  // No bundler is used here: Capacitor injects `window.Capacitor` at runtime
  // inside the native app, exposing installed plugins under
  // `window.Capacitor.Plugins`. Enum values (CameraResultType, CameraSource,
  // Directory, ...) are passed as their underlying string literals below so
  // we don't need to import the plugin JS modules.
  var Plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
  var Camera = Plugins.Camera;
  var Filesystem = Plugins.Filesystem;
  var Preferences = Plugins.Preferences;
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // Plain browser (no Capacitor): data goes to localStorage so the UI can be
  // tested without building the Android app.
  var webMode = !isNative;
  var WEB_PHOTO_PREFIX = "hata_defterim_photo_";

  var STORAGE_KEY = "hata_defterim_questions_v1";
  var PHOTOS_DIR = "photos";
  var EMPTY_TOPIC_KEY = "__konusuz__";
  var ALL_TOPICS_KEY = "__all__";

  var allQuestions = [];
  var photoSrcCache = {}; // filename -> resolved webview src
  var nav = { subject: null, topicKey: null };
  var historyDepth = 0;
  var searchTerm = "";
  var editingId = null;
  var pendingPhotoFilename = null;
  var pendingPhotoPreviewDataUrl = null;
  var originalPhotoFilename = null; // photo the question had when the edit form was opened
  var sessionPhotos = [];           // photos taken while the form is open (not yet saved)
  var questionsLoadedOk = false;    // true only if stored data was read without error
  var SUBJECT_PALETTE = ["#9c2b3c", "#1f6f8b", "#9c6b1f", "#3c6e49", "#5b4b8a", "#45586e"];

  function colorFor(subject) {
    var s = String(subject || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return SUBJECT_PALETTE[h % SUBJECT_PALETTE.length];
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return d.toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric" });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function uid() {
    return "q_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ---------- spaced repetition (Leitner boxes) ----------
  // A question is "due" when it is not mastered, or when it is mastered but its
  // next review date has arrived. Each correct review moves it to a higher box
  // (longer interval); a wrong one sends it back to box 0.
  var DAY_MS = 86400000;
  var INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60]; // index = box
  var MAX_BOX = INTERVAL_DAYS.length - 1;

  function isDue(q) {
    if (!q.mastered) return true;
    return !!q.dueAt && q.dueAt <= Date.now();
  }
  function scheduleNext(q) {
    var box = Math.min((q.box || 0) + 1, MAX_BOX);
    q.box = box;
    q.dueAt = Date.now() + INTERVAL_DAYS[box] * DAY_MS;
    q.mastered = true;
  }
  function resetSchedule(q) {
    q.box = 0;
    q.dueAt = null;
    q.mastered = false;
  }

  // ---------- subject normalization ----------
  // "Matematik", "matematik" and " Matematik " must be the same subject.
  function subjectKey(s) {
    return cleanTopic(s).toLocaleLowerCase("tr-TR");
  }
  function byCreatedAsc(a, b) {
    return (a.createdAt || 0) - (b.createdAt || 0);
  }
  // Returns the label already used for this subject (earliest wins), or the cleaned input.
  function canonicalSubject(raw, questions) {
    var c = cleanTopic(raw);
    if (!c) return c;
    var k = subjectKey(c);
    var ordered = (questions || []).slice().sort(byCreatedAsc);
    for (var i = 0; i < ordered.length; i++) {
      if (ordered[i].subject && subjectKey(ordered[i].subject) === k) {
        return cleanTopic(ordered[i].subject);
      }
    }
    return c;
  }
  // Merges existing subjects that differ only by case/spacing. Returns true if anything changed.
  function normalizeSubjects(questions) {
    var labels = {};
    questions.slice().sort(byCreatedAsc).forEach(function (q) {
      if (!q.subject) return;
      var k = subjectKey(q.subject);
      if (!labels[k]) labels[k] = cleanTopic(q.subject);
    });
    var changed = false;
    questions.forEach(function (q) {
      if (!q.subject) return;
      var l = labels[subjectKey(q.subject)];
      if (l && l !== q.subject) { q.subject = l; changed = true; }
    });
    return changed;
  }

  // ---------- topic normalization ----------
  function cleanTopic(t) {
    return String(t || "").trim().replace(/\s+/g, " ");
  }

  function topicKey(t) {
    var c = cleanTopic(t);
    return c ? c.toLocaleLowerCase("tr-TR") : EMPTY_TOPIC_KEY;
  }

  function buildTopicLabelMap(questions) {
    var map = {};
    map[EMPTY_TOPIC_KEY] = "Konusuz";
    var ordered = (questions || allQuestions).slice().sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    ordered.forEach(function (q) {
      var k = topicKey(q.topic);
      if (k !== EMPTY_TOPIC_KEY && !map[k]) {
        map[k] = cleanTopic(q.topic);
      }
    });
    return map;
  }

  function displayTopicOf(q, labelMap) {
    var map = labelMap || buildTopicLabelMap(allQuestions);
    var k = topicKey(q && q.topic);
    return map[k] || cleanTopic(q && q.topic) || "Konusuz";
  }

  // ---------- storage ----------
  async function loadQuestions() {
    if (webMode) {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        var stored = raw ? JSON.parse(raw) : [];
        questionsLoadedOk = true;
        return stored;
      } catch (e) {
        console.error("loadQuestions (web) failed", e);
        return [];
      }
    }
    if (!Preferences) return [];
    try {
      var res = await Preferences.get({ key: STORAGE_KEY });
      var parsed = res && res.value ? JSON.parse(res.value) : [];
      questionsLoadedOk = true;
      return parsed;
    } catch (e) {
      console.error("loadQuestions failed", e);
      return [];
    }
  }

  async function saveQuestions(arr) {
    if (webMode) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      return;
    }
    if (!Preferences) return;
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(arr) });
  }

  // Browser-only: pick an image file, shrink it and return a JPEG data URL.
  function pickPhotoWeb() {
    return new Promise(function (resolve) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.addEventListener("cancel", function () { resolve(null); });
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        var reader = new FileReader();
        reader.onerror = function () { resolve(null); };
        reader.onload = function () {
          var img = new Image();
          img.onerror = function () { resolve(null); };
          img.onload = function () {
            var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
            var c = document.createElement("canvas");
            c.width = Math.round(img.width * scale);
            c.height = Math.round(img.height * scale);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", 0.7));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
      input.click();
    });
  }

  async function takePhotoAndStore() {
    if (webMode) {
      var dataUrl = await pickPhotoWeb();
      if (!dataUrl) return null;
      var webName = uid() + ".jpeg";
      window.localStorage.setItem(WEB_PHOTO_PREFIX + webName, dataUrl);
      photoSrcCache[webName] = dataUrl;
      return webName;
    }
    if (!Camera || !Filesystem) return null;
    var photo = await Camera.getPhoto({
      quality: 70,
      resultType: "base64",
      source: "PROMPT", // lets the person choose camera or gallery
      saveToGallery: false,
      correctOrientation: true
    });
    var ext = photo.format || "jpeg";
    var filename = uid() + "." + ext;
    await Filesystem.writeFile({
      path: PHOTOS_DIR + "/" + filename,
      data: photo.base64String,
      directory: "DATA",
      recursive: true
    });
    photoSrcCache[filename] = "data:image/" + ext + ";base64," + photo.base64String;
    return filename;
  }

  async function getPhotoSrc(filename) {
    if (!filename) return null;
    if (photoSrcCache[filename]) return photoSrcCache[filename];
    if (webMode) {
      var d = null;
      try { d = window.localStorage.getItem(WEB_PHOTO_PREFIX + filename); } catch (e) {}
      if (d) photoSrcCache[filename] = d;
      return d;
    }
    if (!Filesystem || !window.Capacitor) return null;
    try {
      var res = await Filesystem.getUri({ path: PHOTOS_DIR + "/" + filename, directory: "DATA" });
      var src = window.Capacitor.convertFileSrc(res.uri);
      photoSrcCache[filename] = src;
      return src;
    } catch (e) {
      return null;
    }
  }

  async function deletePhotoFile(filename) {
    if (webMode && filename) {
      try { window.localStorage.removeItem(WEB_PHOTO_PREFIX + filename); } catch (e) {}
      delete photoSrcCache[filename];
      return;
    }
    if (!filename || !Filesystem) return;
    try { await Filesystem.deleteFile({ path: PHOTOS_DIR + "/" + filename, directory: "DATA" }); }
    catch (e) { /* already gone, ignore */ }
    delete photoSrcCache[filename];
  }

  // Deletes photo files in the photos folder that no question refers to.
  // Skipped unless the stored questions were read successfully and the list is
  // not empty, so a read error can never wipe the photos.
  async function cleanupOrphanPhotos() {
    if (!isNative || !Filesystem || !questionsLoadedOk || allQuestions.length === 0) return;
    try {
      var res = await Filesystem.readdir({ path: PHOTOS_DIR, directory: "DATA" });
      var files = (res && res.files) || [];
      for (var i = 0; i < files.length; i++) {
        var name = typeof files[i] === "string" ? files[i] : files[i].name;
        if (!name) continue;
        var inUse = allQuestions.some(function (q) { return q.photoFile === name; }) ||
          sessionPhotos.indexOf(name) !== -1 ||
          pendingPhotoFilename === name;
        if (!inUse) await deletePhotoFile(name);
      }
    } catch (e) {
      // photos folder may not exist yet - nothing to clean
    }
  }

  // ---------- init ----------
  async function init() {
    if (webMode) {
      var note = document.getElementById("webModeNote");
      if (note) note.hidden = false;
    }
    try {
      history.replaceState({ subject: null, topicKey: null, overlay: null, depth: 0 }, "");
    } catch (e) {}
    allQuestions = await loadQuestions();
    if (questionsLoadedOk && normalizeSubjects(allQuestions)) {
      try { await saveQuestions(allQuestions); } catch (e) { console.error("subject merge save failed", e); }
    }
    await render();
    wireStaticEvents();
    cleanupOrphanPhotos();
  }

  // ---------- overlay history (so the Android back button closes overlays) ----------
  function pushOverlayState(name) {
    var st = history.state || {};
    if (st.overlay === name) return;
    historyDepth++;
    try {
      history.pushState({ subject: nav.subject, topicKey: nav.topicKey, overlay: name, depth: historyDepth }, "");
    } catch (e) {}
  }

  // Edit form opened from the detail sheet replaces the detail entry instead of stacking on it.
  function enterFormState() {
    var st = history.state || {};
    if (st.overlay === "form") return;
    if (st.overlay === "detail") {
      try {
        history.replaceState({ subject: nav.subject, topicKey: nav.topicKey, overlay: "form", depth: historyDepth }, "");
      } catch (e) {}
      return;
    }
    pushOverlayState("form");
  }

  // ---------- navigation & render ----------
  function navigateTo(subject, tk) {
    var nextSubj = subject || null;
    var nextTk = tk || null;
    if (nav.subject === nextSubj && nav.topicKey === nextTk) return;
    nav.subject = nextSubj;
    nav.topicKey = nextTk;
    historyDepth++;
    try {
      history.pushState({ subject: nav.subject, topicKey: nav.topicKey, overlay: null, depth: historyDepth }, "");
    } catch (e) {}
    render("forward");
  }

  function goBackLevel() {
    history.back();
  }

  function validateNav() {
    if (allQuestions.length === 0) {
      nav.subject = null;
      nav.topicKey = null;
      return;
    }
    if (nav.subject !== null) {
      var hasSubj = allQuestions.some(function (q) { return q.subject === nav.subject; });
      if (!hasSubj) {
        nav.subject = null;
        nav.topicKey = null;
        return;
      }
    }
    if (nav.subject !== null && nav.topicKey !== null && nav.topicKey !== ALL_TOPICS_KEY) {
      var hasTopic = allQuestions.some(function (q) {
        return q.subject === nav.subject && topicKey(q.topic) === nav.topicKey;
      });
      if (!hasTopic) {
        nav.topicKey = null;
      }
    }
  }

  function renderNavHeader() {
    var backBtn = document.getElementById("navBackBtn");
    var titleEl = document.getElementById("navTitle");
    var subEl = document.getElementById("navSubtitle");
    var labelMap = buildTopicLabelMap(allQuestions);
    var isSearching = searchTerm.trim().length > 0;

    if (nav.subject === null && nav.topicKey === null) {
      backBtn.hidden = true;
      titleEl.textContent = "Hata Defterim";
      titleEl.classList.remove("sublevel");
      subEl.textContent = isSearching ? "Arama · Kapsam: Tüm Sorular" : "Kapsam: Tüm Sorular";
    } else if (nav.subject !== null && nav.topicKey === null) {
      backBtn.hidden = false;
      backBtn.textContent = "‹ Dersler";
      titleEl.textContent = nav.subject;
      titleEl.classList.add("sublevel");
      subEl.textContent = "Kapsam: " + nav.subject;
    } else {
      backBtn.hidden = false;
      titleEl.classList.add("sublevel");
      if (nav.subject === null) {
        backBtn.textContent = "‹ Dersler";
        titleEl.textContent = "Tüm Sorular";
        subEl.textContent = "Kapsam: Tüm Sorular";
      } else if (nav.topicKey === ALL_TOPICS_KEY) {
        backBtn.textContent = "‹ " + nav.subject;
        titleEl.textContent = "Tüm Sorular";
        subEl.textContent = nav.subject + " › Tüm Sorular · Kapsam: " + nav.subject;
      } else {
        var tName = labelMap[nav.topicKey] || "Konusuz";
        backBtn.textContent = "‹ " + nav.subject;
        titleEl.textContent = tName;
        subEl.textContent = nav.subject + " › " + tName + " · Kapsam: " + nav.subject + " › " + tName;
      }
    }
  }

  async function render(animDir) {
    validateNav();
    renderNavHeader();
    renderStats();
    await renderGrid(animDir);
  }

  function renderStats() {
    var total = allQuestions.length;
    var good = allQuestions.filter(function (q) { return !isDue(q); }).length;
    document.getElementById("statTotal").textContent = total;
    document.getElementById("statNeed").textContent = total - good;
    document.getElementById("statGood").textContent = good;
  }

  function sortNewestFirst(arr) {
    return (arr || []).slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function filteredQuestions() {
    var term = searchTerm.trim().toLocaleLowerCase("tr-TR");
    var filtered = allQuestions.filter(function (q) {
      if (term) {
        var hay = [q.subject, q.topic, q.note, q.tags, q.correctAnswer, q.myAnswer].join(" ").toLocaleLowerCase("tr-TR");
        return hay.indexOf(term) !== -1;
      }
      if (nav.subject !== null && q.subject !== nav.subject) return false;
      if (nav.topicKey !== null && nav.topicKey !== ALL_TOPICS_KEY && topicKey(q.topic) !== nav.topicKey) return false;
      return true;
    });
    return sortNewestFirst(filtered);
  }

  async function renderGrid(animDir) {
    var grid = document.getElementById("grid");
    var empty = document.getElementById("emptyState");

    if (allQuestions.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    grid.classList.remove("anim-forward", "anim-back");
    if (animDir === "forward" || animDir === "back") {
      void grid.offsetWidth;
      grid.classList.add(animDir === "forward" ? "anim-forward" : "anim-back");
    }

    var isSearching = searchTerm.trim().length > 0;
    var labelMap = buildTopicLabelMap(allQuestions);

    // Level 1: Subjects list (when not searching and at root level)
    if (!isSearching && nav.subject === null && nav.topicKey === null) {
      var subjMap = {};
      var subjList = [];
      allQuestions.forEach(function (q) {
        var s = q.subject || "Ders yok";
        if (!subjMap[s]) {
          subjMap[s] = { subject: s, total: 0, need: 0, latest: 0 };
          subjList.push(subjMap[s]);
        }
        subjMap[s].total++;
        if (isDue(q)) subjMap[s].need++;
        var ts = q.createdAt || 0;
        if (ts > subjMap[s].latest) subjMap[s].latest = ts;
      });
      subjList.sort(function (a, b) {
        return b.latest - a.latest;
      });

      var totalAll = allQuestions.length;
      var needAll = allQuestions.filter(function (q) { return isDue(q); }).length;
      var rowsHtml =
        '<button type="button" class="nav-row" data-nav-all-subjects="1">' +
        '<span class="nav-row-left">' +
        '<span class="subj-dot" style="background:var(--accent)"></span>' +
        '<span class="nav-row-title">Tüm Sorular</span>' +
        "</span>" +
        '<span class="nav-row-right">' +
        '<span class="nav-row-count">' + totalAll + " soru · " + needAll + " tekrar</span>" +
        '<span class="nav-row-chevron">›</span>' +
        "</span>" +
        "</button>";

      rowsHtml += subjList.map(function (item) {
        return (
          '<button type="button" class="nav-row" data-nav-subject="' + esc(item.subject) + '">' +
          '<span class="nav-row-left">' +
          '<span class="subj-dot" style="background:' + colorFor(item.subject) + '"></span>' +
          '<span class="nav-row-title">' + esc(item.subject) + "</span>" +
          "</span>" +
          '<span class="nav-row-right">' +
          '<span class="nav-row-count">' + item.total + " soru · " + item.need + " tekrar</span>" +
          '<span class="nav-row-chevron">›</span>' +
          "</span>" +
          "</button>"
        );
      }).join("");

      grid.innerHTML = '<div class="nav-list">' + rowsHtml + "</div>";

      var allBtn = grid.querySelector("[data-nav-all-subjects]");
      if (allBtn) {
        allBtn.addEventListener("click", function () {
          navigateTo(null, ALL_TOPICS_KEY);
        });
      }
      Array.prototype.forEach.call(grid.querySelectorAll("[data-nav-subject]"), function (btn) {
        btn.addEventListener("click", function () {
          navigateTo(btn.getAttribute("data-nav-subject"), null);
        });
      });
      return;
    }

    // Level 2: Topics list for selected subject (when not searching and topicKey === null)
    if (!isSearching && nav.subject !== null && nav.topicKey === null) {
      var subjQuestions = allQuestions.filter(function (q) { return q.subject === nav.subject; });
      var topicMap = {};
      var topicList = [];
      subjQuestions.forEach(function (q) {
        var k = topicKey(q.topic);
        if (!topicMap[k]) {
          topicMap[k] = {
            topicKey: k,
            label: labelMap[k] || displayTopicOf(q, labelMap),
            total: 0,
            need: 0,
            latest: 0
          };
          topicList.push(topicMap[k]);
        }
        topicMap[k].total++;
        if (isDue(q)) topicMap[k].need++;
        var ts = q.createdAt || 0;
        if (ts > topicMap[k].latest) topicMap[k].latest = ts;
      });
      topicList.sort(function (a, b) {
        var aEmpty = a.topicKey === EMPTY_TOPIC_KEY;
        var bEmpty = b.topicKey === EMPTY_TOPIC_KEY;
        if (aEmpty && !bEmpty) return 1;
        if (bEmpty && !aEmpty) return -1;
        return b.latest - a.latest;
      });

      var totalSubj = subjQuestions.length;
      var needSubj = subjQuestions.filter(function (q) { return isDue(q); }).length;
      var tRowsHtml =
        '<button type="button" class="nav-row" data-nav-topic="' + ALL_TOPICS_KEY + '">' +
        '<span class="nav-row-left">' +
        '<span class="nav-row-title">Tüm Sorular</span>' +
        "</span>" +
        '<span class="nav-row-right">' +
        '<span class="nav-row-count">' + totalSubj + " soru · " + needSubj + " tekrar</span>" +
        '<span class="nav-row-chevron">›</span>' +
        "</span>" +
        "</button>";

      tRowsHtml += topicList.map(function (tItem) {
        return (
          '<button type="button" class="nav-row" data-nav-topic="' + esc(tItem.topicKey) + '">' +
          '<span class="nav-row-left">' +
          '<span class="nav-row-title">' + esc(tItem.label) + "</span>" +
          "</span>" +
          '<span class="nav-row-right">' +
          '<span class="nav-row-count">' + tItem.total + " soru · " + tItem.need + " tekrar</span>" +
          '<span class="nav-row-chevron">›</span>' +
          "</span>" +
          "</button>"
        );
      }).join("");

      grid.innerHTML = '<div class="nav-list">' + tRowsHtml + "</div>";

      Array.prototype.forEach.call(grid.querySelectorAll("[data-nav-topic]"), function (btn) {
        btn.addEventListener("click", function () {
          navigateTo(nav.subject, btn.getAttribute("data-nav-topic"));
        });
      });
      return;
    }

    // Level 3 or Search Results: Flat Question List (newest first)
    var list = filteredQuestions();
    if (list.length === 0) {
      grid.innerHTML = '<p class="hint" style="grid-column:1/-1;">Bu filtreyle eşleşen soru yok.</p>';
      return;
    }

    var srcs = {};
    await Promise.all(list.map(async function (q) {
      if (q.photoFile) srcs[q.id] = await getPhotoSrc(q.photoFile);
    }));

    var showSubjTopicPair = isSearching || nav.subject === null;
    var cardsHtml = list.map(function (q) {
      var src = srcs[q.id];
      var thumb = src
        ? '<img src="' + src + '" alt="">'
        : '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="13" r="3" stroke="currentColor" stroke-width="1.3"/></svg>';
      var badge = !isDue(q)
        ? '<span class="badge good">Öğrenildi</span>'
        : '<span class="badge need">Tekrar Et</span>';
      var tDisp = displayTopicOf(q, labelMap);
      var topicLine = showSubjTopicPair ? ((q.subject || "Ders yok") + " · " + tDisp) : tDisp;
      return (
        '<div class="card">' +
        '<button class="card-btn" data-id="' + esc(q.id) + '">' +
        '<div class="thumb">' + thumb + "</div>" +
        '<div class="body">' +
        '<div class="tagrow"><span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "Ders yok") + "</span></div>" +
        '<p class="topic">' + esc(topicLine) + "</p>" +
        '<p class="snippet">' + esc(q.note || "") + "</p>" +
        '<div class="meta"><span class="date mono">' + fmtDate(q.createdAt) + "</span>" + badge + "</div>" +
        "</div>" +
        "</button>" +
        "</div>"
      );
    }).join("");

    grid.innerHTML = '<div class="card-list">' + cardsHtml + "</div>";

    Array.prototype.forEach.call(grid.querySelectorAll(".card-btn"), function (btn) {
      btn.addEventListener("click", function () {
        var q = allQuestions.find(function (x) { return x.id === btn.getAttribute("data-id"); });
        if (q) openDetail(q);
      });
    });
  }

  // ---------- add / edit form ----------
  function resetForm() {
    editingId = null;
    pendingPhotoFilename = null;
    pendingPhotoPreviewDataUrl = null;
    originalPhotoFilename = null;
    sessionPhotos = [];
    document.getElementById("qform").reset();
    document.getElementById("photoPreviewBox").innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="13" r="3.2" stroke="currentColor" stroke-width="1.4"/></svg>';
    document.getElementById("photoText").textContent = "Kamerayla çek ya da galeriden seç";
    document.getElementById("formErr").hidden = true;
    document.getElementById("formTitle").textContent = "Yeni Soru Ekle";
    document.getElementById("formSubmit").textContent = "Kaydet";
  }

  function fillSubjectTopicLists() {
    var subjSet = {};
    allQuestions.forEach(function (q) {
      if (q.subject) subjSet[q.subject] = true;
    });
    var subjListEl = document.getElementById("subjectList");
    if (subjListEl) {
      subjListEl.innerHTML = Object.keys(subjSet).map(function (s) { return '<option value="' + esc(s) + '">'; }).join("");
    }
  }

  function renderTopicSuggestions() {
    var box = document.getElementById("topicSuggestions");
    if (!box) return;
    var subjVal = document.getElementById("f_subject").value.trim();
    var targetSubjKey = subjVal ? subjVal.toLocaleLowerCase("tr-TR") : (nav.subject ? nav.subject.toLocaleLowerCase("tr-TR") : "");

    var labelMap = buildTopicLabelMap(allQuestions);
    var counts = {};
    allQuestions.forEach(function (q) {
      if (targetSubjKey && String(q.subject || "").trim().toLocaleLowerCase("tr-TR") !== targetSubjKey) return;
      var tk = topicKey(q.topic);
      if (tk === EMPTY_TOPIC_KEY) return;
      counts[tk] = (counts[tk] || 0) + 1;
    });

    var keys = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a];
    }).slice(0, 8);

    if (keys.length === 0) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }

    box.innerHTML = keys.map(function (k) {
      var lbl = labelMap[k];
      return '<button type="button" class="topic-sug-chip" data-topic-label="' + esc(lbl) + '">' + esc(lbl) + "</button>";
    }).join("");
    box.hidden = false;

    Array.prototype.forEach.call(box.querySelectorAll(".topic-sug-chip"), function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("f_topic").value = btn.getAttribute("data-topic-label");
      });
    });
  }

  function openAddModal() {
    resetForm();
    enterFormState();
    fillSubjectTopicLists();
    if (nav.subject !== null) {
      document.getElementById("f_subject").value = nav.subject;
    }
    if (nav.topicKey !== null && nav.topicKey !== ALL_TOPICS_KEY && nav.topicKey !== EMPTY_TOPIC_KEY) {
      var labelMap = buildTopicLabelMap(allQuestions);
      if (labelMap[nav.topicKey]) {
        document.getElementById("f_topic").value = labelMap[nav.topicKey];
      }
    }
    renderTopicSuggestions();
    document.getElementById("formOverlay").hidden = false;
  }

  async function openEditModal(q) {
    resetForm();
    enterFormState();
    fillSubjectTopicLists();
    editingId = q.id;
    pendingPhotoFilename = q.photoFile || null;
    originalPhotoFilename = q.photoFile || null;
    document.getElementById("formTitle").textContent = "Soruyu Düzenle";
    document.getElementById("formSubmit").textContent = "Güncelle";
    document.getElementById("f_subject").value = q.subject || "";
    document.getElementById("f_topic").value = q.topic || "";
    document.getElementById("f_my").value = q.myAnswer || "";
    document.getElementById("f_correct").value = q.correctAnswer || "";
    document.getElementById("f_note").value = q.note || "";
    document.getElementById("f_tags").value = q.tags || "";
    renderTopicSuggestions();
    if (q.photoFile) {
      var src = await getPhotoSrc(q.photoFile);
      if (src) {
        document.getElementById("photoPreviewBox").innerHTML = '<img src="' + src + '">';
        document.getElementById("photoText").textContent = "Fotoğrafı değiştirmek için dokun";
      }
    }
    document.getElementById("formOverlay").hidden = false;
  }

  // Closes the form. Unsaved photos taken in this session are deleted
  // (after a successful save sessionPhotos is already empty).
  function closeForm(fromPopstate) {
    if (fromPopstate !== true && history.state && history.state.overlay === "form") {
      history.back(); // popstate handler finishes the job
      return;
    }
    var toDelete = sessionPhotos.slice();
    sessionPhotos = [];
    pendingPhotoFilename = null;
    document.getElementById("formOverlay").hidden = true;
    toDelete.forEach(function (f) { deletePhotoFile(f); });
  }

  function wireStaticEvents() {
    document.getElementById("f_subject").addEventListener("input", renderTopicSuggestions);
    document.getElementById("f_subject").addEventListener("change", renderTopicSuggestions);

    document.getElementById("photoInputBox").addEventListener("click", async function () {
      if (!Camera && !webMode) {
        document.getElementById("photoText").textContent = "Kamera yalnızca Android uygulamasında çalışır";
        return;
      }
      try {
        document.getElementById("photoText").textContent = "Açılıyor…";
        var filename = await takePhotoAndStore();
        if (filename) {
          if (pendingPhotoFilename && sessionPhotos.indexOf(pendingPhotoFilename) !== -1) {
            await deletePhotoFile(pendingPhotoFilename);
            sessionPhotos = sessionPhotos.filter(function (f) { return f !== pendingPhotoFilename; });
          }
          sessionPhotos.push(filename);
          pendingPhotoFilename = filename;
          document.getElementById("photoPreviewBox").innerHTML = '<img src="' + photoSrcCache[filename] + '">';
          document.getElementById("photoText").textContent = "Fotoğraf eklendi";
        } else {
          document.getElementById("photoText").textContent = "Kamerayla çek ya da galeriden seç";
        }
      } catch (e) {
        // user cancelled the camera/gallery picker - not an error
        document.getElementById("photoText").textContent = "Kamerayla çek ya da galeriden seç";
      }
    });

    document.getElementById("qform").addEventListener("submit", async function (e) {
      e.preventDefault();
      var errEl = document.getElementById("formErr");
      errEl.hidden = true;
      var subject = document.getElementById("f_subject").value.trim();
      if (!subject) {
        errEl.textContent = "Ders alanı zorunlu.";
        errEl.hidden = false;
        return;
      }
      var submitBtn = document.getElementById("formSubmit");
      submitBtn.disabled = true;
      submitBtn.textContent = "Kaydediliyor…";

      try {
        var editedQuestionId = editingId;
        var data = {
          subject: canonicalSubject(subject, allQuestions.filter(function (x) { return x.id !== editingId; })),
          topic: document.getElementById("f_topic").value.trim(),
          myAnswer: document.getElementById("f_my").value.trim(),
          correctAnswer: document.getElementById("f_correct").value.trim(),
          note: document.getElementById("f_note").value.trim(),
          tags: document.getElementById("f_tags").value.trim(),
          photoFile: pendingPhotoFilename || null
        };

        if (editingId) {
          allQuestions = allQuestions.map(function (q) {
            if (q.id !== editingId) return q;
            return Object.assign({}, q, data);
          });
        } else {
          data.id = uid();
          data.createdAt = Date.now();
          data.mastered = false;
          data.box = 0;
          data.dueAt = null;
          data.reviewCount = 0;
          data.lastReviewedAt = null;
          allQuestions.unshift(data);
        }

        var currentNbQId = (!document.getElementById("notebookScreen").hidden && notebookList[notebookIdx])
          ? notebookList[notebookIdx].id
          : null;

        await saveQuestions(allQuestions);
        if (originalPhotoFilename && originalPhotoFilename !== data.photoFile) {
          await deletePhotoFile(originalPhotoFilename);
        }
        originalPhotoFilename = null;
        sessionPhotos = [];
        closeForm(false);
        await render();
        if (!document.getElementById("notebookScreen").hidden) {
          if (notebookCustomIds) {
            notebookList = sortForNotebook(allQuestions.filter(function (q) {
              return notebookCustomIds.indexOf(q.id) !== -1;
            }));
          } else {
            notebookList = sortForNotebook(filteredQuestions());
          }
          var keepId = editedQuestionId || currentNbQId;
          if (keepId) {
            var newPos = notebookList.findIndex(function (q) { return q.id === keepId; });
            if (newPos !== -1) notebookIdx = newPos;
          }
          if (notebookIdx >= notebookList.length) notebookIdx = Math.max(0, notebookList.length - 1);
          await renderNotebookPage(null);
        }
      } catch (err) {
        console.error(err);
        errEl.textContent = "Kaydedilemedi, tekrar dener misin?";
        errEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = editingId ? "Güncelle" : "Kaydet";
      }
    });

    document.getElementById("navBackBtn").addEventListener("click", goBackLevel);

    window.addEventListener("popstate", function (e) {
      var st = (e.state && typeof e.state === "object")
        ? e.state
        : { subject: null, topicKey: null, overlay: null, depth: 0 };
      historyDepth = typeof st.depth === "number" ? st.depth : Math.max(0, historyDepth - 1);
      var targetOverlay = st.overlay || null;

      var formEl = document.getElementById("formOverlay");
      if (formEl && !formEl.hidden && targetOverlay !== "form") { closeForm(true); return; }
      var detailEl = document.getElementById("detailOverlay");
      if (detailEl && !detailEl.hidden && targetOverlay !== "detail") { closeDetail(true); return; }
      var reviewEl = document.getElementById("reviewScreen");
      if (reviewEl && !reviewEl.hidden && targetOverlay !== "review") { closeReview(true); return; }

      var zoomEl = document.getElementById("photoZoomOverlay");
      if (zoomEl && !zoomEl.hidden && targetOverlay !== "zoom") {
        closePhotoZoom(true);
        if (targetOverlay === "notebook" || targetOverlay === "toc") return;
      }

      var tocEl = document.getElementById("nbTocOverlay");
      if (tocEl && !tocEl.hidden && targetOverlay !== "toc") {
        closeNotebookToc(true, null);
        if (targetOverlay === "notebook") return;
      }

      var nbEl = document.getElementById("notebookScreen");
      if (nbEl && !nbEl.hidden && targetOverlay !== "notebook" && targetOverlay !== "toc" && targetOverlay !== "zoom") {
        closeNotebook(true);
        return;
      }

      nav.subject = st.subject || null;
      nav.topicKey = st.topicKey || null;
      render("back");
    });

    document.getElementById("btnAdd").addEventListener("click", openAddModal);
    document.getElementById("btnEmptyAdd").addEventListener("click", openAddModal);
    document.getElementById("formClose").addEventListener("click", function () { closeForm(false); });
    document.getElementById("formOverlay").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) closeForm(false);
    });

    document.getElementById("detailOverlay").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) closeDetail(false);
    });

    document.getElementById("nbTocOverlay").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) closeNotebookToc(false, null);
    });

    document.getElementById("btnReview").addEventListener("click", startReview);
    document.getElementById("btnNotebook").addEventListener("click", function () {
      openNotebook(null);
    });

    document.getElementById("searchBox").addEventListener("input", function (e) {
      searchTerm = e.target.value;
      renderNavHeader();
      renderGrid();
    });
  }

  async function toggleQuestionMastered(q) {
    if (isDue(q)) { scheduleNext(q); } else { resetSchedule(q); }
    q.lastReviewedAt = Date.now();
    allQuestions = allQuestions.map(function (x) { return x.id === q.id ? q : x; });
    await saveQuestions(allQuestions);
  }

  // ---------- detail ----------
  function closeDetail(fromPopstate) {
    if (fromPopstate !== true && history.state && history.state.overlay === "detail") {
      history.back();
      return;
    }
    document.getElementById("detailOverlay").hidden = true;
  }

  async function openDetail(q) {
    var sheet = document.getElementById("detailSheet");
    var src = q.photoFile ? await getPhotoSrc(q.photoFile) : null;
    var img = src ? '<img class="detail-img" src="' + src + '" alt="">' : "";
    var tags = (q.tags || "").split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    var tDisp = displayTopicOf(q);
    sheet.innerHTML =
      '<div class="sheet-head">' +
      "<h2>" + esc(tDisp || q.subject || "Soru") + "</h2>" +
      '<button class="closex" id="detailClose" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "</div>" +
      img +
      '<div class="tagrow" style="margin-bottom:10px;">' +
      '<span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "") + "</span>" +
      (!isDue(q) ? '<span class="badge good">Öğrenildi</span>' : '<span class="badge need">Tekrar Et</span>') +
      "</div>" +
      (q.myAnswer ? '<div class="detail-row"><label>Benim Cevabım</label><div class="val">' + esc(q.myAnswer) + "</div></div>" : "") +
      (q.correctAnswer ? '<div class="detail-row"><label>Doğru Cevap</label><div class="val">' + esc(q.correctAnswer) + "</div></div>" : "") +
      (q.note ? '<div class="detail-row"><label>Not</label><div class="val">' + esc(q.note) + "</div></div>" : "") +
      (tags.length ? '<div class="detail-row"><label>Etiketler</label><div class="val">' + tags.map(function (t) { return esc(t); }).join(" · ") + "</div></div>" : "") +
      (q.mastered && q.dueAt ? '<div class="detail-row"><label>Sonraki Tekrar</label><div class="val mono">' + fmtDate(q.dueAt) + "</div></div>" : "") +
      '<div class="detail-row"><label>Eklenme</label><div class="val mono">' + fmtDate(q.createdAt) + (q.reviewCount ? " · " + q.reviewCount + " kez tekrar edildi" : "") + "</div></div>" +
      '<div class="detail-actions">' +
      '<button class="btn sm" id="detailEdit">Düzenle</button>' +
      '<button class="btn sm ' + (!isDue(q) ? "" : "good") + '" id="detailToggleMaster">' + (!isDue(q) ? "Tekrar Listesine Al" : "Öğrendim Olarak İşaretle") + "</button>" +
      '<button class="btn sm ghost" id="detailDelete" style="color:var(--accent);">Sil</button>' +
      "</div>" +
      '<div id="detailConfirm"></div>';

    document.getElementById("detailOverlay").hidden = false;
    pushOverlayState("detail");

    document.getElementById("detailClose").addEventListener("click", function () {
      closeDetail(false);
    });
    document.getElementById("detailEdit").addEventListener("click", function () {
      document.getElementById("detailOverlay").hidden = true;
      openEditModal(q);
    });
    document.getElementById("detailToggleMaster").addEventListener("click", async function () {
      await toggleQuestionMastered(q);
      closeDetail(false);
      await render();
    });
    document.getElementById("detailDelete").addEventListener("click", function () {
      document.getElementById("detailConfirm").innerHTML =
        '<div class="confirm-box"><p>Bu soruyu silmek istediğine emin misin? Bu işlem geri alınamaz.</p>' +
        '<div class="confirm-row"><button class="btn sm primary" id="confirmDeleteYes">Evet, Sil</button>' +
        '<button class="btn sm ghost" id="confirmDeleteNo">Vazgeç</button></div></div>';
      document.getElementById("confirmDeleteYes").addEventListener("click", async function () {
        allQuestions = allQuestions.filter(function (x) { return x.id !== q.id; });
        await saveQuestions(allQuestions);
        await deletePhotoFile(q.photoFile);
        closeDetail(false);
        await render();
      });
      document.getElementById("confirmDeleteNo").addEventListener("click", function () {
        document.getElementById("detailConfirm").innerHTML = "";
      });
    });
  }

  // ---------- review mode ----------
  var reviewQueue = [];
  var reviewIdx = 0;
  var reviewTotal = 0;

  function startReview() {
    var pool = filteredQuestions();
    var needsReview = pool.filter(isDue);
    if (needsReview.length === 0) {
      reviewQueue = [];
      var upcoming = pool.filter(function (q) { return q.mastered && q.dueAt; })
        .map(function (q) { return q.dueAt; })
        .sort(function (a, b) { return a - b; });
      renderReviewDone(pool.length > 0, upcoming.length ? upcoming[0] : null);
      document.getElementById("reviewScreen").hidden = false;
      pushOverlayState("review");
      return;
    }
    reviewQueue = shuffle(needsReview);
    reviewTotal = reviewQueue.length;
    reviewIdx = 0;
    document.getElementById("reviewScreen").hidden = false;
    pushOverlayState("review");
    renderReviewCard();
  }

  function closeReview(fromPopstate) {
    if (fromPopstate !== true && history.state && history.state.overlay === "review") {
      history.back();
      return;
    }
    document.getElementById("reviewScreen").hidden = true;
    render();
  }

  async function renderReviewCard() {
    var screen = document.getElementById("reviewScreen");
    if (reviewIdx >= reviewQueue.length) {
      renderReviewDone(true);
      return;
    }
    var q = reviewQueue[reviewIdx];
    var src = q.photoFile ? await getPhotoSrc(q.photoFile) : null;
    var img = src ? '<img src="' + src + '" alt="">' : "";
    var tDisp = displayTopicOf(q);
    screen.innerHTML =
      '<div class="review-head">' +
      '<button class="closex" id="reviewClose" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      '<span class="prog mono">' + (reviewIdx + 1) + " / " + reviewTotal + "</span>" +
      "</div>" +
      '<div class="review-body">' +
      '<div class="review-card">' +
      img +
      '<div class="review-sub">' +
      '<span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "") + "</span>" +
      '<span class="disp" style="font-size:.95rem;">' + esc(tDisp) + "</span>" +
      "</div>" +
      '<div id="answerBox"></div>' +
      "</div>" +
      '<div class="review-foot" id="reviewFootButtons">' +
      '<button class="btn block" id="btnReveal">Cevabı Göster</button>' +
      "</div>" +
      "</div>";

    document.getElementById("reviewClose").addEventListener("click", closeReview);
    document.getElementById("btnReveal").addEventListener("click", function () {
      document.getElementById("answerBox").innerHTML =
        '<div class="review-answer">' +
        (q.correctAnswer ? "<div><div class=\"lbl\">Doğru Cevap</div><div>" + esc(q.correctAnswer) + "</div></div>" : "") +
        (q.myAnswer ? "<div><div class=\"lbl\">Senin Cevabın</div><div>" + esc(q.myAnswer) + "</div></div>" : "") +
        (q.note ? "<div><div class=\"lbl\">Not</div><div>" + esc(q.note) + "</div></div>" : "") +
        "</div>";
      document.getElementById("reviewFootButtons").innerHTML =
        '<button class="btn" id="btnStruggle">Hâlâ Zorlanıyorum</button>' +
        '<button class="btn good" id="btnMastered">Artık Biliyorum</button>';
      document.getElementById("btnStruggle").addEventListener("click", function () { markAndAdvance(q, false); });
      document.getElementById("btnMastered").addEventListener("click", function () { markAndAdvance(q, true); });
    });
  }

  async function markAndAdvance(q, mastered) {
    if (mastered) { scheduleNext(q); } else { resetSchedule(q); }
    q.reviewCount = (q.reviewCount || 0) + 1;
    q.lastReviewedAt = Date.now();
    allQuestions = allQuestions.map(function (x) { return x.id === q.id ? q : x; });
    await saveQuestions(allQuestions);
    reviewIdx++;
    await renderReviewCard();
  }

  function renderReviewDone(hadQuestions, nextDue) {
    var screen = document.getElementById("reviewScreen");
    var title, hint;
    if (reviewQueue.length > 0) {
      var masteredCount = reviewQueue.filter(function (q) { return !!q.mastered; }).length;
      var struggleCount = reviewQueue.length - masteredCount;
      title = "Tur bitti: " + masteredCount + " öğrenildi, " + struggleCount + " tekrar listesinde";
      hint = struggleCount > 0 ? "Kalan soruları istediğin zaman tekrar gözden geçirebilirsin." : "Bu turdaki tüm soruları öğrendin.";
    } else {
      title = hadQuestions ? "Tekrar edilecek soru kalmadı" : "Bu seçimde hiç soru yok";
      hint = hadQuestions
        ? ("Şu an tekrar zamanı gelen soru yok." + (nextDue ? " Sıradaki tekrar: " + fmtDate(nextDue) + "." : ""))
        : "Önce birkaç yanlış soru eklemelisin.";
    }
    screen.innerHTML =
      '<div class="review-head">' +
      '<button class="closex" id="reviewClose2" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "<span></span>" +
      "</div>" +
      '<div class="review-body">' +
      '<div class="review-done">' +
      '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "<h2>" + title + "</h2>" +
      '<p class="hint">' + hint + "</p>" +
      '<button class="btn primary" id="btnBackToList">Listeye Dön</button>' +
      "</div>" +
      "</div>";
    document.getElementById("reviewClose2").addEventListener("click", closeReview);
    document.getElementById("btnBackToList").addEventListener("click", closeReview);
  }

  // ---------- notebook mode ----------
  var notebookList = [];
  var notebookIdx = 0;
  var notebookCustomIds = null;
  var pendingTocJumpIdx = null;

  function getNotebookScopeTitle() {
    var labelMap = buildTopicLabelMap(allQuestions);
    if (searchTerm.trim().length > 0) {
      return "Defter · Arama";
    }
    if (nav.subject === null) {
      return "Defter · Tüm Sorular";
    }
    if (nav.topicKey === null || nav.topicKey === ALL_TOPICS_KEY) {
      return "Defter · " + nav.subject;
    }
    var tName = labelMap[nav.topicKey] || "Konusuz";
    return "Defter · " + nav.subject + " › " + tName;
  }

  function sortForNotebook(list) {
    var arr = (list || []).slice();
    var subjMax = {};
    var groupMax = {};
    arr.forEach(function (q) {
      var s = q.subject || "Ders yok";
      var tk = topicKey(q.topic);
      var gk = s + "::" + tk;
      var ts = q.createdAt || 0;
      if (subjMax[s] === undefined || ts > subjMax[s]) {
        subjMax[s] = ts;
      }
      if (groupMax[gk] === undefined || ts > groupMax[gk]) {
        groupMax[gk] = ts;
      }
    });
    return arr.sort(function (a, b) {
      var sa = a.subject || "Ders yok";
      var sb = b.subject || "Ders yok";
      if (sa !== sb) {
        var sDiff = (subjMax[sb] || 0) - (subjMax[sa] || 0);
        if (sDiff !== 0) return sDiff;
        return sa.localeCompare(sb, "tr-TR");
      }
      var ka = topicKey(a.topic);
      var kb = topicKey(b.topic);
      if (ka !== kb) {
        if (ka === EMPTY_TOPIC_KEY) return 1;
        if (kb === EMPTY_TOPIC_KEY) return -1;
        var gkA = sa + "::" + ka;
        var gkB = sb + "::" + kb;
        var tDiff = (groupMax[gkB] || 0) - (groupMax[gkA] || 0);
        if (tDiff !== 0) return tDiff;
        return ka.localeCompare(kb, "tr-TR");
      }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function openNotebook(customQuestions) {
    if (Array.isArray(customQuestions)) {
      notebookCustomIds = customQuestions.map(function (q) { return q.id; });
      notebookList = sortForNotebook(customQuestions);
    } else {
      notebookCustomIds = null;
      notebookList = sortForNotebook(filteredQuestions());
    }
    notebookIdx = 0;
    document.getElementById("notebookScreen").hidden = false;
    var st = history.state || {};
    if (st.overlay !== "notebook") {
      historyDepth++;
      try {
        history.pushState({ subject: nav.subject, topicKey: nav.topicKey, overlay: "notebook", depth: historyDepth }, "");
      } catch (e) {}
    }
    renderNotebookPage(null);
  }

  function closeNotebook(fromPopstate) {
    if (!fromPopstate && history.state && (history.state.overlay === "notebook" || history.state.overlay === "toc" || history.state.overlay === "zoom")) {
      history.back();
      return;
    }
    document.getElementById("notebookScreen").hidden = true;
    document.getElementById("nbTocOverlay").hidden = true;
    closePhotoZoom(true);
    render();
  }

  function closeNotebookToc(fromPopstate, jumpIdx) {
    if (typeof jumpIdx === "number" && !isNaN(jumpIdx)) {
      pendingTocJumpIdx = jumpIdx;
    }
    if (!fromPopstate && history.state && history.state.overlay === "toc") {
      history.back();
      return;
    }
    var overlay = document.getElementById("nbTocOverlay");
    if (overlay) overlay.hidden = true;
    if (pendingTocJumpIdx !== null) {
      var target = pendingTocJumpIdx;
      pendingTocJumpIdx = null;
      if (target === notebookIdx) {
        renderNotebookPage("prev");
      } else {
        goNotebookPage(target, target > notebookIdx ? "next" : "prev");
      }
    }
  }

  function openNotebookToc() {
    var overlay = document.getElementById("nbTocOverlay");
    var sheet = document.getElementById("nbTocSheet");
    if (!overlay || !sheet || notebookList.length === 0) return;

    var labelMap = buildTopicLabelMap(allQuestions);
    var curQ = notebookList[notebookIdx];
    var curSubj = curQ ? (curQ.subject || "Ders yok") : "";
    var curTk = curQ ? topicKey(curQ.topic) : "";

    var subjGroups = [];
    var subjMap = {};
    notebookList.forEach(function (q, idx) {
      var sName = q.subject || "Ders yok";
      var tk = topicKey(q.topic);
      var tLabel = displayTopicOf(q, labelMap);
      if (!subjMap[sName]) {
        subjMap[sName] = {
          subject: sName,
          count: 0,
          firstIdx: idx,
          topics: []
        };
        subjGroups.push(subjMap[sName]);
      }
      var sg = subjMap[sName];
      sg.count++;
      var lastTopic = sg.topics.length ? sg.topics[sg.topics.length - 1] : null;
      if (!lastTopic || lastTopic.topicKey !== tk) {
        sg.topics.push({
          topicKey: tk,
          topicLabel: tLabel,
          count: 1,
          startPage: idx + 1,
          endPage: idx + 1,
          firstIdx: idx
        });
      } else {
        lastTopic.count++;
        lastTopic.endPage = idx + 1;
      }
    });

    var isSingleTopicScope = (nav.subject !== null && nav.topicKey !== null && nav.topicKey !== ALL_TOPICS_KEY);
    var sheetTitle = (nav.subject !== null) ? ("İçindekiler · " + nav.subject) : "İçindekiler";

    var bodyHtml = "";
    if (isSingleTopicScope && subjGroups.length === 1 && subjGroups[0].topics.length === 1) {
      var tOnly = subjGroups[0].topics[0];
      var pRangeOnly = tOnly.startPage === tOnly.endPage
        ? ("s. " + tOnly.startPage)
        : ("s. " + tOnly.startPage + "–" + tOnly.endPage);
      bodyHtml =
        '<div class="toc-list">' +
        '<button type="button" class="toc-row active" data-first-idx="' + tOnly.firstIdx + '">' +
        '<span class="toc-row-title">' + esc(tOnly.topicLabel) + "</span>" +
        '<span class="toc-row-meta">' + tOnly.count + " soru · " + pRangeOnly + "</span>" +
        "</button>" +
        "</div>";
    } else {
      bodyHtml = '<div class="toc-sections">' + subjGroups.map(function (sg) {
        var topicsHtml = sg.topics.map(function (t) {
          var pageRange = t.startPage === t.endPage
            ? ("s. " + t.startPage)
            : ("s. " + t.startPage + "–" + t.endPage);
          var isActive = (sg.subject === curSubj && t.topicKey === curTk);
          return (
            '<button type="button" class="toc-row' + (isActive ? " active" : "") + '" data-first-idx="' + t.firstIdx + '">' +
            '<span class="toc-row-title">' + esc(t.topicLabel) + "</span>" +
            '<span class="toc-row-meta">' + t.count + " soru · " + pageRange + "</span>" +
            "</button>"
          );
        }).join("");

        return (
          '<div class="toc-section">' +
          '<button type="button" class="toc-subj-head" data-first-idx="' + sg.firstIdx + '">' +
          '<span class="toc-subj-left">' +
          '<span class="subj-dot" style="background:' + colorFor(sg.subject) + '"></span>' +
          '<span class="toc-subj-name">' + esc(sg.subject) + "</span>" +
          "</span>" +
          '<span class="toc-subj-count">' + sg.count + " soru</span>" +
          "</button>" +
          '<div class="toc-list">' + topicsHtml + "</div>" +
          "</div>"
        );
      }).join("") + "</div>";
    }

    sheet.innerHTML =
      '<div class="sheet-head">' +
      "<h2>" + esc(sheetTitle) + "</h2>" +
      '<button class="closex" id="nbTocClose" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "</div>" +
      bodyHtml;

    overlay.hidden = false;
    var st = history.state || {};
    if (st.overlay !== "toc") {
      historyDepth++;
      try {
        history.pushState({ subject: nav.subject, topicKey: nav.topicKey, overlay: "toc", depth: historyDepth }, "");
      } catch (e) {}
    }

    document.getElementById("nbTocClose").addEventListener("click", function () {
      closeNotebookToc(false, null);
    });

    Array.prototype.forEach.call(sheet.querySelectorAll(".toc-subj-head, .toc-row"), function (btn) {
      btn.addEventListener("click", function () {
        var target = parseInt(btn.getAttribute("data-first-idx"), 10);
        closeNotebookToc(false, target);
      });
    });
  }

  function openPhotoZoom(src) {
    if (!src) return;
    var overlay = document.getElementById("photoZoomOverlay");
    overlay.innerHTML =
      '<button class="photo-zoom-close" id="photoZoomClose" aria-label="Kapat">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
      "</button>" +
      '<img src="' + src + '" alt="">';
    overlay.hidden = false;
    var st = history.state || {};
    if (st.overlay !== "zoom") {
      historyDepth++;
      try {
        history.pushState({ subject: nav.subject, topicKey: nav.topicKey, overlay: "zoom", depth: historyDepth }, "");
      } catch (e) {}
    }
    overlay.onclick = function () { closePhotoZoom(false); };
  }

  function closePhotoZoom(fromPopstate) {
    if (!fromPopstate && history.state && history.state.overlay === "zoom") {
      history.back();
      return;
    }
    var overlay = document.getElementById("photoZoomOverlay");
    if (overlay) {
      overlay.hidden = true;
      overlay.innerHTML = "";
    }
  }

  async function goNotebookPage(newIdx, dir) {
    if (newIdx < 0 || newIdx >= notebookList.length || newIdx === notebookIdx) return;
    notebookIdx = newIdx;
    await renderNotebookPage(dir);
  }

  async function renderNotebookPage(animDir) {
    var screen = document.getElementById("notebookScreen");
    var scopeTitle = getNotebookScopeTitle();
    if (notebookList.length === 0) {
      screen.innerHTML =
        '<div class="nb-head">' +
        '<h2 class="nb-head-title">' + esc(scopeTitle) + "</h2>" +
        '<button class="closex" id="nbCloseEmpty" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
        "</div>" +
        '<div class="review-body">' +
        '<div class="review-done">' +
        '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="2" width="16" height="20" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8 7h8M8 11h8M8 15h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
        "<h2>Defter boş, önce soru ekle</h2>" +
        '<p class="hint">Seçili filtrede gösterilecek soru bulunamadı.</p>' +
        '<button class="btn primary" id="nbBackEmpty">Listeye Dön</button>' +
        "</div>" +
        "</div>";
      document.getElementById("nbCloseEmpty").addEventListener("click", function () { closeNotebook(false); });
      document.getElementById("nbBackEmpty").addEventListener("click", function () { closeNotebook(false); });
      return;
    }

    var total = notebookList.length;
    if (notebookIdx >= total) notebookIdx = total - 1;
    var q = notebookList[notebookIdx];
    var labelMap = buildTopicLabelMap(allQuestions);
    var tDisp = displayTopicOf(q, labelMap);
    var subjColor = colorFor(q.subject);
    var src = q.photoFile ? await getPhotoSrc(q.photoFile) : null;
    var tags = (Array.isArray(q.tags) ? q.tags.join(",") : String(q.tags || "")).split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    var animClass = animDir === "next" ? " anim-next" : (animDir === "prev" ? " anim-prev" : "");

    var curSubj = q.subject || "";
    var curTk = topicKey(q.topic);
    var sameTopicPages = notebookList.filter(function (x) {
      return (x.subject || "") === curSubj && topicKey(x.topic) === curTk;
    });
    var topicPos = sameTopicPages.findIndex(function (x) { return x.id === q.id; }) + 1;
    var topicTotal = sameTopicPages.length;

    screen.innerHTML =
      '<div class="nb-head">' +
      '<h2 class="nb-head-title">' + esc(scopeTitle) + "</h2>" +
      '<div class="nb-head-actions">' +
      '<button type="button" class="btn sm" id="nbTocBtn">İçindekiler</button>' +
      '<button class="closex" id="nbClose" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "</div>" +
      "</div>" +
      '<div class="nb-stage">' +
      '<div class="nb-sheet' + animClass + '" id="nbSheet">' +
      '<div class="nb-edge-tab" style="background:' + subjColor + '"></div>' +
      '<div class="nb-page-scroll">' +
      '<div class="nb-topmeta">' +
      '<div class="nb-path">' +
      '<span class="subj-chip" style="background:' + subjColor + '">' + esc(q.subject || "Ders yok") + "</span>" +
      '<span class="nb-path-sep">›</span>' +
      '<button type="button" class="nb-topic" id="nbTopicJump" title="Konunun ilk sayfasına git">' + esc(tDisp) + "</button>" +
      "</div>" +
      '<div class="nb-topmeta-right">' +
      '<span class="nb-date mono">' + fmtDate(q.createdAt) + "</span>" +
      (!isDue(q) ? '<span class="badge good">Öğrenildi</span>' : "") +
      "</div>" +
      "</div>" +
      (src ? '<img class="nb-photo" id="nbPhoto" src="' + src + '" alt="Soru fotoğrafı">' : "") +
      '<div class="nb-fields">' +
      '<div class="nb-ans-grid">' +
      '<div class="nb-field"><label>Benim Cevabım</label><div class="val">' + esc(q.myAnswer || "—") + "</div></div>" +
      '<div class="nb-field"><label>Doğru Cevap</label><div class="val">' + esc(q.correctAnswer || "—") + "</div></div>" +
      "</div>" +
      '<div class="nb-field"><label>Neden Yanlış Yaptım</label><div class="val">' + esc(q.note || "—") + "</div></div>" +
      (tags.length ? '<div class="nb-field"><label>Etiketler</label><div class="val">' + tags.map(function (t) { return esc(t); }).join(" · ") + "</div></div>" : "") +
      "</div>" +
      "</div>" +
      '<div class="nb-sheet-foot">' +
      '<div class="nb-actions">' +
      '<button class="btn sm" id="nbEdit">Düzenle</button>' +
      '<button class="btn sm ' + (!isDue(q) ? "" : "good") + '" id="nbToggleMaster">' + (!isDue(q) ? "Tekrar Listesine Al" : "Öğrendim İşaretle") + "</button>" +
      "</div>" +
      '<button type="button" class="nb-pagenum-btn mono" id="nbPageNumBtn" title="İçindekiler">Sayfa ' + (notebookIdx + 1) + " / " + total + "</button>" +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="nb-nav">' +
      '<button class="nb-nav-btn" id="nbPrev" aria-label="Önceki sayfa"' + (notebookIdx === 0 ? " disabled" : "") + ">‹</button>" +
      '<span class="nb-nav-topic mono">' + esc(tDisp) + " · " + topicPos + " / " + topicTotal + "</span>" +
      '<button class="nb-nav-btn" id="nbNext" aria-label="Sonraki sayfa"' + (notebookIdx === total - 1 ? " disabled" : "") + ">›</button>" +
      "</div>";

    document.getElementById("nbClose").addEventListener("click", function () { closeNotebook(false); });
    document.getElementById("nbTocBtn").addEventListener("click", openNotebookToc);
    document.getElementById("nbPageNumBtn").addEventListener("click", openNotebookToc);
    document.getElementById("nbPrev").addEventListener("click", function () { goNotebookPage(notebookIdx - 1, "prev"); });
    document.getElementById("nbNext").addEventListener("click", function () { goNotebookPage(notebookIdx + 1, "next"); });

    var topicJumpEl = document.getElementById("nbTopicJump");
    if (topicJumpEl) {
      topicJumpEl.addEventListener("click", function () {
        var firstIdx = notebookList.findIndex(function (x) {
          return (x.subject || "") === curSubj && topicKey(x.topic) === curTk;
        });
        if (firstIdx !== -1) {
          if (firstIdx === notebookIdx) {
            renderNotebookPage("prev");
          } else {
            goNotebookPage(firstIdx, firstIdx < notebookIdx ? "prev" : "next");
          }
        }
      });
    }

    var photoEl = document.getElementById("nbPhoto");
    if (photoEl) {
      photoEl.addEventListener("click", function () { openPhotoZoom(src); });
    }

    document.getElementById("nbEdit").addEventListener("click", function () {
      openEditModal(q);
    });

    document.getElementById("nbToggleMaster").addEventListener("click", async function () {
      await toggleQuestionMastered(q);
      await renderNotebookPage(null);
    });

    var sheetEl = document.getElementById("nbSheet");
    var touchStartX = 0;
    var touchStartY = 0;
    sheetEl.addEventListener("touchstart", function (e) {
      if (!e.touches || e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    sheetEl.addEventListener("touchend", function (e) {
      if (!e.changedTouches || e.changedTouches.length !== 1) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      var dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        if (dx < 0 && notebookIdx < total - 1) {
          goNotebookPage(notebookIdx + 1, "next");
        } else if (dx > 0 && notebookIdx > 0) {
          goNotebookPage(notebookIdx - 1, "prev");
        }
      }
    }, { passive: true });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
