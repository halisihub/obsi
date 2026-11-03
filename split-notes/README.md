# Çift Not Görünümü (Split Notes)

Mobil ve masaüstünde **iki notu aynı anda** görüntüleyen, çekirdek eklenti kalitesinde bir Obsidian eklentisi. Arayüz, Obsidian'ın çekirdek görünüm sınıflarına (`markdown-preview-view`, `clickable-icon`, `empty-state`, `view-header`) yaslanır; bu yüzden her temada sanki çekirdek bir görünümmüş gibi görünür.

## Neden çekirdek eklenti gibi hissedilir?

- 📄 **İçerik gerçek okuma görünümü olarak render edilir** — paneller `markdown-preview-view` + `markdown-preview-sizer` sınıflarıyla sarılır; temalar başlıkları, alıntıları, listeleri çekirdek okuma modundaki gibi stillendirir
- 🗂 **Çekirdek yaprak başlıkları** — her panelde dosya adı, "yeni sekmede aç" ve "diğer seçenekler" düğmeleri (yerleşik `clickable-icon` stili)
- 🖱 **Sağ tık menüsü** — çekirdek `Menu` bileşeniyle: yenile, not seç, panelleri değiştir, paneli temizle
- 🔎 **Hızlı not arama** — çekirdek `FuzzySuggestModal` ile
- 🔗 **İç linkler çekirdek davranışla** — tıkla: panelde aç; Shift/Cmd+tık: yeni sekmede aç
- 🔴 **Canlı içerik** — not düzenlenince panel otomatik yenilenir (debounce'lu); silinirse panel temizlenir, yeniden adlandırılırsa başlık güncellenir
- ⚙️ **Ayarlar sekmesi** — çekirdek `Setting` bileşenleriyle

## Özellikler

- 📱 **Mobil uyumlu** — telefonlarda paneller otomatik alt alta; yön ayarlardan da sabitlenebilir
- 🎨 **Tema duyarlı** — yalnızca tema değişkenleri, sabit renk yok
- 🧠 **Son notları hatırlar** — görünüm yeniden açıldığında paneller geri yüklenir
- ↔️ **Senkron kaydırma** (isteğe bağlı) — bir panel kaydırılınca diğeri aynı oranda kayar
- 🔀 **Panelleri değiştir** komutu + sağ tık menüsü
- ↕️ Kaydırma konumu, panel yenilenirken korunur

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| Çift not görünümünü aç | Görünümü yeni sekmede açar |
| Aktif notu çift görünümde aç | Aktif notu soldaki panele yükler |
| Panellerin yerini değiştir | İki panelin içeriğini takas eder |

## Kurulum (BRAT ile — önerilen)

1. Obsidian'da **BRAT** eklentisini kurun
2. BRAT ayarlarında **Add Beta plugin** → `halisihub/obsi`
3. Eklentiyi etkinleştirin

## Kurulum (elle)

1. Bu klasörü indirin: `split-notes/`
2. Kasanızdaki `.obsidian/plugins/split-notes/` klasörüne kopyalayın
3. Ayarlar → Topluluk eklentileri'nden **Çift Not Görünümü**'nü etkinleştirin

## Ayarlar

| Ayar | Açıklama |
| --- | --- |
| Panel yönü | Otomatik / yan yana / alt alta |
| Son notları hatırla | Yeniden açılışta panelleri geri yükler |
| Senkron kaydırma | Panellerin oransal kaydırma senkronu |
