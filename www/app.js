(function () {
  "use strict";

  // Public API for the feature modules (cropper, stats, exam, pdf, reminders).
  var HD = window.HD = window.HD || {};

  // Apply the saved theme immediately so there is no light/dark flash on start.
  try {
    var savedTheme = window.localStorage.getItem("hd_theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      document.documentElement.setAttribute("data-theme", savedTheme);
    }
  } catch (e) {}

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
  var pending = { photo: null, solution: null, extra: [] };   // photo files currently chosen in the form
  var original = { photo: null, solution: null, extra: [] };  // photos the question had when the edit form was opened
  var sessionPhotos = [];           // photos taken while the form is open (not yet saved)
  var questionsLoadedOk = false;    // true only if stored data was read without error
  var dataVersion = 0;              // bumped on every save; used to cache derived data
  var labelCache = { v: -1, n: -1, map: null };
  var filterStatus = "all";         // "all" | "due" | "done"
  var filterTag = null;             // lower-cased tag or null
  var settings = { reminder: { on: false, hour: 20, minute: 0 }, theme: "system", exam: { name: "", date: "" } };
  var trash = [];                   // soft-deleted questions (kept 30 days)
  var trashLoadedOk = false;
  var TRASH_KEY = "hata_defterim_trash_v1";
  var TRASH_DAYS = 30;
  var selectMode = false;           // multi-select on the list
  var selected = {};                // question id -> true
  var toastTimer = null;
  var REASONS = ["Bilgi eksiği", "Dikkat hatası", "İşlem hatası", "Süre yetmedi", "Yanlış okudum"];
  var reviewLog = { days: {} };     // "YYYY-MM-DD" -> { n: reviews, ok: correct }
  var THUMBS_DIR = "thumbs";
  var THUMB_MAX = 320;
  var PHOTO_MAX = isNative ? 1600 : 1280;
  var SETTINGS_KEY = "hata_defterim_settings_v1";
  var REVIEWLOG_KEY = "hata_defterim_reviewlog_v1";
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

  // ---------- question files ----------
  // A question has a main photo, optional extra pages and an optional solution photo.
  function photosOf(q) {
    var out = [];
    if (q.photoFile) out.push(q.photoFile);
    (q.extraPhotos || []).forEach(function (f) { if (f) out.push(f); });
    return out;
  }
  function allFilesOf(q) {
    return photosOf(q).concat(q.solutionFile ? [q.solutionFile] : []);
  }
  async function deleteFilesOf(q) {
    var files = allFilesOf(q);
    for (var i = 0; i < files.length; i++) await deletePhotoFile(files[i]);
  }

  // Days from today until a "YYYY-MM-DD" date (negative if it has passed), or null if invalid.
  function daysUntil(dateStr, nowMs) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!m) return null;
    var target = new Date(+m[1], +m[2] - 1, +m[3]);
    var now = new Date(nowMs);
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target.getTime() - today.getTime()) / 86400000);
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
    var useCache = !questions || questions === allQuestions;
    if (useCache && labelCache.v === dataVersion && labelCache.n === allQuestions.length && labelCache.map) {
      return labelCache.map;
    }
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
    if (useCache) labelCache = { v: dataVersion, n: allQuestions.length, map: map };
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
    dataVersion++;
    if (webMode) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      return;
    }
    if (!Preferences) return;
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(arr) });
    refreshWidget();
  }

  // ---------- generic key/value storage (settings, review log) ----------
  async function kvRead(key) {
    if (webMode) return window.localStorage.getItem(key);
    if (Preferences) return (await Preferences.get({ key: key })).value;
    return null;
  }
  async function loadJSON(key, fallback) {
    try {
      var raw = await kvRead(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error("loadJSON failed", key, e);
      return fallback;
    }
  }
  async function saveJSON(key, obj) {
    try {
      var str = JSON.stringify(obj);
      if (webMode) window.localStorage.setItem(key, str);
      else if (Preferences) await Preferences.set({ key: key, value: str });
    } catch (e) {
      console.error("saveJSON failed", key, e);
    }
  }

  function applyTheme(theme) {
    var el = document.documentElement;
    if (theme === "dark" || theme === "light") el.setAttribute("data-theme", theme);
    else el.removeAttribute("data-theme");
    try { window.localStorage.setItem("hd_theme", theme || "system"); } catch (e) {}
  }

  async function loadSettings() {
    var saved = await loadJSON(SETTINGS_KEY, null);
    if (saved && typeof saved === "object") {
      if (saved.theme === "dark" || saved.theme === "light" || saved.theme === "system") settings.theme = saved.theme;
      if (saved.exam && typeof saved.exam === "object") {
        settings.exam = { name: String(saved.exam.name || "").slice(0, 30), date: String(saved.exam.date || "") };
      }
      if (saved.reminder && typeof saved.reminder === "object") {
        settings.reminder = {
          on: !!saved.reminder.on,
          hour: Math.min(23, Math.max(0, parseInt(saved.reminder.hour, 10) || 0)),
          minute: Math.min(59, Math.max(0, parseInt(saved.reminder.minute, 10) || 0))
        };
      }
    }
  }
  function saveSettings() { return saveJSON(SETTINGS_KEY, settings); }

  // ---------- review log (for statistics) ----------
  function dateKey(ts) {
    var d = new Date(ts);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  function logReview(ok) {
    var k = dateKey(Date.now());
    var d = reviewLog.days[k] || (reviewLog.days[k] = { n: 0, ok: 0 });
    d.n++;
    if (ok) d.ok++;
    var keys = Object.keys(reviewLog.days);
    if (keys.length > 400) {
      keys.sort().slice(0, keys.length - 400).forEach(function (old) { delete reviewLog.days[old]; });
    }
    saveJSON(REVIEWLOG_KEY, reviewLog);
  }

  // Tells the home-screen widget (native) to re-read the due count.
  var widgetTimer = null;
  function refreshWidget() {
    if (!isNative) return;
    clearTimeout(widgetTimer);
    widgetTimer = setTimeout(function () {
      try {
        var W = Plugins.DueWidget;
        if (!W && window.Capacitor && window.Capacitor.registerPlugin) W = window.Capacitor.registerPlugin("DueWidget");
        if (W && W.refresh) {
          var r = W.refresh();
          if (r && r.catch) r.catch(function () {});
        }
      } catch (e) {}
    }, 1500);
  }

  // ---------- toast ----------
  function showToast(message, actionLabel, actionFn, ms) {
    var el = document.getElementById("toast");
    if (!el) return;
    clearTimeout(toastTimer);
    document.getElementById("toastMsg").textContent = message;
    var btn = document.getElementById("toastAction");
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || "";
    btn.onclick = function () {
      el.hidden = true;
      clearTimeout(toastTimer);
      if (actionFn) actionFn();
    };
    el.hidden = false;
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 6000);
  }

  // ---------- trash (soft delete, restorable for 30 days) ----------
  function saveTrash() { return saveJSON(TRASH_KEY, trash); }

  async function loadTrash() {
    try {
      var raw = await kvRead(TRASH_KEY);
      trash = raw ? JSON.parse(raw) : [];
      trashLoadedOk = true;
    } catch (e) {
      console.error("loadTrash failed", e);
      trash = [];
    }
  }

  async function moveToTrash(list, silent) {
    if (!list.length) return [];
    var ids = {};
    list.forEach(function (q) { ids[q.id] = true; });
    var now = Date.now();
    var moved = allQuestions.filter(function (q) { return ids[q.id]; })
      .map(function (q) { return Object.assign({}, q, { deletedAt: now }); });
    if (!moved.length) return [];
    allQuestions = allQuestions.filter(function (q) { return !ids[q.id]; });
    trash = moved.concat(trash);
    await saveQuestions(allQuestions);
    await saveTrash();
    await render();
    if (!silent) {
      var movedIds = moved.map(function (q) { return q.id; });
      showToast(moved.length === 1 ? "Soru silindi" : moved.length + " soru silindi", "Geri Al", function () { restoreFromTrash(movedIds); });
    }
    return moved;
  }

  async function restoreFromTrash(ids) {
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    var back = trash.filter(function (q) { return set[q.id]; }).map(function (q) {
      var c = Object.assign({}, q);
      delete c.deletedAt;
      return c;
    });
    if (!back.length) return;
    trash = trash.filter(function (q) { return !set[q.id]; });
    allQuestions = back.concat(allQuestions);
    await saveQuestions(allQuestions);
    await saveTrash();
    await render();
  }

  async function purgeFromTrash(ids) {
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    var gone = trash.filter(function (q) { return set[q.id]; });
    trash = trash.filter(function (q) { return !set[q.id]; });
    await saveTrash();
    for (var i = 0; i < gone.length; i++) await deleteFilesOf(gone[i]);
  }

  async function purgeOldTrash() {
    if (!trashLoadedOk) return;
    var cutoff = Date.now() - TRASH_DAYS * 86400000;
    var old = trash.filter(function (q) { return (q.deletedAt || 0) < cutoff; });
    if (old.length) await purgeFromTrash(old.map(function (q) { return q.id; }));
  }

  // ---------- images: load / scale / thumbnails ----------
  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("image load failed")); };
      img.src = src;
    });
  }
  function scaledCanvas(source, sw, sh, maxSide) {
    var scale = Math.min(1, maxSide / Math.max(sw, sh));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; // JPEG has no alpha
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  function jpegBase64(canvas, quality) {
    return canvas.toDataURL("image/jpeg", quality).split(",")[1];
  }

  // Browser-only: let the user choose an image file; resolves a data URL (or null).
  function pickFileWeb() {
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
        reader.onload = function () { resolve(reader.result); };
        reader.readAsDataURL(file);
      });
      input.click();
    });
  }

  // Gets a photo from camera/gallery (or file picker in the browser), scaled so
  // the longest side is at most PHOTO_MAX. Resolves a canvas, or null if nothing was chosen.
  async function acquireSourceCanvas() {
    var dataUrl;
    if (webMode) {
      dataUrl = await pickFileWeb();
      if (!dataUrl) return null;
    } else {
      if (!Camera || !Filesystem) return null;
      var photo = await Camera.getPhoto({
        quality: 80,
        resultType: "base64",
        source: "PROMPT", // lets the person choose camera or gallery
        saveToGallery: false,
        correctOrientation: true
      });
      dataUrl = "data:image/" + (photo.format || "jpeg") + ";base64," + photo.base64String;
    }
    var img = await loadImage(dataUrl);
    return scaledCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, PHOTO_MAX);
  }

  // Writes the canvas as a JPEG (plus a small thumbnail on the phone). Returns the file name.
  async function storeCanvas(canvas) {
    var filename = uid() + ".jpeg";
    if (webMode) {
      var url = canvas.toDataURL("image/jpeg", 0.75);
      window.localStorage.setItem(WEB_PHOTO_PREFIX + filename, url);
      photoSrcCache[filename] = url;
      return filename;
    }
    await Filesystem.writeFile({
      path: PHOTOS_DIR + "/" + filename,
      data: jpegBase64(canvas, 0.82),
      directory: "DATA",
      recursive: true
    });
    try {
      var thumb = scaledCanvas(canvas, canvas.width, canvas.height, THUMB_MAX);
      await Filesystem.writeFile({
        path: THUMBS_DIR + "/" + filename,
        data: jpegBase64(thumb, 0.7),
        directory: "DATA",
        recursive: true
      });
    } catch (e) { /* the thumbnail is rebuilt lazily if this fails */ }
    return filename;
  }

  // Camera/gallery -> optional crop -> stored file name (null if cancelled).
  async function takePhotoAndStore() {
    var canvas = await acquireSourceCanvas();
    if (!canvas) return null;
    if (HD.crop) {
      canvas = await HD.crop.open(canvas);
      if (!canvas) return null;
    }
    return await storeCanvas(canvas);
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

  // Thumbnails keep the list fast: the list shows ~320px files instead of
  // full photos. Missing thumbnails (older photos) are built one at a time.
  var thumbSrcCache = {};
  var thumbQueue = Promise.resolve();

  async function ensureThumb(filename) {
    if (thumbSrcCache[filename]) return thumbSrcCache[filename];
    var path = THUMBS_DIR + "/" + filename;
    try {
      await Filesystem.stat({ path: path, directory: "DATA" });
    } catch (e) {
      var full = await getPhotoSrc(filename);
      if (!full) return null;
      try {
        var img = await loadImage(full);
        var c = scaledCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, THUMB_MAX);
        await Filesystem.writeFile({ path: path, data: jpegBase64(c, 0.7), directory: "DATA", recursive: true });
      } catch (e2) {
        return full; // could not build a thumbnail: show the full photo instead
      }
    }
    try {
      var res = await Filesystem.getUri({ path: path, directory: "DATA" });
      var src = window.Capacitor.convertFileSrc(res.uri);
      thumbSrcCache[filename] = src;
      return src;
    } catch (e3) {
      return null;
    }
  }

  function getThumbSrc(filename) {
    if (!filename) return Promise.resolve(null);
    if (thumbSrcCache[filename]) return Promise.resolve(thumbSrcCache[filename]);
    if (webMode || !Filesystem) return getPhotoSrc(filename);
    var p = thumbQueue.then(function () { return ensureThumb(filename); });
    thumbQueue = p.catch(function () {});
    return p;
  }

  // Fills <img data-thumb="file"> elements as they scroll into view.
  var thumbObserver = null;
  function hydrateThumbs(root) {
    if (!root || !root.querySelectorAll) return;
    var imgs = Array.prototype.slice.call(root.querySelectorAll("img[data-thumb]"));
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    if (!imgs.length) return;
    function load(img) {
      var f = img.getAttribute("data-thumb");
      img.removeAttribute("data-thumb");
      getThumbSrc(f).then(function (src) { if (src && img.isConnected !== false) img.src = src; });
    }
    if (typeof IntersectionObserver === "undefined") { imgs.forEach(load); return; }
    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { thumbObserver.unobserve(en.target); load(en.target); }
      });
    }, { rootMargin: "400px 0px" });
    imgs.forEach(function (img) { thumbObserver.observe(img); });
  }

  async function deletePhotoFile(filename) {
    if (!filename) return;
    delete photoSrcCache[filename];
    delete thumbSrcCache[filename];
    if (webMode) {
      try { window.localStorage.removeItem(WEB_PHOTO_PREFIX + filename); } catch (e) {}
      return;
    }
    if (!Filesystem) return;
    try { await Filesystem.deleteFile({ path: PHOTOS_DIR + "/" + filename, directory: "DATA" }); }
    catch (e) { /* already gone, ignore */ }
    try { await Filesystem.deleteFile({ path: THUMBS_DIR + "/" + filename, directory: "DATA" }); }
    catch (e) { /* no thumbnail, ignore */ }
  }

  // Deletes photo/thumbnail files that no question refers to.
  // Skipped unless the stored questions were read successfully and the list is
  // not empty, so a read error can never wipe the photos.
  async function cleanupOrphanPhotos() {
    if (!isNative || !Filesystem || !questionsLoadedOk || !trashLoadedOk || allQuestions.length === 0) return;
    var used = {};
    allQuestions.concat(trash).forEach(function (q) {
      allFilesOf(q).forEach(function (f) { used[f] = true; });
    });
    var dirs = [PHOTOS_DIR, THUMBS_DIR];
    for (var d = 0; d < dirs.length; d++) {
      try {
        var res = await Filesystem.readdir({ path: dirs[d], directory: "DATA" });
        var files = (res && res.files) || [];
        for (var i = 0; i < files.length; i++) {
          var name = typeof files[i] === "string" ? files[i] : files[i].name;
          if (!name) continue;
          var inUse = used[name] ||
            sessionPhotos.indexOf(name) !== -1 ||
            pending.photo === name || pending.solution === name || pending.extra.indexOf(name) !== -1;
          if (!inUse) await deletePhotoFile(name);
        }
      } catch (e) {
        // folder may not exist yet - nothing to clean
      }
    }
  }

  // ---------- swipe a bottom sheet down to close it ----------
  // Works when the sheet is scrolled to the top. closeFn is called once the
  // sheet has slid off the screen; a short or slow drag snaps back instead.
  function attachSheetSwipe(sheet, closeFn) {
    if (!sheet) return;
    var startY = 0, startT = 0, dy = 0, tracking = false, dragging = false;

    function reset(animated) {
      sheet.style.transition = animated ? "transform .2s ease-out" : "";
      sheet.style.transform = "";
      if (animated) setTimeout(function () { sheet.style.transition = ""; }, 220);
      tracking = false;
      dragging = false;
      dy = 0;
    }

    sheet.addEventListener("touchstart", function (e) {
      if (!e.touches || e.touches.length !== 1) return;
      var t = e.target;
      tracking = sheet.scrollTop <= 0 && !(t && t.closest && t.closest("textarea"));
      startY = e.touches[0].clientY;
      startT = Date.now();
      dy = 0;
      dragging = false;
    }, { passive: true });

    sheet.addEventListener("touchmove", function (e) {
      if (!tracking || !e.touches || e.touches.length !== 1) return;
      var d = e.touches[0].clientY - startY;
      if (d <= 0) {
        if (dragging) { dy = 0; sheet.style.transform = ""; }
        return; // upward: normal scrolling
      }
      if (sheet.scrollTop > 0) { tracking = false; return; }
      dragging = true;
      dy = d;
      sheet.style.transition = "none";
      sheet.style.transform = "translateY(" + d + "px)";
      if (e.cancelable) e.preventDefault(); // no pull-to-refresh / scroll chaining
    }, { passive: false });

    function end() {
      if (!dragging) { tracking = false; return; }
      var elapsed = Math.max(1, Date.now() - startT);
      var shouldClose = dy > 110 || (dy > 40 && dy / elapsed > 0.6);
      if (shouldClose) {
        sheet.style.transition = "transform .18s ease-out";
        sheet.style.transform = "translateY(100%)";
        tracking = false;
        dragging = false;
        setTimeout(function () {
          closeFn();
          setTimeout(function () { reset(false); }, 150); // overlay is hidden by now
        }, 170);
      } else {
        reset(true);
      }
    }
    sheet.addEventListener("touchend", end);
    sheet.addEventListener("touchcancel", function () { reset(true); });
  }

  // ---------- panels (menu, settings, stats, exam setup, PDF, dialogs) ----------
  var panelOnClose = null;
  var X_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  function setPanel(title, bodyHtml, opts) {
    opts = opts || {};
    var sheet = document.getElementById("panelSheet");
    sheet.innerHTML =
      '<div class="sheet-head"><h2>' + esc(title) + '</h2>' +
      '<button type="button" class="closex" id="panelClose" aria-label="Kapat">' + X_SVG + "</button></div>" +
      (opts.back ? '<button type="button" class="btn sm ghost panel-back" id="panelBack">‹ Menü</button>' : "") +
      bodyHtml;
    document.getElementById("panelClose").addEventListener("click", function () { closePanel(false); });
    if (opts.back) document.getElementById("panelBack").addEventListener("click", openMenu);
    if (opts.onClose !== undefined) panelOnClose = opts.onClose;
    sheet.scrollTop = 0;
    return sheet;
  }

  function openPanel(title, bodyHtml, opts) {
    var ov = document.getElementById("panelOverlay");
    var wasOpen = !ov.hidden;
    if (!wasOpen) panelOnClose = null;
    var sheet = setPanel(title, bodyHtml, opts);
    ov.hidden = false;
    if (!wasOpen) pushOverlayState("panel");
    return sheet;
  }

  function runPanelOnClose() {
    var f = panelOnClose;
    panelOnClose = null;
    if (typeof f === "function") { try { f(); } catch (e) {} }
  }

  function closePanel(fromPopstate) {
    if (fromPopstate !== true && history.state && history.state.overlay === "panel") {
      history.back();
      return;
    }
    document.getElementById("panelOverlay").hidden = true;
    runPanelOnClose();
  }

  // Hides the panel and re-labels its history entry for a full-screen overlay (e.g. the exam).
  function leavePanelFor(name) {
    document.getElementById("panelOverlay").hidden = true;
    panelOnClose = null;
    swapOverlayState(name);
  }

  function openMenu() {
    var items = [["stats", "İstatistikler"], ["exam", "Sınav Modu"], ["lastlook", "Son Bakış (yıldızlılar)"],
      ["pdf", "PDF'e Aktar"], ["trash", "Çöp Kutusu"], ["settings", "Ayarlar"]];
    var html = '<div class="nav-list">' + items.map(function (it) {
      var extra = it[0] === "trash" && trash.length ? '<span class="nav-row-count">' + trash.length + "</span>" : "";
      return '<button type="button" class="nav-row" data-menu="' + it[0] + '">' +
        '<span class="nav-row-left"><span class="nav-row-title">' + it[1] + "</span></span>" +
        '<span class="nav-row-right">' + extra + '<span class="nav-row-chevron">›</span></span></button>';
    }).join("") + "</div>";
    var sheet = openPanel("Menü", html);
    Array.prototype.forEach.call(sheet.querySelectorAll("[data-menu]"), function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-menu");
        if (key === "settings") openSettings();
        else if (key === "trash") openTrash();
        else if (key === "lastlook") openLastLook();
        else if (HD[key] && HD[key].open) HD[key].open();
      });
    });
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function openSettings() {
    var r = settings.reminder;
    var themeBtns = [["system", "Sistem"], ["light", "Açık"], ["dark", "Koyu"]].map(function (t) {
      return '<button type="button" class="seg-btn' + (settings.theme === t[0] ? " active" : "") + '" data-theme-opt="' + t[0] + '">' + t[1] + "</button>";
    }).join("");
    var html =
      '<div class="setting-row"><div><div class="setting-title">Günlük hatırlatma</div>' +
      '<div class="setting-sub">Tekrar zamanı gelen soruların olduğu günlerde bildirim gönderir.</div></div>' +
      '<input type="checkbox" class="switch" id="remOn"' + (r.on ? " checked" : "") + "></div>" +
      '<div class="setting-row"><div class="setting-title">Saat</div>' +
      '<input type="time" id="remTime" class="time-input" value="' + pad2(r.hour) + ":" + pad2(r.minute) + '"></div>' +
      '<div class="setting-actions"><button type="button" class="btn sm" id="remTest">Test bildirimi gönder</button></div>' +
      '<p class="hint" id="remMsg" hidden></p>' +
      '<div class="setting-title" style="margin:18px 0 8px;">Sınav geri sayımı</div>' +
      '<div class="two-col"><div class="field"><label>Sınav adı</label><input type="text" id="exName" maxlength="30" placeholder="TYT" value="' + esc(settings.exam.name) + '"></div>' +
      '<div class="field"><label>Tarih</label><input type="date" id="exDate" value="' + esc(settings.exam.date) + '"></div></div>' +
      '<div class="setting-title" style="margin:18px 0 4px;">Yazı okuma</div>' +
      '<div class="setting-sub">Fotoğraflardaki yazıyı okuyup arama için saklar. Yeni sorularda otomatik çalışır.</div>' +
      '<div class="setting-actions"><button type="button" class="btn sm" id="ocrBatch">Eski soruları tara</button></div>' +
      '<p class="hint" id="ocrMsg" hidden></p>' +
      '<div class="setting-title" style="margin:18px 0 8px;">Görünüm</div>' +
      '<div class="seg" id="themeSeg">' + themeBtns + "</div>";
    var sheet = openPanel("Ayarlar", html, { back: true });

    function msg(text) {
      var el = document.getElementById("remMsg");
      el.textContent = text;
      el.hidden = !text;
    }
    document.getElementById("remOn").addEventListener("change", async function () {
      var box = document.getElementById("remOn");
      var on = box.checked;
      if (on) {
        var res = HD.reminders ? await HD.reminders.enable() : { ok: false, message: "Hatırlatma yalnızca Android uygulamasında çalışır." };
        if (!res.ok) { box.checked = false; msg(res.message); return; }
      } else if (HD.reminders) {
        await HD.reminders.disable();
      }
      settings.reminder.on = on;
      await saveSettings();
      if (on && HD.reminders) await HD.reminders.reschedule();
      msg(on ? "Hatırlatma açıldı." : "Hatırlatma kapatıldı.");
    });
    document.getElementById("remTime").addEventListener("change", async function () {
      var parts = String(document.getElementById("remTime").value || "").split(":");
      var h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
      if (isNaN(h) || isNaN(m)) return;
      settings.reminder.hour = h;
      settings.reminder.minute = m;
      await saveSettings();
      if (settings.reminder.on && HD.reminders) await HD.reminders.reschedule();
      msg("Saat " + pad2(h) + ":" + pad2(m) + " olarak ayarlandı.");
    });
    document.getElementById("remTest").addEventListener("click", async function () {
      var res = HD.reminders ? await HD.reminders.test() : { ok: false, message: "Bildirimler yalnızca Android uygulamasında çalışır." };
      msg(res.message);
    });
    function saveExam() {
      settings.exam = { name: cleanTopic(document.getElementById("exName").value).slice(0, 30), date: document.getElementById("exDate").value || "" };
      saveSettings();
      renderExamPill();
    }
    document.getElementById("exName").addEventListener("change", saveExam);
    document.getElementById("exDate").addEventListener("change", saveExam);
    document.getElementById("ocrBatch").addEventListener("click", async function () {
      var el = document.getElementById("ocrMsg");
      el.hidden = false;
      if (!HD.ocr || !HD.ocr.available()) {
        el.textContent = HD.ocr ? HD.ocr.unavailableMessage() : "Yazı okuma bu sürümde yok.";
        return;
      }
      document.getElementById("ocrBatch").disabled = true;
      var res = await HD.ocr.runBatch(function (i, n) { el.textContent = i + " / " + n + " soru tarandı…"; });
      document.getElementById("ocrBatch").disabled = false;
      el.textContent = res.total === 0 ? "Taranacak soru kalmadı." : res.read + " soruda yazı bulundu (" + res.total + " soru tarandı).";
    });
    Array.prototype.forEach.call(sheet.querySelectorAll("[data-theme-opt]"), function (btn) {
      btn.addEventListener("click", async function () {
        settings.theme = btn.getAttribute("data-theme-opt");
        applyTheme(settings.theme);
        await saveSettings();
        Array.prototype.forEach.call(sheet.querySelectorAll("[data-theme-opt]"), function (b) {
          b.classList.toggle("active", b === btn);
        });
      });
    });
  }

  // ---------- trash panel ----------
  function openTrash() {
    var items = trash.slice().sort(function (a, b) { return (b.deletedAt || 0) - (a.deletedAt || 0); });
    var now = Date.now();
    var html;
    if (!items.length) {
      html = '<p class="hint">Çöp kutusu boş.</p>';
    } else {
      html = '<div class="trash-list">' + items.map(function (q) {
        var left = Math.max(0, Math.ceil(TRASH_DAYS - (now - (q.deletedAt || now)) / 86400000));
        return '<div class="trash-row"><div class="trash-main"><div class="trash-title">' +
          esc((q.subject || "Ders yok") + " › " + displayTopicOf(q)) + '</div><div class="trash-sub">' +
          left + " gün sonra silinecek</div></div>" +
          '<button type="button" class="btn sm" data-restore="' + esc(q.id) + '">Geri Al</button>' +
          '<button type="button" class="btn sm ghost" style="color:var(--danger);" data-purge="' + esc(q.id) + '">Sil</button></div>';
      }).join("") + "</div>" +
        '<p class="hint">Silinen sorular 30 gün sonra kalıcı olarak silinir.</p>' +
        '<button type="button" class="btn sm danger" id="trashEmpty">Çöp Kutusunu Boşalt</button>';
    }
    var sheet = openPanel("Çöp Kutusu", html, { back: true });
    Array.prototype.forEach.call(sheet.querySelectorAll("[data-restore]"), function (b) {
      b.addEventListener("click", async function () {
        await restoreFromTrash([b.getAttribute("data-restore")]);
        openTrash();
      });
    });
    Array.prototype.forEach.call(sheet.querySelectorAll("[data-purge]"), function (b) {
      b.addEventListener("click", async function () {
        await purgeFromTrash([b.getAttribute("data-purge")]);
        openTrash();
      });
    });
    var emptyBtn = document.getElementById("trashEmpty");
    if (emptyBtn) {
      var armed = false;
      emptyBtn.addEventListener("click", async function () {
        if (!armed) { armed = true; emptyBtn.textContent = "Emin misin? Tekrar dokun"; return; }
        await purgeFromTrash(trash.map(function (q) { return q.id; }));
        openTrash();
      });
    }
  }

  // Menu -> "Son Bakış": the notebook with only the starred questions.
  function openLastLook() {
    var n = allQuestions.filter(function (q) { return q.starred; }).length;
    if (!n) {
      showToast("Henüz yıldızlı soru yok. Detay ekranında ☆ ile işaretleyebilirsin.");
      return;
    }
    nav.subject = null;
    nav.topicKey = null;
    searchTerm = "";
    document.getElementById("searchBox").value = "";
    filterTag = null;
    filterStatus = "star";
    panelOnClose = function () { openNotebook(null); };
    closePanel(false);
  }

  function renderExamPill() {
    var el = document.getElementById("examPill");
    if (!el) return;
    var d = daysUntil(settings.exam.date, Date.now());
    if (d === null || d < 0 || nav.subject !== null) { el.hidden = true; return; }
    var name = settings.exam.name || "Sınav";
    el.textContent = d === 0 ? name + " bugün!" : name + " · " + d + " gün";
    el.hidden = false;
  }

  // ---------- rename / delete subjects and topics ----------
  function sameSubject(q, name) { return subjectKey(q.subject) === subjectKey(name); }

  function opRenameSubject(qs, oldName, newName) {
    if (!cleanTopic(newName)) return null;
    var target = canonicalSubject(newName, qs.filter(function (q) { return !sameSubject(q, oldName); }));
    var changed = false;
    var out = qs.map(function (q) {
      if (!sameSubject(q, oldName) || q.subject === target) return q;
      changed = true;
      return Object.assign({}, q, { subject: target });
    });
    return { questions: out, subject: target, changed: changed };
  }

  function opRenameTopic(qs, subject, oldKey, newName) {
    var clean = cleanTopic(newName);
    if (!clean) return null;
    var out = qs.map(function (q) {
      if (!sameSubject(q, subject) || topicKey(q.topic) !== oldKey) return q;
      return Object.assign({}, q, { topic: clean });
    });
    return { questions: out, topicKey: topicKey(clean) };
  }

  function opDeleteSubject(qs, name) {
    return {
      questions: qs.filter(function (q) { return !sameSubject(q, name); }),
      removed: qs.filter(function (q) { return sameSubject(q, name); })
    };
  }

  function opDeleteTopic(qs, subject, tKey, mode) {
    function hit(q) { return sameSubject(q, subject) && topicKey(q.topic) === tKey; }
    if (mode === "delete") {
      return { questions: qs.filter(function (q) { return !hit(q); }), removed: qs.filter(hit) };
    }
    return {
      questions: qs.map(function (q) { return hit(q) ? Object.assign({}, q, { topic: "" }) : q; }),
      removed: []
    };
  }

  async function commitEdit(newQs, removed, navAfter) {
    var now = Date.now();
    var movedIds = removed.map(function (q) { return q.id; });
    allQuestions = newQs;
    if (removed.length) {
      trash = removed.map(function (q) { return Object.assign({}, q, { deletedAt: now }); }).concat(trash);
      await saveTrash();
    }
    await saveQuestions(allQuestions);
    nav.subject = navAfter.subject;
    nav.topicKey = navAfter.topicKey;
    closePanel(false);
    await render();
    if (movedIds.length) {
      showToast(movedIds.length + " soru çöp kutusuna taşındı", "Geri Al", function () { restoreFromTrash(movedIds); });
    }
  }

  function editActionsHtml(kind) {
    var noun = kind === "subject" ? "Dersi" : "Konuyu";
    return '<div class="edit-actions">' +
      '<button type="button" class="btn sm" data-edit="rename">' + noun + " yeniden adlandır</button>" +
      '<button type="button" class="btn sm danger" data-edit="delete">' + noun + " sil</button></div>";
  }

  function bindEditActions(root, kind) {
    Array.prototype.forEach.call(root.querySelectorAll("[data-edit]"), function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("data-edit") === "rename") openRenamePanel(kind);
        else openDeletePanel(kind);
      });
    });
  }

  function openRenamePanel(kind) {
    var labelMap = buildTopicLabelMap(allQuestions);
    var cur = kind === "subject" ? nav.subject : (labelMap[nav.topicKey] || "");
    openPanel(kind === "subject" ? "Dersi Yeniden Adlandır" : "Konuyu Yeniden Adlandır",
      '<div class="field"><label>Yeni ad</label><input type="text" id="renameInput" maxlength="60" autocomplete="off" value="' + esc(cur) + '"></div>' +
      '<p class="form-err" id="renameErr" hidden>Ad boş olamaz.</p>' +
      '<div class="detail-actions"><button type="button" class="btn sm ghost" id="renameCancel">Vazgeç</button>' +
      '<button type="button" class="btn sm primary" id="renameOk">Kaydet</button></div>');
    document.getElementById("renameCancel").addEventListener("click", function () { closePanel(false); });
    document.getElementById("renameOk").addEventListener("click", async function () {
      var name = document.getElementById("renameInput").value;
      var res = kind === "subject"
        ? opRenameSubject(allQuestions, nav.subject, name)
        : opRenameTopic(allQuestions, nav.subject, nav.topicKey, name);
      if (!res) { document.getElementById("renameErr").hidden = false; return; }
      var navAfter = kind === "subject"
        ? { subject: res.subject, topicKey: nav.topicKey }
        : { subject: nav.subject, topicKey: res.topicKey };
      await commitEdit(res.questions, [], navAfter);
    });
  }

  function openDeletePanel(kind) {
    var isSubject = kind === "subject";
    var count = allQuestions.filter(function (q) {
      return sameSubject(q, nav.subject) && (isSubject || topicKey(q.topic) === nav.topicKey);
    }).length;
    var labelMap = buildTopicLabelMap(allQuestions);
    var name = isSubject ? nav.subject : (labelMap[nav.topicKey] || "Konusuz");
    var body = '<p class="confirm-text"><b>' + esc(name) + "</b> " + (isSubject ? "dersindeki" : "konusundaki") +
      " <b>" + count + "</b> soru etkilenecek.</p>";
    if (isSubject) {
      body += '<div class="detail-actions"><button type="button" class="btn sm ghost" id="delCancel">Vazgeç</button>' +
        '<button type="button" class="btn sm danger" id="delAll">Dersi ve soruları sil</button></div>';
    } else {
      body += '<div class="detail-actions" style="flex-direction:column;align-items:stretch;">' +
        '<button type="button" class="btn sm primary" id="delMove">Soruları “Konusuz”a taşı</button>' +
        '<button type="button" class="btn sm danger" id="delAll">Konuyu ve soruları sil</button>' +
        '<button type="button" class="btn sm ghost" id="delCancel">Vazgeç</button></div>';
    }
    openPanel(isSubject ? "Dersi Sil" : "Konuyu Sil", body);
    document.getElementById("delCancel").addEventListener("click", function () { closePanel(false); });
    document.getElementById("delAll").addEventListener("click", async function () {
      var res = isSubject
        ? opDeleteSubject(allQuestions, nav.subject)
        : opDeleteTopic(allQuestions, nav.subject, nav.topicKey, "delete");
      await commitEdit(res.questions, res.removed, { subject: isSubject ? null : nav.subject, topicKey: null });
    });
    if (!isSubject) {
      document.getElementById("delMove").addEventListener("click", async function () {
        var res = opDeleteTopic(allQuestions, nav.subject, nav.topicKey, "move");
        await commitEdit(res.questions, [], { subject: nav.subject, topicKey: null });
      });
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
    var loaded = await Promise.all([loadQuestions(), loadSettings(), loadJSON(REVIEWLOG_KEY, { days: {} }), loadTrash()]);
    allQuestions = loaded[0];
    if (loaded[2] && loaded[2].days) reviewLog = loaded[2];
    dataVersion++;
    applyTheme(settings.theme);
    if (questionsLoadedOk && normalizeSubjects(allQuestions)) {
      try { await saveQuestions(allQuestions); } catch (e) { console.error("subject merge save failed", e); }
    }
    await render();
    wireStaticEvents();
    purgeOldTrash().then(cleanupOrphanPhotos);
    refreshWidget();
    if (HD.reminders) HD.reminders.reschedule();
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

  // Replaces the current history entry's overlay name (no new back-step).
  function swapOverlayState(name) {
    try {
      history.replaceState({ subject: nav.subject, topicKey: nav.topicKey, overlay: name, depth: historyDepth }, "");
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
    if (chipFilterActive()) subEl.textContent += " · Filtreli";
  }

  async function render(animDir) {
    validateNav();
    renderNavHeader();
    renderStats();
    renderFilterChips();
    renderExamPill();
    await renderGrid(animDir);
  }

  function renderStats() {
    var total = allQuestions.length;
    var good = allQuestions.filter(function (q) { return !isDue(q); }).length;
    document.getElementById("statTotal").textContent = total;
    document.getElementById("statNeed").textContent = total - good;
    document.getElementById("statGood").textContent = good;
    var badge = document.getElementById("tabBadge");
    if (badge) {
      var need = total - good;
      badge.hidden = need === 0;
      badge.textContent = need > 99 ? "99+" : String(need);
    }
  }

  function sortNewestFirst(arr) {
    return (arr || []).slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function tagKeys(q) {
    var raw = Array.isArray(q.tags) ? q.tags.join(",") : String(q.tags || "");
    return raw.split(/[,;]+/)
      .map(function (t) { return t.trim().toLocaleLowerCase("tr-TR"); })
      .filter(Boolean);
  }

  function chipFilterActive() {
    return filterStatus !== "all" || filterTag !== null;
  }

  function filteredQuestions() {
    var term = searchTerm.trim().toLocaleLowerCase("tr-TR");
    var filtered = allQuestions.filter(function (q) {
      if (term) {
        var hay = [q.subject, q.topic, q.note, q.tags, q.correctAnswer, q.myAnswer, q.ocrText].join(" ").toLocaleLowerCase("tr-TR");
        if (hay.indexOf(term) === -1) return false;
      } else {
        if (nav.subject !== null && q.subject !== nav.subject) return false;
        if (nav.topicKey !== null && nav.topicKey !== ALL_TOPICS_KEY && topicKey(q.topic) !== nav.topicKey) return false;
      }
      if (filterStatus === "due" && !isDue(q)) return false;
      if (filterStatus === "done" && isDue(q)) return false;
      if (filterStatus === "star" && !q.starred) return false;
      if (filterTag && tagKeys(q).indexOf(filterTag) === -1) return false;
      return true;
    });
    return sortNewestFirst(filtered);
  }

  // Tags used across all questions, most used first: [{ key, label, count }]
  function allTagsInfo() {
    var map = {};
    var order = [];
    allQuestions.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (q) {
      var raw = Array.isArray(q.tags) ? q.tags.join(",") : String(q.tags || "");
      raw.split(/[,;]+/).forEach(function (t) {
        var label = t.trim();
        if (!label) return;
        var key = label.toLocaleLowerCase("tr-TR");
        if (!map[key]) { map[key] = { key: key, label: label, count: 0 }; order.push(map[key]); }
        map[key].count++;
      });
    });
    return order.sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label, "tr"); });
  }

  function renderFilterChips() {
    var box = document.getElementById("filterChips");
    if (!box) return;
    if (allQuestions.length === 0) { box.hidden = true; box.innerHTML = ""; return; }
    var tags = allTagsInfo();
    if (filterTag && !tags.some(function (t) { return t.key === filterTag; })) filterTag = null;
    var shown = tags.slice(0, 12);
    if (filterTag && !shown.some(function (t) { return t.key === filterTag; })) {
      shown.push(tags.filter(function (t) { return t.key === filterTag; })[0]);
    }
    var html = [["all", "Hepsi"], ["due", "Tekrar zamanı"], ["done", "Öğrenilen"], ["star", "★ Yıldızlı"]].map(function (st) {
      return '<button type="button" class="chip' + (filterStatus === st[0] ? " active" : "") + '" data-status="' + st[0] + '">' + st[1] + "</button>";
    }).join("");
    html += shown.map(function (t) {
      return '<button type="button" class="chip tag' + (filterTag === t.key ? " active" : "") + '" data-tag="' + esc(t.key) + '">#' + esc(t.label) + "</button>";
    }).join("");
    box.hidden = false;
    box.innerHTML = html;
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
    var chipActive = chipFilterActive();
    var flat = isSearching || chipActive;
    var labelMap = buildTopicLabelMap(allQuestions);

    // Level 1: Subjects list (when not searching and at root level)
    if (!flat && nav.subject === null && nav.topicKey === null) {
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
    if (!flat && nav.subject !== null && nav.topicKey === null) {
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

      grid.innerHTML = '<div class="nav-list">' + tRowsHtml + "</div>" + editActionsHtml("subject");
      bindEditActions(grid, "subject");

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

    var showSubjTopicPair = isSearching || nav.subject === null;
    var cardsHtml = list.map(function (q) {
      var cachedThumb = q.photoFile ? thumbSrcCache[q.photoFile] : null;
      var thumb = cachedThumb
        ? '<img src="' + cachedThumb + '" alt="" decoding="async">'
        : q.photoFile
        ? '<img data-thumb="' + esc(q.photoFile) + '" alt="" decoding="async">'
        : '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="13" r="3" stroke="currentColor" stroke-width="1.3"/></svg>';
      var badge = !isDue(q)
        ? '<span class="badge good">Öğrenildi</span>'
        : '<span class="badge need">Tekrar Et</span>';
      var tDisp = displayTopicOf(q, labelMap);
      var topicLine = showSubjTopicPair ? ((q.subject || "Ders yok") + " · " + tDisp) : tDisp;
      return (
        '<div class="card' + (selected[q.id] ? " selected" : "") + '">' +
        '<button class="card-btn" data-id="' + esc(q.id) + '">' +
        (selectMode ? '<span class="sel-dot' + (selected[q.id] ? " on" : "") + '"></span>' : "") +
        '<div class="thumb">' + thumb + "</div>" +
        '<div class="body">' +
        '<div class="tagrow"><span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "Ders yok") + "</span>" +
        (q.starred ? '<span class="star-mark">★</span>' : "") + (photosOf(q).length > 1 ? '<span class="pages-mark">' + photosOf(q).length + " sayfa</span>" : "") + "</div>" +
        '<p class="topic">' + esc(topicLine) + "</p>" +
        '<p class="snippet">' + esc(q.note || "") + "</p>" +
        '<div class="meta"><span class="date mono">' + fmtDate(q.createdAt) + "</span>" + badge + "</div>" +
        "</div>" +
        "</button>" +
        "</div>"
      );
    }).join("");

    var topicEditable = !flat && nav.subject !== null && nav.topicKey !== null &&
      nav.topicKey !== ALL_TOPICS_KEY && nav.topicKey !== EMPTY_TOPIC_KEY;
    grid.innerHTML = '<div class="card-list">' + cardsHtml + "</div>" + (topicEditable ? editActionsHtml("topic") : "");
    if (topicEditable) bindEditActions(grid, "topic");
    hydrateThumbs(grid);

    Array.prototype.forEach.call(grid.querySelectorAll(".card-btn"), function (btn) {
      var id = btn.getAttribute("data-id");
      var pressTimer = null, longFired = false;
      function cancelPress() { clearTimeout(pressTimer); }
      btn.addEventListener("touchstart", function () {
        longFired = false;
        pressTimer = setTimeout(function () {
          longFired = true;
          if (!selectMode) enterSelect(id); else toggleSelected(id);
        }, 480);
      }, { passive: true });
      btn.addEventListener("touchend", cancelPress);
      btn.addEventListener("touchmove", cancelPress, { passive: true });
      btn.addEventListener("touchcancel", cancelPress);
      btn.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        if (!selectMode) enterSelect(id);
      });
      btn.addEventListener("click", function () {
        if (longFired) { longFired = false; return; }
        if (selectMode) { toggleSelected(id); return; }
        var q = allQuestions.find(function (x) { return x.id === id; });
        if (q) openDetail(q);
      });
    });
  }

  // ---------- multi-select on the list ----------
  function selectedList() {
    return allQuestions.filter(function (q) { return selected[q.id]; });
  }
  function updateSelBar() {
    document.body.classList.toggle("sel", selectMode);
    var bar = document.getElementById("selBar");
    bar.hidden = !selectMode;
    if (selectMode) document.getElementById("selCount").textContent = selectedList().length + " seçili";
  }
  function enterSelect(id) {
    selectMode = true;
    selected = {};
    selected[id] = true;
    pushOverlayState("select");
    updateSelBar();
    renderGrid();
  }
  function exitSelect(fromPopstate) {
    if (!selectMode) return;
    if (fromPopstate !== true && history.state && history.state.overlay === "select") {
      history.back(); // popstate handler finishes
      return;
    }
    selectMode = false;
    selected = {};
    updateSelBar();
    renderGrid();
  }
  function toggleSelected(id) {
    if (selected[id]) delete selected[id]; else selected[id] = true;
    updateSelBar();
    renderGrid();
  }
  // Leaves select mode after an action that happened inside a panel (pops both entries).
  function exitSelectFromPanel() {
    var st = history.state || {};
    if (st.overlay === "panel" && typeof history.go === "function") {
      history.go(-2);
    } else {
      closePanel(false);
      exitSelect(false);
    }
  }

  function openMovePanel() {
    var list = selectedList();
    if (!list.length) return;
    var subs = {};
    allQuestions.forEach(function (q) { if (q.subject) subs[q.subject] = true; });
    var html =
      '<p class="confirm-text">' + list.length + " soru taşınacak.</p>" +
      '<div class="field"><label>Ders</label><input type="text" id="mvSubject" list="mvSubjects" maxlength="60" autocomplete="off" placeholder="Ders adı">' +
      '<datalist id="mvSubjects">' + Object.keys(subs).map(function (n) { return '<option value="' + esc(n) + '">'; }).join("") + "</datalist></div>" +
      '<div class="field"><label>Konu <small>(boş bırakırsan konusuz olur)</small></label><input type="text" id="mvTopic" maxlength="60" autocomplete="off" placeholder="Konu adı"></div>' +
      '<p class="form-err" id="mvErr" hidden>Ders adı boş olamaz.</p>' +
      '<div class="detail-actions"><button type="button" class="btn sm ghost" id="mvCancel">Vazgeç</button>' +
      '<button type="button" class="btn sm primary" id="mvOk">Taşı</button></div>';
    openPanel("Taşı", html);
    document.getElementById("mvCancel").addEventListener("click", function () { closePanel(false); });
    document.getElementById("mvOk").addEventListener("click", async function () {
      var subj = cleanTopic(document.getElementById("mvSubject").value);
      var topic = cleanTopic(document.getElementById("mvTopic").value);
      if (!subj) { document.getElementById("mvErr").hidden = false; return; }
      var ids = {};
      selectedList().forEach(function (q) { ids[q.id] = true; });
      var target = canonicalSubject(subj, allQuestions.filter(function (q) { return !ids[q.id]; }));
      allQuestions = allQuestions.map(function (q) {
        return ids[q.id] ? Object.assign({}, q, { subject: target, topic: topic }) : q;
      });
      await saveQuestions(allQuestions);
      exitSelectFromPanel();
      await render();
    });
  }

  async function starSelected() {
    var list = selectedList();
    if (!list.length) return;
    var allOn = list.every(function (q) { return q.starred; });
    var ids = {};
    list.forEach(function (q) { ids[q.id] = true; });
    allQuestions = allQuestions.map(function (q) {
      return ids[q.id] ? Object.assign({}, q, { starred: !allOn }) : q;
    });
    await saveQuestions(allQuestions);
    exitSelect(false);
    await render();
  }

  async function deleteSelected() {
    var list = selectedList();
    if (!list.length) return;
    exitSelect(false);
    await moveToTrash(list);
  }

  async function toggleStar(q) {
    var live = allQuestions.filter(function (x) { return x.id === q.id; })[0] || q;
    live.starred = !live.starred;
    await saveQuestions(allQuestions);
    await render();
    return live.starred;
  }

  // ---------- add / edit form ----------
  var CAMERA_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="13" r="3.2" stroke="currentColor" stroke-width="1.4"/></svg>';
  var PHOTO_UI = {
    photo:    { box: "photoInputBox", prev: "photoPreviewBox", text: "photoText", rm: "photoRemove", empty: "Kamerayla çek ya da galeriden seç" },
    solution: { box: "solInputBox",   prev: "solPreviewBox",   text: "solText",   rm: "solRemove",   empty: "Çözümün fotoğrafını ekle (isteğe bağlı)" }
  };

  async function refreshPhotoUI(kind) {
    var ui = PHOTO_UI[kind];
    var prev = document.getElementById(ui.prev);
    var text = document.getElementById(ui.text);
    var rm = document.getElementById(ui.rm);
    var f = pending[kind];
    var src = f ? await getPhotoSrc(f) : null;
    if (src) {
      prev.innerHTML = '<img src="' + src + '" alt="">';
      text.textContent = "Değiştirmek için dokun";
      rm.hidden = false;
    } else {
      prev.innerHTML = CAMERA_SVG;
      text.textContent = ui.empty;
      rm.hidden = true;
    }
  }

  // Deletes a photo that was taken in this form session but not saved yet.
  async function dropSessionPhoto(filename) {
    if (filename && sessionPhotos.indexOf(filename) !== -1) {
      sessionPhotos = sessionPhotos.filter(function (f) { return f !== filename; });
      await deletePhotoFile(filename);
    }
  }

  async function pickPhoto(kind) {
    var ui = PHOTO_UI[kind];
    var text = document.getElementById(ui.text);
    if (!Camera && !webMode) {
      text.textContent = "Kamera yalnızca Android uygulamasında çalışır";
      return;
    }
    try {
      text.textContent = "Açılıyor…";
      var filename = await takePhotoAndStore();
      if (filename) {
        await dropSessionPhoto(pending[kind]);
        sessionPhotos.push(filename);
        pending[kind] = filename;
      }
    } catch (e) {
      // user cancelled the camera/gallery picker - not an error
    }
    await refreshPhotoUI(kind);
  }

  async function removePhoto(kind) {
    await dropSessionPhoto(pending[kind]);
    pending[kind] = null; // an original photo is deleted when the form is saved
    await refreshPhotoUI(kind);
  }

  // ----- extra question pages -----
  async function refreshExtraUI() {
    var box = document.getElementById("extraList");
    if (!box) return;
    var srcs = await Promise.all(pending.extra.map(getPhotoSrc));
    box.innerHTML = pending.extra.map(function (f, i) {
      return '<div class="extra-item">' + (srcs[i] ? '<img src="' + srcs[i] + '" alt="">' : "") +
        '<span class="extra-no">' + (i + 2) + '</span>' +
        '<button type="button" class="extra-rm" data-i="' + i + '" aria-label="Sayfayı kaldır">×</button></div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".extra-rm"), function (btn) {
      btn.addEventListener("click", async function () {
        var idx = parseInt(btn.getAttribute("data-i"), 10);
        var f = pending.extra[idx];
        pending.extra = pending.extra.filter(function (x, j) { return j !== idx; });
        await dropSessionPhoto(f);
        await refreshExtraUI();
      });
    });
  }

  async function pickExtra() {
    if (!Camera && !webMode) return;
    var btn = document.getElementById("extraAdd");
    try {
      btn.disabled = true;
      var filename = await takePhotoAndStore();
      if (filename) {
        sessionPhotos.push(filename);
        pending.extra = pending.extra.concat([filename]);
      }
    } catch (e) {
      // cancelled
    }
    btn.disabled = false;
    await refreshExtraUI();
  }

  // ----- error-reason chips (they edit the comma separated tags field) -----
  function splitTags(str) {
    return String(str || "").split(/[,;]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  }
  function syncReasonChips() {
    var box = document.getElementById("reasonChips");
    if (!box) return;
    var have = splitTags(document.getElementById("f_tags").value).map(function (t) { return t.toLocaleLowerCase("tr-TR"); });
    box.innerHTML = REASONS.map(function (r) {
      var on = have.indexOf(r.toLocaleLowerCase("tr-TR")) !== -1;
      return '<button type="button" class="chip' + (on ? " active" : "") + '" data-reason="' + esc(r) + '">' + esc(r) + "</button>";
    }).join("");
  }
  function toggleReason(reason) {
    var input = document.getElementById("f_tags");
    var tags = splitTags(input.value);
    var key = reason.toLocaleLowerCase("tr-TR");
    var idx = tags.map(function (t) { return t.toLocaleLowerCase("tr-TR"); }).indexOf(key);
    if (idx === -1) tags.push(reason); else tags.splice(idx, 1);
    input.value = tags.join(", ");
    syncReasonChips();
  }

  function resetForm() {
    editingId = null;
    pending = { photo: null, solution: null, extra: [] };
    original = { photo: null, solution: null, extra: [] };
    sessionPhotos = [];
    document.getElementById("qform").reset();
    refreshPhotoUI("photo");
    refreshPhotoUI("solution");
    refreshExtraUI();
    syncReasonChips();
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
    pending = { photo: q.photoFile || null, solution: q.solutionFile || null, extra: (q.extraPhotos || []).slice() };
    original = { photo: q.photoFile || null, solution: q.solutionFile || null, extra: (q.extraPhotos || []).slice() };
    document.getElementById("formTitle").textContent = "Soruyu Düzenle";
    document.getElementById("formSubmit").textContent = "Güncelle";
    document.getElementById("f_subject").value = q.subject || "";
    document.getElementById("f_topic").value = q.topic || "";
    document.getElementById("f_my").value = q.myAnswer || "";
    document.getElementById("f_correct").value = q.correctAnswer || "";
    document.getElementById("f_note").value = q.note || "";
    document.getElementById("f_tags").value = q.tags || "";
    syncReasonChips();
    renderTopicSuggestions();
    document.getElementById("formOverlay").hidden = false;
    await refreshPhotoUI("photo");
    await refreshPhotoUI("solution");
    await refreshExtraUI();
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
    pending = { photo: null, solution: null, extra: [] };
    document.getElementById("formOverlay").hidden = true;
    toDelete.forEach(function (f) { deletePhotoFile(f); });
  }

  function wireStaticEvents() {
    document.getElementById("f_subject").addEventListener("input", renderTopicSuggestions);
    document.getElementById("f_subject").addEventListener("change", renderTopicSuggestions);

    document.getElementById("extraAdd").addEventListener("click", pickExtra);
    document.getElementById("reasonChips").addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("button") : null;
      if (btn && btn.hasAttribute("data-reason")) toggleReason(btn.getAttribute("data-reason"));
    });
    document.getElementById("f_tags").addEventListener("input", syncReasonChips);
    Object.keys(PHOTO_UI).forEach(function (kind) {
      var ui = PHOTO_UI[kind];
      document.getElementById(ui.box).addEventListener("click", function () { pickPhoto(kind); });
      document.getElementById(ui.rm).addEventListener("click", function () { removePhoto(kind); });
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
          photoFile: pending.photo || null,
          solutionFile: pending.solution || null,
          extraPhotos: pending.extra.slice()
        };
        if (editingId && original.photo !== data.photoFile) { data.ocrText = ""; data.ocrDone = false; }

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
          data.starred = false;
          allQuestions.unshift(data);
        }

        var currentNbQId = (!document.getElementById("notebookScreen").hidden && notebookList[notebookIdx])
          ? notebookList[notebookIdx].id
          : null;

        await saveQuestions(allQuestions);
        if (original.photo && original.photo !== data.photoFile) await deletePhotoFile(original.photo);
        if (original.solution && original.solution !== data.solutionFile) await deletePhotoFile(original.solution);
        for (var xi = 0; xi < original.extra.length; xi++) {
          if (data.extraPhotos.indexOf(original.extra[xi]) === -1) await deletePhotoFile(original.extra[xi]);
        }
        original = { photo: null, solution: null, extra: [] };
        sessionPhotos = [];
        var ocrId = editedQuestionId || data.id;
        closeForm(false);
        await render();
        if (HD.ocr && HD.ocr.available()) HD.ocr.runForQuestion(ocrId); // reads the text in the background
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

      var cropEl = document.getElementById("cropScreen");
      if (cropEl && !cropEl.hidden && targetOverlay !== "crop") { if (HD.crop) HD.crop.cancel(true); return; }
      var formEl = document.getElementById("formOverlay");
      if (formEl && !formEl.hidden && targetOverlay !== "form") { closeForm(true); return; }
      var detailEl = document.getElementById("detailOverlay");
      if (detailEl && !detailEl.hidden && targetOverlay !== "detail") { closeDetail(true); return; }
      var reviewEl = document.getElementById("reviewScreen");
      if (reviewEl && !reviewEl.hidden && targetOverlay !== "review") { closeReview(true); return; }
      var panelEl = document.getElementById("panelOverlay");
      if (panelEl && !panelEl.hidden && targetOverlay !== "panel") {
        closePanel(true);
        if (selectMode && targetOverlay !== "select") exitSelect(true);
        return;
      }
      var examEl = document.getElementById("examScreen");
      if (examEl && !examEl.hidden && targetOverlay !== "exam") { if (HD.exam) HD.exam.close(true); return; }
      if (selectMode && targetOverlay !== "select") { exitSelect(true); return; }

      var zoomEl = document.getElementById("photoZoomOverlay");
      if (zoomEl && !zoomEl.hidden && targetOverlay !== "zoom") {
        closePhotoZoom(true);
        if (targetOverlay === "notebook" || targetOverlay === "toc") return;
      }

      // Still inside one of these overlays: nothing below it should change.
      if (["form", "crop", "panel", "detail", "review", "exam", "select"].indexOf(targetOverlay) !== -1) return;

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

    document.getElementById("filterChips").addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!btn) return;
      if (btn.hasAttribute("data-status")) {
        filterStatus = btn.getAttribute("data-status");
      } else if (btn.hasAttribute("data-tag")) {
        var key = btn.getAttribute("data-tag");
        filterTag = filterTag === key ? null : key;
      } else {
        return;
      }
      render();
    });
    document.getElementById("btnMenu").addEventListener("click", openMenu);
    document.getElementById("examPill").addEventListener("click", openSettings);
    document.getElementById("selMove").addEventListener("click", openMovePanel);
    document.getElementById("selStar").addEventListener("click", starSelected);
    document.getElementById("selDelete").addEventListener("click", deleteSelected);
    document.getElementById("selCancel").addEventListener("click", function () { exitSelect(false); });
    document.getElementById("selAll").addEventListener("click", function () {
      selected = {};
      filteredQuestions().forEach(function (q) { selected[q.id] = true; });
      updateSelBar();
      renderGrid();
    });
    // hide the tab bar while the keyboard is open so it does not cover the list
    function isTextField(el) { return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""); }
    document.addEventListener("focusin", function (e) {
      if (isTextField(e.target) && document.body) document.body.classList.add("kb");
    });
    document.addEventListener("focusout", function () {
      if (document.body) document.body.classList.remove("kb");
    });
    attachSheetSwipe(document.getElementById("formOverlay").querySelector(".sheet"), function () { closeForm(false); });
    attachSheetSwipe(document.getElementById("detailSheet"), function () { closeDetail(false); });
    attachSheetSwipe(document.getElementById("panelSheet"), function () { closePanel(false); });
    attachSheetSwipe(document.getElementById("nbTocSheet"), function () { closeNotebookToc(false, null); });
    document.getElementById("panelOverlay").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) closePanel(false);
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        refreshWidget();
        if (HD.reminders) HD.reminders.reschedule();
      }
    });

    var searchTimer = null;
    document.getElementById("searchBox").addEventListener("input", function (e) {
      searchTerm = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        renderNavHeader();
        renderGrid();
      }, 140);
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

  async function shareQuestion(q) {
    var lines = [(q.subject || "") + " › " + displayTopicOf(q)];
    if (q.myAnswer) lines.push("Benim cevabım: " + q.myAnswer);
    if (q.correctAnswer) lines.push("Doğru cevap: " + q.correctAnswer);
    if (q.note) lines.push("Not: " + q.note);
    var text = lines.join("\n");
    var Share = Plugins.Share;
    if (!isNative || !Share) {
      if (navigator.share) {
        try { await navigator.share({ title: "Hata Defterim", text: text }); } catch (e) {}
      } else {
        showToast("Paylaşma yalnızca Android uygulamasında çalışır");
      }
      return;
    }
    var uris = [];
    try {
      var pages = photosOf(q);
      try { await Filesystem.mkdir({ path: "share", directory: "CACHE", recursive: true }); } catch (e) {}
      for (var i = 0; i < pages.length; i++) {
        var to = "share/" + pages[i];
        try { await Filesystem.deleteFile({ path: to, directory: "CACHE" }); } catch (e) {}
        await Filesystem.copy({ from: PHOTOS_DIR + "/" + pages[i], directory: "DATA", to: to, toDirectory: "CACHE" });
        uris.push((await Filesystem.getUri({ path: to, directory: "CACHE" })).uri);
      }
    } catch (e) {
      console.warn("could not prepare photos for sharing", e);
    }
    try {
      var payload = { title: "Hata Defterim", text: text, dialogTitle: "Soruyu paylaş" };
      if (uris.length) payload.files = uris;
      await Share.share(payload);
    } catch (e) {
      // the person closed the share sheet
    }
  }

  async function openDetail(q) {
    var sheet = document.getElementById("detailSheet");
    var srcs = await Promise.all(photosOf(q).map(getPhotoSrc));
    var img = srcs.map(function (src, i) {
      if (!src) return "";
      return (i > 0 ? '<div class="page-label">Sayfa ' + (i + 1) + "</div>" : "") + '<img class="detail-img" src="' + src + '" alt="">';
    }).join("");
    var solSrc = q.solutionFile ? await getPhotoSrc(q.solutionFile) : null;
    var tags = splitTags(q.tags);
    var tDisp = displayTopicOf(q);
    sheet.innerHTML =
      '<div class="sheet-head">' +
      "<h2>" + esc(tDisp || q.subject || "Soru") + "</h2>" +
      '<div class="head-actions">' +
      '<button type="button" class="starbtn' + (q.starred ? " on" : "") + '" id="detailStar" aria-label="Yıldızla">' + (q.starred ? "★" : "☆") + "</button>" +
      '<button class="closex" id="detailClose" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "</div></div>" +
      img +
      '<div class="tagrow" style="margin-bottom:10px;">' +
      '<span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "") + "</span>" +
      (!isDue(q) ? '<span class="badge good">Öğrenildi</span>' : '<span class="badge need">Tekrar Et</span>') +
      "</div>" +
      (q.myAnswer ? '<div class="detail-row"><label>Benim Cevabım</label><div class="val">' + esc(q.myAnswer) + "</div></div>" : "") +
      (q.correctAnswer ? '<div class="detail-row"><label>Doğru Cevap</label><div class="val">' + esc(q.correctAnswer) + "</div></div>" : "") +
      (q.note ? '<div class="detail-row"><label>Not</label><div class="val">' + esc(q.note) + "</div></div>" : "") +
      (solSrc ? '<div class="detail-row"><label>Çözüm</label><img class="detail-img" src="' + solSrc + '" alt="Çözüm"></div>' : "") +
      (tags.length ? '<div class="detail-row"><label>Etiketler</label><div class="val">' + tags.map(function (t) { return esc(t); }).join(" · ") + "</div></div>" : "") +
      (q.ocrText ? '<div class="detail-row"><label>Okunan Metin</label><div class="val ocr-text">' + esc(q.ocrText) + "</div></div>" : "") +
      (q.mastered && q.dueAt ? '<div class="detail-row"><label>Sonraki Tekrar</label><div class="val mono">' + fmtDate(q.dueAt) + "</div></div>" : "") +
      '<div class="detail-row"><label>Eklenme</label><div class="val mono">' + fmtDate(q.createdAt) + (q.reviewCount ? " · " + q.reviewCount + " kez tekrar edildi" : "") + "</div></div>" +
      '<div class="detail-actions">' +
      '<button class="btn sm" id="detailEdit">Düzenle</button>' +
      '<button class="btn sm ' + (!isDue(q) ? "" : "good") + '" id="detailToggleMaster">' + (!isDue(q) ? "Tekrar Listesine Al" : "Öğrendim Olarak İşaretle") + "</button>" +
      '<button class="btn sm" id="detailShare">Paylaş</button>' +
      '<button class="btn sm ghost" id="detailDelete" style="color:var(--danger);">Sil</button>' +
      "</div>";

    document.getElementById("detailOverlay").hidden = false;
    pushOverlayState("detail");

    document.getElementById("detailClose").addEventListener("click", function () {
      closeDetail(false);
    });
    document.getElementById("detailStar").addEventListener("click", async function () {
      var on = await toggleStar(q);
      var b = document.getElementById("detailStar");
      b.textContent = on ? "★" : "☆";
      b.classList.toggle("on", on);
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
    document.getElementById("detailShare").addEventListener("click", function () { shareQuestion(q); });
    document.getElementById("detailDelete").addEventListener("click", async function () {
      closeDetail(false);
      await moveToTrash([q]);
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
    var srcs = await Promise.all(photosOf(q).map(getPhotoSrc));
    var img = srcs.filter(Boolean).map(function (u) { return '<img src="' + u + '" alt="">'; }).join("");
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
    document.getElementById("btnReveal").addEventListener("click", async function () {
      var solSrc = q.solutionFile ? await getPhotoSrc(q.solutionFile) : null;
      document.getElementById("answerBox").innerHTML =
        '<div class="review-answer">' +
        (q.correctAnswer ? "<div><div class=\"lbl\">Doğru Cevap</div><div>" + esc(q.correctAnswer) + "</div></div>" : "") +
        (q.myAnswer ? "<div><div class=\"lbl\">Senin Cevabın</div><div>" + esc(q.myAnswer) + "</div></div>" : "") +
        (q.note ? "<div><div class=\"lbl\">Not</div><div>" + esc(q.note) + "</div></div>" : "") +
        (solSrc ? "<div><div class=\"lbl\">Çözüm</div><img class=\"sol-img\" src=\"" + solSrc + "\" alt=\"Çözüm\"></div>" : "") +
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
    logReview(mastered);
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
    var solSrc = q.solutionFile ? await getPhotoSrc(q.solutionFile) : null;
    var extraSrcs = (await Promise.all((q.extraPhotos || []).map(getPhotoSrc))).filter(Boolean);
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
      extraSrcs.map(function (u) { return '<img class="nb-photo nb-extra" src="' + u + '" alt="Ek sayfa">'; }).join("") +
      '<div class="nb-fields">' +
      '<div class="nb-ans-grid">' +
      '<div class="nb-field"><label>Benim Cevabım</label><div class="val">' + esc(q.myAnswer || "—") + "</div></div>" +
      '<div class="nb-field"><label>Doğru Cevap</label><div class="val">' + esc(q.correctAnswer || "—") + "</div></div>" +
      "</div>" +
      '<div class="nb-field"><label>Neden Yanlış Yaptım</label><div class="val">' + esc(q.note || "—") + "</div></div>" +
      (tags.length ? '<div class="nb-field"><label>Etiketler</label><div class="val">' + tags.map(function (t) { return esc(t); }).join(" · ") + "</div></div>" : "") +
      (solSrc ? '<div class="nb-field"><label>Çözüm</label><img class="nb-photo" id="nbSolution" src="' + solSrc + '" alt="Çözüm"></div>' : "") +
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
    Array.prototype.forEach.call(document.querySelectorAll(".nb-extra"), function (el) {
      el.addEventListener("click", function () { openPhotoZoom(el.getAttribute("src")); });
    });
    var solEl = document.getElementById("nbSolution");
    if (solEl) {
      solEl.addEventListener("click", function () { openPhotoZoom(solSrc); });
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

  Object.assign(HD, {
    isNative: isNative,
    webMode: webMode,
    Plugins: Plugins,
    getQuestions: function () { return allQuestions; },
    saveQuestions: function (arr) { if (arr) allQuestions = arr; return saveQuestions(allQuestions); },
    getReviewLog: function () { return reviewLog; },
    getSettings: function () { return settings; },
    isDue: isDue, scheduleNext: scheduleNext, resetSchedule: resetSchedule, logReview: logReview, dateKey: dateKey,
    esc: esc, fmtDate: fmtDate, colorFor: colorFor, topicKey: topicKey, cleanTopic: cleanTopic,
    subjectKey: subjectKey, displayTopicOf: displayTopicOf, buildTopicLabelMap: buildTopicLabelMap,
    EMPTY_TOPIC_KEY: EMPTY_TOPIC_KEY, tagKeys: tagKeys,
    getPhotoSrc: getPhotoSrc, getThumbSrc: getThumbSrc, openPhotoZoom: openPhotoZoom, loadImage: loadImage,
    filteredQuestions: filteredQuestions, sortForNotebook: function (a) { return sortForNotebook(a); },
    currentScopeLabel: function () {
      if (nav.subject === null) return "Tüm sorular";
      if (nav.topicKey === null || nav.topicKey === ALL_TOPICS_KEY) return nav.subject;
      return nav.subject + " › " + (buildTopicLabelMap(allQuestions)[nav.topicKey] || "Konusuz");
    },
    attachSheetSwipe: attachSheetSwipe,
    photosOf: photosOf, splitTags: splitTags, daysUntil: daysUntil,
    getTrash: function () { return trash; },
    moveToTrash: moveToTrash, restoreFromTrash: restoreFromTrash,
    updateQuestion: async function (id, patch) {
      var found = false;
      allQuestions = allQuestions.map(function (q) {
        if (q.id !== id) return q;
        found = true;
        return Object.assign({}, q, patch);
      });
      if (found) await saveQuestions(allQuestions);
      return found;
    },
    showToast: showToast,
    setPanel: setPanel, openPanel: openPanel, closePanel: closePanel, openMenu: openMenu, leavePanelFor: leavePanelFor,
    pushOverlayState: pushOverlayState, swapOverlayState: swapOverlayState,
    render: function () { return render(); }
  });

  document.addEventListener("DOMContentLoaded", init);
})();
