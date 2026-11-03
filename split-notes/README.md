# Çift Not Görünümü (Split Notes)

Mobil ve masaüstünde **iki notu aynı anda** görüntüleyen, temalara tam uyumlu, çekirdek eklenti görünümünde bir Obsidian eklentisi.

## Özellikler

- 📱 **Mobil uyumlu** (`isDesktopOnly: false`) — telefonlarda paneller otomatik alt alta dizilir
- 🪟 İki not yan yana (≥600px ekranda) veya alt alta
- 🎨 **Tema duyarlı**: tüm renkler Obsidian CSS değişkenlerinden (`--background-primary`, `--interactive-normal` vb.) gelir; açık/koyu ve üçüncü parti temalarla uyumlu
- 🔗 İç not linklerine dokununca ilgili panelde not açılır
- 🔀 Panellerin yerini tek dokunuşla değiştirme
- 🧩 Çekirdek eklenti hissi: ribbon ikonu, komut paleti komutları, yerleşik arayüz bileşenleri

## Kurulum (elle)

1. Bu klasörü indirin: `split-notes/`
2. Kasanızdaki `.obsidian/plugins/split-notes/` klasörüne kopyalayın
3. Ayarlar → Topluluk eklentileri'nden **Çift Not Görünümü**'nü etkinleştirin

## Kullanım

- Sol üstteki **ribbon ikonuna** dokunun veya komut paletinden **"Çift not görünümünü aç"** çalıştırın
- Üstteki iki **"Not seç"** düğmesine dokunarak her panel için not seçin
- **"Aktif notu çift görünümde aç"** komutu, açık olan notu doğrudan soldaki panele yükler
- Ortadaki ok düğmesiyle panellerin yerini değiştirebilirsiniz

## Dosyalar

| Dosya | Açıklama |
| --- | --- |
| `manifest.json` | Eklenti meta verileri |
| `main.js` | Eklenti kodu (derleme gerektirmez, saf JS) |
| `styles.css` | Tema değişkenleriyle uyumlu stiller |
