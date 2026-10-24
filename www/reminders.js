/*
  Daily reminders using @capacitor/local-notifications.
  Notifications are scheduled for the next 14 days at the chosen time, each
  with the number of questions that will be due by then. Days with nothing
  due get no notification. The plan is rebuilt every time the app opens or
  goes to the background, so the counts stay fresh.
*/
(function () {
  "use strict";
  var HD = window.HD = window.HD || {};

  var ID_BASE = 7001;
  var DAYS = 14;
  var TEST_ID = 7999;

  function countDueAt(questions, t) {
    return questions.filter(function (q) {
      return !q.mastered || (q.dueAt && q.dueAt <= t);
    }).length;
  }

  // Pure planner (unit tested): returns [{ id, atMs, n }]
  function plan(questions, nowMs, hour, minute) {
    var out = [];
    for (var i = 0; i < DAYS; i++) {
      var d = new Date(nowMs);
      d.setHours(hour, minute, 0, 0);
      d.setDate(d.getDate() + i);
      var at = d.getTime();
      if (at <= nowMs + 60000) continue;
      var n = countDueAt(questions, at);
      if (n > 0) out.push({ id: ID_BASE + i, atMs: at, n: n });
    }
    return out;
  }

  function bodyFor(n) {
    return n + " sorunun tekrar zamanı geldi. Bugünkü tekrarını yap!";
  }

  function plugin() {
    var P = HD.Plugins || (window.Capacitor && window.Capacitor.Plugins) || {};
    return P.LocalNotifications || null;
  }

  var MISSING = "Bildirim eklentisi bulunamadı. `npm install` ve `npx cap sync android` çalıştırıp uygulamayı yeniden yükle.";

  async function granted(LN, ask) {
    var perm = await LN.checkPermissions();
    if (perm.display === "granted") return true;
    if (!ask) return false;
    perm = await LN.requestPermissions();
    return perm.display === "granted";
  }

  async function enable() {
    var LN = plugin();
    if (!LN) return { ok: false, message: HD.isNative ? MISSING : "Hatırlatma yalnızca Android uygulamasında çalışır." };
    try {
      if (!(await granted(LN, true))) {
        return { ok: false, message: "Bildirim izni verilmedi. Telefon ayarlarından Hata Defterim için bildirimlere izin verebilirsin." };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, message: "Bildirim izni alınamadı." };
    }
  }

  async function cancelAll(LN) {
    var ids = [];
    for (var i = 0; i < DAYS; i++) ids.push({ id: ID_BASE + i });
    try { await LN.cancel({ notifications: ids }); } catch (e) {}
  }

  async function disable() {
    var LN = plugin();
    if (LN) await cancelAll(LN);
  }

  async function reschedule() {
    var LN = plugin();
    if (!LN || !HD.getSettings) return;
    try {
      var r = HD.getSettings().reminder;
      await cancelAll(LN);
      if (!r || !r.on) return;
      if (!(await granted(LN, false))) return;
      var items = plan(HD.getQuestions(), Date.now(), r.hour, r.minute);
      if (!items.length) return;
      await LN.schedule({
        notifications: items.map(function (it) {
          return { id: it.id, title: "Hata Defterim", body: bodyFor(it.n), schedule: { at: new Date(it.atMs) } };
        })
      });
    } catch (e) {
      console.warn("reminder schedule failed", e);
    }
  }

  async function test() {
    var res = await enable();
    if (!res.ok) return res;
    var LN = plugin();
    try {
      await LN.schedule({
        notifications: [{
          id: TEST_ID,
          title: "Hata Defterim",
          body: "Test bildirimi: hatırlatmalar çalışıyor.",
          schedule: { at: new Date(Date.now() + 5000) }
        }]
      });
      return { ok: true, message: "5 saniye içinde bir bildirim gelecek. Uygulamayı arka plana alıp bekle." };
    } catch (e) {
      return { ok: false, message: "Test bildirimi gönderilemedi." };
    }
  }

  HD.reminders = { enable: enable, disable: disable, reschedule: reschedule, test: test, _plan: plan };
})();
