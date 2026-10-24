/*
  Statistics panel: totals, 7-day review chart, streak, per-subject progress,
  the topics that still need the most review, and the most common error tags.
*/
(function () {
  "use strict";
  var HD = window.HD = window.HD || {};

  // deps = { isDue, topicKey, topicLabel(q), dateKey(ts) }  (injected so this stays testable)
  function computeStats(questions, log, now, deps) {
    var days = (log && log.days) || {};
    var total = questions.length;
    var due = questions.filter(deps.isDue).length;
    var learned = total - due;

    // last 7 days, oldest first
    var week = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(now);
      d.setDate(d.getDate() - i);
      var e = days[deps.dateKey(d.getTime())] || { n: 0, ok: 0 };
      week.push({
        key: deps.dateKey(d.getTime()),
        label: d.toLocaleDateString("tr-TR", { weekday: "short" }),
        n: e.n || 0,
        ok: e.ok || 0,
        today: i === 0
      });
    }
    var weekTotal = week.reduce(function (a, x) { return a + x.n; }, 0);
    var weekOk = week.reduce(function (a, x) { return a + x.ok; }, 0);

    // streak of consecutive days with at least one review (today may still be empty)
    var streak = 0;
    var cursor = new Date(now);
    if (!(days[deps.dateKey(cursor.getTime())] && days[deps.dateKey(cursor.getTime())].n > 0)) {
      cursor.setDate(cursor.getDate() - 1);
    }
    while (days[deps.dateKey(cursor.getTime())] && days[deps.dateKey(cursor.getTime())].n > 0) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    var subjMap = {}, subjects = [];
    var topicMap = {}, topics = [];
    var tagMap = {}, tags = [];
    questions.forEach(function (q) {
      var sName = q.subject || "Ders yok";
      var s = subjMap[sName] || (subjMap[sName] = { name: sName, total: 0, due: 0 });
      if (!subjMap[sName].added) { subjMap[sName].added = true; subjects.push(s); }
      s.total++;
      var isDue = deps.isDue(q);
      if (isDue) s.due++;

      var tk = sName + "||" + deps.topicKey(q.topic);
      var t = topicMap[tk];
      if (!t) { t = topicMap[tk] = { subject: sName, topic: deps.topicLabel(q), total: 0, due: 0 }; topics.push(t); }
      t.total++;
      if (isDue) t.due++;

      var raw = Array.isArray(q.tags) ? q.tags.join(",") : String(q.tags || "");
      raw.split(/[,;]+/).forEach(function (piece) {
        var label = piece.trim();
        if (!label) return;
        var key = label.toLocaleLowerCase("tr-TR");
        if (!tagMap[key]) { tagMap[key] = { label: label, count: 0 }; tags.push(tagMap[key]); }
        tagMap[key].count++;
      });
    });
    subjects.sort(function (a, b) { return b.due - a.due || b.total - a.total; });
    topics = topics.filter(function (t) { return t.due > 0; })
      .sort(function (a, b) { return b.due - a.due || b.total - a.total; })
      .slice(0, 6);
    tags.sort(function (a, b) { return b.count - a.count; });

    return {
      total: total, due: due, learned: learned,
      pct: total ? Math.round((learned / total) * 100) : 0,
      week: week, weekTotal: weekTotal,
      weekRate: weekTotal ? Math.round((weekOk / weekTotal) * 100) : 0,
      streak: streak,
      subjects: subjects, topics: topics,
      tags: tags.slice(0, 8).map(function (t) { return { label: t.label, count: t.count, pct: total ? Math.round((t.count / total) * 100) : 0 }; })
    };
  }

  function render(st) {
    var esc = HD.esc;
    if (st.total === 0) {
      return '<p class="hint">Henüz soru yok. Soru ekledikçe istatistikler burada görünür.</p>';
    }
    var max = Math.max.apply(null, st.week.map(function (d) { return d.n; }).concat([1]));
    var weekHtml = '<div class="st-week">' + st.week.map(function (d) {
      var h = d.n ? Math.max(6, Math.round((d.n / max) * 80)) : 3;
      return '<div class="st-day"><span class="mono">' + (d.n || "") + "</span>" +
        '<div class="st-bar' + (d.n ? "" : " zero") + '" style="height:' + h + 'px"></div>' +
        "<span" + (d.today ? ' style="font-weight:700;color:var(--ink)"' : "") + ">" + esc(d.label) + "</span></div>";
    }).join("") + "</div>";

    var html =
      '<div class="st-cards">' +
      '<div class="st-card"><b class="mono">' + st.due + "</b><span>Tekrar zamanı gelen</span></div>" +
      '<div class="st-card"><b class="mono">%' + st.pct + "</b><span>Öğrenilen (" + st.learned + " / " + st.total + ")</span></div>" +
      '<div class="st-card"><b class="mono">' + st.weekTotal + "</b><span>Son 7 günde tekrar" + (st.weekTotal ? " · %" + st.weekRate + " doğru" : "") + "</span></div>" +
      '<div class="st-card"><b class="mono">' + st.streak + "</b><span>Gün üst üste tekrar</span></div>" +
      "</div>" +
      '<div class="st-h">Son 7 gün</div>' + weekHtml +
      '<div class="st-h">Derslere göre</div>' +
      st.subjects.map(function (s) {
        var pct = s.total ? Math.round(((s.total - s.due) / s.total) * 100) : 0;
        return '<div class="st-row"><div class="st-row-top"><span>' + esc(s.name) + "</span><small>" +
          s.total + " soru · " + s.due + ' tekrar</small></div><div class="st-track"><div class="st-fill" style="width:' + pct + '%"></div></div></div>';
      }).join("");

    if (st.topics.length) {
      html += '<div class="st-h">En çok tekrar gereken konular</div>' + st.topics.map(function (t) {
        var pct = t.total ? Math.round(((t.total - t.due) / t.total) * 100) : 0;
        return '<div class="st-row"><div class="st-row-top"><span>' + esc(t.subject) + " › " + esc(t.topic) + "</span><small>" +
          t.due + " / " + t.total + ' tekrar</small></div><div class="st-track"><div class="st-fill" style="width:' + pct + '%"></div></div></div>';
      }).join("");
    }
    if (st.tags.length) {
      html += '<div class="st-h">En sık hata türleri</div><div class="st-tags">' + st.tags.map(function (t) {
        return '<span class="st-tag">' + esc(t.label) + "<small>" + t.count + " · %" + t.pct + "</small></span>";
      }).join("") + "</div>";
    }
    return html;
  }

  function open() {
    var qs = HD.getQuestions();
    var labelMap = HD.buildTopicLabelMap(qs);
    var st = computeStats(qs, HD.getReviewLog(), Date.now(), {
      isDue: HD.isDue,
      topicKey: HD.topicKey,
      topicLabel: function (q) { return HD.displayTopicOf(q, labelMap); },
      dateKey: HD.dateKey
    });
    HD.openPanel("İstatistikler", render(st), { back: true });
  }

  HD.stats = { open: open, _compute: computeStats };
})();
