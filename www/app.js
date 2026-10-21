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

  var STORAGE_KEY = "hata_defterim_questions_v1";
  var PHOTOS_DIR = "photos";

  var allQuestions = [];
  var photoSrcCache = {}; // filename -> resolved webview src
  var selectedSubject = "all";
  var searchTerm = "";
  var editingId = null;
  var pendingPhotoFilename = null;
  var pendingPhotoPreviewDataUrl = null;
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

  // ---------- storage ----------
  async function loadQuestions() {
    if (!Preferences) return [];
    try {
      var res = await Preferences.get({ key: STORAGE_KEY });
      return res && res.value ? JSON.parse(res.value) : [];
    } catch (e) {
      console.error("loadQuestions failed", e);
      return [];
    }
  }

  async function saveQuestions(arr) {
    if (!Preferences) return;
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(arr) });
  }

  async function takePhotoAndStore() {
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
    if (!filename || !Filesystem) return;
    try { await Filesystem.deleteFile({ path: PHOTOS_DIR + "/" + filename, directory: "DATA" }); }
    catch (e) { /* already gone, ignore */ }
    delete photoSrcCache[filename];
  }

  // ---------- init ----------
  async function init() {
    if (!isNative) {
      document.getElementById("storageWarning").hidden = false;
      document.getElementById("btnAdd").disabled = true;
      document.getElementById("btnReview").disabled = true;
    }
    allQuestions = await loadQuestions();
    await render();
    wireStaticEvents();
  }

  // ---------- render ----------
  async function render() {
    renderTabs();
    renderStats();
    await renderGrid();
  }

  function renderTabs() {
    var subjects = [];
    allQuestions.forEach(function (q) {
      if (q.subject && subjects.indexOf(q.subject) === -1) subjects.push(q.subject);
    });
    var tabs = document.getElementById("subjectTabs");
    var html = '<button class="tab' + (selectedSubject === "all" ? " active" : "") + '" data-subject="all" style="' + (selectedSubject === "all" ? "background:var(--ink);" : "") + '">Tümü</button>';
    subjects.forEach(function (s) {
      var active = selectedSubject === s;
      var c = colorFor(s);
      html += '<button class="tab' + (active ? " active" : "") + '" data-subject="' + esc(s) + '" style="' + (active ? "background:" + c + ";" : "") + '">' + esc(s) + "</button>";
    });
    tabs.innerHTML = html;
    Array.prototype.forEach.call(tabs.querySelectorAll(".tab"), function (btn) {
      btn.addEventListener("click", function () {
        selectedSubject = btn.getAttribute("data-subject");
        render();
      });
    });
  }

  function renderStats() {
    var total = allQuestions.length;
    var good = allQuestions.filter(function (q) { return !!q.mastered; }).length;
    document.getElementById("statTotal").textContent = total;
    document.getElementById("statNeed").textContent = total - good;
    document.getElementById("statGood").textContent = good;
  }

  function filteredQuestions() {
    var term = searchTerm.trim().toLowerCase();
    return allQuestions.filter(function (q) {
      if (selectedSubject !== "all" && q.subject !== selectedSubject) return false;
      if (!term) return true;
      var hay = [q.subject, q.topic, q.note, q.tags, q.correctAnswer, q.myAnswer].join(" ").toLowerCase();
      return hay.indexOf(term) !== -1;
    });
  }

  async function renderGrid() {
    var list = filteredQuestions();
    var grid = document.getElementById("grid");
    var empty = document.getElementById("emptyState");

    if (allQuestions.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }
    if (list.length === 0) {
      grid.innerHTML = '<p class="hint" style="grid-column:1/-1;">Bu filtreyle eşleşen soru yok.</p>';
      empty.hidden = true;
      return;
    }
    empty.hidden = true;

    var srcs = {};
    await Promise.all(list.map(async function (q) {
      if (q.photoFile) srcs[q.id] = await getPhotoSrc(q.photoFile);
    }));

    grid.innerHTML = list.map(function (q) {
      var src = srcs[q.id];
      var thumb = src
        ? '<img src="' + src + '" alt="">'
        : '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="13" r="3" stroke="currentColor" stroke-width="1.3"/></svg>';
      var badge = q.mastered
        ? '<span class="badge good">Öğrenildi</span>'
        : '<span class="badge need">Tekrar Et</span>';
      return (
        '<div class="card">' +
        '<button class="card-btn" data-id="' + esc(q.id) + '">' +
        '<div class="thumb">' + thumb + "</div>" +
        '<div class="body">' +
        '<div class="tagrow"><span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "Ders yok") + "</span></div>" +
        '<p class="topic">' + esc(q.topic || "Konu belirtilmedi") + "</p>" +
        '<p class="snippet">' + esc(q.note || "") + "</p>" +
        '<div class="meta"><span class="date mono">' + fmtDate(q.createdAt) + "</span>" + badge + "</div>" +
        "</div>" +
        "</button>" +
        "</div>"
      );
    }).join("");

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
    document.getElementById("qform").reset();
    document.getElementById("photoPreviewBox").innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="13" r="3.2" stroke="currentColor" stroke-width="1.4"/></svg>';
    document.getElementById("photoText").textContent = "Kamerayla çek ya da galeriden seç";
    document.getElementById("formErr").hidden = true;
    document.getElementById("formTitle").textContent = "Yeni Soru Ekle";
    document.getElementById("formSubmit").textContent = "Kaydet";
  }

  function fillSubjectTopicLists() {
    var subjSet = {}, topicSet = {};
    allQuestions.forEach(function (q) {
      if (q.subject) subjSet[q.subject] = true;
      if (q.topic) topicSet[q.topic] = true;
    });
    document.getElementById("subjectList").innerHTML = Object.keys(subjSet).map(function (s) { return '<option value="' + esc(s) + '">'; }).join("");
    document.getElementById("topicList").innerHTML = Object.keys(topicSet).map(function (t) { return '<option value="' + esc(t) + '">'; }).join("");
  }

  function openAddModal() {
    resetForm();
    fillSubjectTopicLists();
    document.getElementById("formOverlay").hidden = false;
  }

  async function openEditModal(q) {
    resetForm();
    fillSubjectTopicLists();
    editingId = q.id;
    pendingPhotoFilename = q.photoFile || null;
    document.getElementById("formTitle").textContent = "Soruyu Düzenle";
    document.getElementById("formSubmit").textContent = "Güncelle";
    document.getElementById("f_subject").value = q.subject || "";
    document.getElementById("f_topic").value = q.topic || "";
    document.getElementById("f_my").value = q.myAnswer || "";
    document.getElementById("f_correct").value = q.correctAnswer || "";
    document.getElementById("f_note").value = q.note || "";
    document.getElementById("f_tags").value = q.tags || "";
    if (q.photoFile) {
      var src = await getPhotoSrc(q.photoFile);
      if (src) {
        document.getElementById("photoPreviewBox").innerHTML = '<img src="' + src + '">';
        document.getElementById("photoText").textContent = "Fotoğrafı değiştirmek için dokun";
      }
    }
    document.getElementById("formOverlay").hidden = false;
  }

  function wireStaticEvents() {
    document.getElementById("photoInputBox").addEventListener("click", async function () {
      if (!Camera) {
        document.getElementById("photoText").textContent = "Kamera yalnızca Android uygulamasında çalışır";
        return;
      }
      try {
        document.getElementById("photoText").textContent = "Açılıyor…";
        var filename = await takePhotoAndStore();
        if (filename) {
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
        var data = {
          subject: subject,
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
          data.reviewCount = 0;
          data.lastReviewedAt = null;
          allQuestions.unshift(data);
        }

        await saveQuestions(allQuestions);
        document.getElementById("formOverlay").hidden = true;
        await render();
      } catch (err) {
        console.error(err);
        errEl.textContent = "Kaydedilemedi, tekrar dener misin?";
        errEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = editingId ? "Güncelle" : "Kaydet";
      }
    });

    document.getElementById("btnAdd").addEventListener("click", openAddModal);
    document.getElementById("btnEmptyAdd").addEventListener("click", openAddModal);
    document.getElementById("formClose").addEventListener("click", function () {
      document.getElementById("formOverlay").hidden = true;
    });
    document.getElementById("formOverlay").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) e.currentTarget.hidden = true;
    });

    document.getElementById("detailOverlay").addEventListener("click", function (e) {
      if (e.target === e.currentTarget) e.currentTarget.hidden = true;
    });

    document.getElementById("btnReview").addEventListener("click", startReview);

    document.getElementById("searchBox").addEventListener("input", function (e) {
      searchTerm = e.target.value;
      renderGrid();
    });
  }

  // ---------- detail ----------
  async function openDetail(q) {
    var sheet = document.getElementById("detailSheet");
    var src = q.photoFile ? await getPhotoSrc(q.photoFile) : null;
    var img = src ? '<img class="detail-img" src="' + src + '" alt="">' : "";
    var tags = (q.tags || "").split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    sheet.innerHTML =
      '<div class="sheet-head">' +
      "<h2>" + esc(q.topic || q.subject || "Soru") + "</h2>" +
      '<button class="closex" id="detailClose" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "</div>" +
      img +
      '<div class="tagrow" style="margin-bottom:10px;">' +
      '<span class="subj-chip" style="background:' + colorFor(q.subject) + '">' + esc(q.subject || "") + "</span>" +
      (q.mastered ? '<span class="badge good">Öğrenildi</span>' : '<span class="badge need">Tekrar Et</span>') +
      "</div>" +
      (q.myAnswer ? '<div class="detail-row"><label>Benim Cevabım</label><div class="val">' + esc(q.myAnswer) + "</div></div>" : "") +
      (q.correctAnswer ? '<div class="detail-row"><label>Doğru Cevap</label><div class="val">' + esc(q.correctAnswer) + "</div></div>" : "") +
      (q.note ? '<div class="detail-row"><label>Not</label><div class="val">' + esc(q.note) + "</div></div>" : "") +
      (tags.length ? '<div class="detail-row"><label>Etiketler</label><div class="val">' + tags.map(function (t) { return esc(t); }).join(" · ") + "</div></div>" : "") +
      '<div class="detail-row"><label>Eklenme</label><div class="val mono">' + fmtDate(q.createdAt) + (q.reviewCount ? " · " + q.reviewCount + " kez tekrar edildi" : "") + "</div></div>" +
      '<div class="detail-actions">' +
      '<button class="btn sm" id="detailEdit">Düzenle</button>' +
      '<button class="btn sm ' + (q.mastered ? "" : "good") + '" id="detailToggleMaster">' + (q.mastered ? "Tekrar Listesine Al" : "Öğrendim Olarak İşaretle") + "</button>" +
      '<button class="btn sm ghost" id="detailDelete" style="color:var(--accent);">Sil</button>' +
      "</div>" +
      '<div id="detailConfirm"></div>';

    document.getElementById("detailOverlay").hidden = false;

    document.getElementById("detailClose").addEventListener("click", function () {
      document.getElementById("detailOverlay").hidden = true;
    });
    document.getElementById("detailEdit").addEventListener("click", function () {
      document.getElementById("detailOverlay").hidden = true;
      openEditModal(q);
    });
    document.getElementById("detailToggleMaster").addEventListener("click", async function () {
      q.mastered = !q.mastered;
      q.lastReviewedAt = Date.now();
      allQuestions = allQuestions.map(function (x) { return x.id === q.id ? q : x; });
      await saveQuestions(allQuestions);
      document.getElementById("detailOverlay").hidden = true;
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
        document.getElementById("detailOverlay").hidden = true;
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
    var pool = selectedSubject === "all" ? allQuestions : allQuestions.filter(function (q) { return q.subject === selectedSubject; });
    var needsReview = pool.filter(function (q) { return !q.mastered; });
    if (needsReview.length === 0) {
      reviewQueue = [];
      renderReviewDone(pool.length > 0);
      document.getElementById("reviewScreen").hidden = false;
      return;
    }
    reviewQueue = shuffle(needsReview);
    reviewTotal = reviewQueue.length;
    reviewIdx = 0;
    document.getElementById("reviewScreen").hidden = false;
    renderReviewCard();
  }

  function closeReview() {
    document.getElementById("reviewScreen").hidden = true;
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
      '<span class="disp" style="font-size:.95rem;">' + esc(q.topic || "") + "</span>" +
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
    q.mastered = mastered;
    q.reviewCount = (q.reviewCount || 0) + 1;
    q.lastReviewedAt = Date.now();
    allQuestions = allQuestions.map(function (x) { return x.id === q.id ? q : x; });
    await saveQuestions(allQuestions);
    reviewIdx++;
    await renderReviewCard();
  }

  function renderReviewDone(hadQuestions) {
    var screen = document.getElementById("reviewScreen");
    screen.innerHTML =
      '<div class="review-head">' +
      '<button class="closex" id="reviewClose2" aria-label="Kapat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>' +
      "<span></span>" +
      "</div>" +
      '<div class="review-body">' +
      '<div class="review-done">' +
      '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "<h2>" + (hadQuestions ? "Tekrar edilecek soru kalmadı" : "Bu seçimde hiç soru yok") + "</h2>" +
      '<p class="hint">' + (hadQuestions ? "Bu filtredeki tüm sorular öğrenildi olarak işaretli." : "Önce birkaç yanlış soru eklemelisin.") + "</p>" +
      '<button class="btn primary" id="btnBackToList">Listeye Dön</button>' +
      "</div>" +
      "</div>";
    document.getElementById("reviewClose2").addEventListener("click", closeReview);
    document.getElementById("btnBackToList").addEventListener("click", closeReview);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
