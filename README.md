# Hata Defterim (Android)

Sınava çalışırken yanlış yapılan soruların fotoğrafını çekip bilgilerini
kaydeden ve tekrar modu ile gözden geçirmeyi sağlayan basit bir Android
uygulaması. [Capacitor](https://capacitorjs.com) ile sade bir HTML/CSS/JS
arayüzü native bir Android kabuğuna sarılmıştır — sunucu yok, tüm veriler
telefonda yerel olarak saklanır.

## Mimari

- `www/` — uygulamanın tüm arayüzü (düz HTML/CSS/JS, bundler yok)
- `www/app.js` — uygulama mantığı; veriler `@capacitor/preferences` ile
  (metin alanları) ve `@capacitor/filesystem` ile (fotoğraflar, cihazın özel
  uygulama veri klasöründe) saklanır. Fotoğraf çekmek için
  `@capacitor/camera` kullanılır.
- `capacitor.config.json` — uygulama kimliği `com.turkmenonline.hatadefterim`
- `android/` — `npx cap add android` ile üretilir, repoya **dahil edilmez**
  (`.gitignore`'da), her geliştirici kendi makinesinde üretir.

Veri modeli (her soru bir obje):

```json
{
  "id": "q_...",
  "subject": "Matematik",
  "topic": "Türev",
  "myAnswer": "C",
  "correctAnswer": "D",
  "note": "İşaret hatası yaptım",
  "tags": "formül, dikkat hatası",
  "photoFile": "q_....jpeg",
  "createdAt": 1700000000000,
  "mastered": false,
  "reviewCount": 0,
  "lastReviewedAt": null
}
```

## Kurulum (ilk sefer)

Gereksinimler: Node.js (LTS), Android Studio (Android SDK + bir emülatör ya
da USB hata ayıklama açık gerçek bir telefon dahil).

```bash
npm install
npx cap add android
npx cap sync android
```

`npx cap add android` komutu `android/` klasörünü oluşturur. Bu adımdan
sonra `android/app/src/main/AndroidManifest.xml` dosyasını açıp
`<uses-permission android:name="android.permission.CAMERA" />` satırının
eklendiğini doğrulayın — Capacitor Camera eklentisi bunu genelde otomatik
ekler ama bir kere göz atmak iyi olur.

## Çalıştırma

```bash
npx cap open android
```

Android Studio açılır; oradan emülatörde ya da bağlı telefonda ▶ Run ile
çalıştırabilirsiniz. Komut satırından doğrudan çalıştırmak isterseniz:

```bash
npx cap run android
```

## `www/` içinde değişiklik yaptıktan sonra

Native tarafa yeniden kopyalamak için:

```bash
npx cap sync android
```

## Bilinen eksikler / sıradaki adımlar

- Veriler yalnızca o telefonda tutuluyor; bulut yedekleme veya cihazlar arası
  senkronizasyon yok (istenirse eklenebilir).
- Fontlar (Google Fonts) ilk açılışta internet gerektiriyor; tam çevrimdışı
  kullanım isteniyorsa fontlar projeye gömülebilir.
- Uygulama ikonu ve açılış ekranı henüz Capacitor varsayılanı; marka
  materyali hazır olunca `android/app/src/main/res` altında değiştirilip
  `npx cap sync android` çalıştırılmalı.
- İmzalı bir APK/AAB üretmek (Play Store'a yüklemek) için Android Studio'nun
  Build > Generate Signed Bundle/APK akışı kullanılabilir; henüz bir
  imzalama anahtarı (keystore) oluşturulmadı.
