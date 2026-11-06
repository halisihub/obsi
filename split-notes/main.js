"use strict";

/*
 * Çift Not Görünümü — Obsidian "çekirdek eklenti" kalitesinde çift panel görüntüleyici
 *
 * Tasarım ilkeleri:
 *  - Görünüm, çekirdek okuma modunun DOM'una ve sınıflarına yaslanır
 *    (markdown-preview-view, clickable-icon, empty-state) — böylece her tema
 *    onu çekirdek bir görünümmüş gibi stillendirir.
 *  - Hiçbir sabit renk yok; yalnızca tema değişkenleri.
 *  - Dosya yaşam döngüsü (düzenle / yeniden adlandır / sil) izlenir,
 *    paneller canlı güncellenir.
 *
 * 3.4: sık kullanılan çift önerileri, hızlı çift menüsü, başlık bazlı senkron
 *      kaydırma, panel boyutlandırma (ayırıcı), odak modu, panelde arama,
 *      akıllı bağlantı hedefi, not bazlı kaydırma hafızası, görsel desteği,
 *      kalıp çifti, backlink sayacı + çok sayıda hata düzeltmesi.
 * 3.4.1: "Tam ekranda saati göster" ayarı — saat görünsün ve paneller onun
 *      altından başlasın; üst pay yatay/dikey ekran için AYRI AYRI ölçülür.
 *      Çift istatistikleri ("N kez yüklendi") her zaman görünür.
 */

const {
  ButtonComponent,
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  debounce,
  setIcon
} = require("obsidian");

const VIEW_TYPE = "split-notes-view";

const DEFAULT_SETTINGS = {
  splitDirection: "auto",   // auto | row | column
  rememberNotes: true,      // son açılan notlar hatırlanır
  syncScroll: false,        // senkron kaydırma açık/kapalı
  syncScrollMode: "delta",  // delta: aynı mesafe | proportional: aynı oran
  linkTarget: "other",      // other: bağlantı diğer panelde açılır | same: aynı panelde
  hidePaneHeadersInFullscreen: false, // gerçek tam ekran: panel başlıkları da gizlenir
  pairs: [],                // kayıtlı not çiftleri: [{ name, leftPath, rightPath }]
  hideNavbar: false,        // mobil alt menü gizli mi
  hideStatusBar: false,     // üst çubuk (saat alanı) gizli mi
  fullscreenTopInset: 0,   // tam ekranda saat çubuğu için üst boşluk (px) — 0: otomatik
  showClockInFullscreen: true, // tam ekranda saat görünsün ve üst pay ayrılsın
  paneRatio: 0.5,           // panellerin boyut oranı (0.1–0.9)
  pairUsage: {},            // çift başına yükleme sayısı (sıralama için)
  pairTemplate: ""         // kalıp çifti: "{ad} ↔ {ad} çözüm"
};

/* Panel başına gezinme geçmişinin uzunluk sınırı */
const HISTORY_LIMIT = 100;

/* ================================================================== */
/* Not seçici — çekirdek hızlı arama (FuzzySuggestModal)               */
/* ================================================================== */
class NoteSuggestModal extends FuzzySuggestModal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Görüntülenecek notu seçin...");
  }
  getItems() {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(file) {
    return file.basename;
  }
  onChooseItem(file) {
    this.onPick(file);
  }
}

/* Kayıtlı çift seçici */
class PairPickerModal extends FuzzySuggestModal {
  constructor(app, plugin, onPick) {
    super(app);
    this.plugin = plugin;
    this.onPick = onPick;
    this.setPlaceholder("Yüklenecek çifti seçin...");
  }
  getItems() {
    return this.plugin.getSortedPairs();
  }
  getItemText(pair) {
    const l = pair.leftPath ? pair.leftPath.split("/").pop() : "—";
    const r = pair.rightPath ? pair.rightPath.split("/").pop() : "—";
    return pair.name + "  (" + l + " ↔ " + r + ")";
  }
  onChooseItem(pair) {
    this.onPick(pair);
  }
}

/* Çift adı soran küçük çekirdek modalı */
class PairNameModal extends Modal {
  constructor(app, defaultName, onSave) {
    super(app);
    this.defaultName = defaultName;
    this.onSave = onSave;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Çift olarak kaydet" });

    new Setting(contentEl)
      .setName("Ad")
      .addText((text) => {
        this.input = text;
        text.setValue(this.defaultName);
        text.inputEl.style.width = "100%";
      });

    const btns = new Setting(contentEl);
    new ButtonComponent(btns.controlEl)
      .setButtonText("Kaydet")
      .setCta()
      .onClick(() => {
        const name = (this.input.getValue() || "").trim() || this.defaultName;
        this.close();
        this.onSave(name);
      });
    new ButtonComponent(btns.controlEl)
      .setButtonText("İptal")
      .onClick(() => this.close());
  }
}

/* ================================================================== */
/* Ana görünüm                                                         */
/* ================================================================== */
class SplitNotesView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.files = { left: null, right: null };
    this.components = { left: null, right: null };
    this.scrolls = { left: null, right: null };
    this.panes = {};
    // Programatik olarak kaydırılan panel için beklenen konum. Böylece
    // tarayıcının daha sonra gönderdiği scroll olayı geri döngü oluşturmaz.
    this.programmaticScrolls = { left: null, right: null };
    // Senkron kaydırma için her panelin son konumu (delta hesabı)
    this.lastScrollTops = { left: 0, right: 0 };
    // Panel başına gezinme geçmişi (tarayıcı geçmişi gibi)
    this.history = {
      left: { stack: [], index: -1 },
      right: { stack: [], index: -1 }
    };
    // Son kullanıcı etkileşiminin olduğu panel (geçmiş komutları için)
    this.lastSide = null;
    // Bu görünümün tam ekran durumu (gövde sınıfı yalnızca etkinken uygulanır)
    this.isFullscreen = false;
    // Not bazlı kaydırma konumu hafızası (oturum boyunca)
    this.scrollMemory = new Map();
    // renderPane yarış koşuluna karşı artan kuşak numarası
    this.renderGeneration = 0;
    // Panelde arama durumu
    this.search = { term: null, side: null, hits: 0, index: -1 };
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Çift not görünümü"; }
  getIcon() { return "columns-2"; }

  async onOpen() {
    const { settings } = this.plugin;
    this.contentEl.empty();
    this.contentEl.addClass("split-notes");

    /* Yön: kullanıcı seçimi varsa sınıfla sabitle, yoksa CSS'teki
       medya sorgusu (dar ekranda = alt alta) geçerli olur. */
    if (settings.splitDirection === "row") this.contentEl.addClass("is-row");
    if (settings.splitDirection === "column") this.contentEl.addClass("is-column");

    this.panesEl = this.contentEl.createDiv({ cls: "split-notes-panes" });
    this.buildPane("left");
    this.buildDivider();
    this.buildPane("right");
    this.applyPaneRatio();

    /* Çekirdek görünüm başlığı düğmesi: senkron kaydırmayı
       tek dokunuşla aç/kapat (ayarlara girmeden). */
    this.syncBtn = this.addAction("link-2", "Senkron kaydırma", () => {
      this.plugin.settings.syncScroll = !this.plugin.settings.syncScroll;
      void this.plugin.saveSettings();
      this.updateSyncButton();
    });
    this.updateSyncButton();

    /* Çekirdek görünüm başlığı düğmesi: hızlı çift erişimi — sık
       kullanılanlar üstte sıralı menü */
    this.addAction("layers", "Çiftler", (evt) => {
      this.showQuickPairs(evt);
    });

    /* Çekirdek görünüm başlığı düğmesi: tam ekran */
    this.fsBtn = this.addAction("maximize-2", "Tam ekran", () => {
      this.toggleFullscreen();
    });

    /* Gövde sınıfları yalnızca bu görünüm etkinken uygulanır */
    this.plugin.updateGlobalClasses();

    /* Tam ekrandan çıkış: iki parmakla küçültme (pinch-in) hareketi,
       masaüstünde Esc tuşu. Yüzen düğme YOK. */
    this.registerFullscreenGestures();

    /* Canlı güncelleme: dosya düzenlenince paneli tazele */
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.refreshIfVisible(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onDelete(file))
    );

    /* Kaydedilmiş notları geri yükle */
    if (settings.rememberNotes) await this.restoreState();
  }

  async onClose() {
    document.body.classList.remove("split-notes-fullscreen");
    document.body.classList.remove("split-notes-native-fs");
    this.plugin.applyNativeFullscreenMode(false);
    for (const side of ["left", "right"]) {
      if (this.components[side]) this.components[side].unload();
      const pending = this.programmaticScrolls[side];
      if (pending) window.clearTimeout(pending.timeout);
    }
    await this.saveState();
  }

  /* Başlık düğmesinin durumunu yansıt */
  updateSyncButton() {
    if (!this.syncBtn) return;
    const on = this.plugin.settings.syncScroll;
    this.syncBtn.classList.toggle("is-on", on);
    this.syncBtn.setAttribute(
      "aria-label",
      on ? "Senkron kaydırma: açık" : "Senkron kaydırma: kapalı"
    );
  }

  /* Alt menü (mobil navbar) gizle/göster — ayara yazılır, kalıcıdır */
  toggleNavbar() {
    this.plugin.settings.hideNavbar = !this.plugin.settings.hideNavbar;
    void this.plugin.saveSettings();
    this.plugin.updateGlobalClasses();
  }

  /* Üst çubuk (saat alanı) gizle/göster — kalıcı ayar */
  toggleStatusBar() {
    this.plugin.settings.hideStatusBar = !this.plugin.settings.hideStatusBar;
    void this.plugin.saveSettings();
    this.plugin.updateGlobalClasses();
  }

  /* Tam ekran: üst/alt çubukları gizle, paneller tüm ekranı kaplasın */
  toggleFullscreen() {
    const on = !this.isFullscreen;
    this.isFullscreen = on;
    this.plugin.updateGlobalClasses();
    if (this.fsBtn) this.fsBtn.classList.toggle("is-on", on);
    this.plugin.applyNativeFullscreenMode(on);
    this.applyChromeless(on);
  }

  /* Gerçek tam ekran: panel başlıkları da gizlenir (ayar) */
  applyChromeless(on) {
    const chromeless = on && this.plugin.settings.hidePaneHeadersInFullscreen;
    this.contentEl.toggleClass("is-chromeless", chromeless);
  }

  /* Çıkış hareketleri: pinch-in (mobil) ve Esc (masaüstü) */
  registerFullscreenGestures() {
    let pinchStart = null;

    this.registerDomEvent(this.contentEl, "touchstart", (evt) => {
      if (evt.touches.length === 2) {
        const a = evt.touches[0];
        const b = evt.touches[1];
        pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      }
    }, { passive: true });

    this.registerDomEvent(this.contentEl, "touchmove", (evt) => {
      if (pinchStart === null || evt.touches.length !== 2) return;
      const a = evt.touches[0];
      const b = evt.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      /* Belirgin küçültme: parmaklar yarı mesafeye yakınlaştıysa çık */
      if (dist < pinchStart * 0.5 && pinchStart > 100) {
        pinchStart = null;
        if (document.body.classList.contains("split-notes-fullscreen")) {
          this.toggleFullscreen();
        }
      }
    }, { passive: true });

    this.registerDomEvent(this.contentEl, "touchend", () => {
      pinchStart = null;
    }, { passive: true });

    this.registerDomEvent(document, "keydown", (evt) => {
      if (evt.key !== "Escape") return;
      /* Modal/menü açıkken Esc onları kapatmalı; tam ekrana dokunma */
      if (document.querySelector(".modal-container, .menu")) return;
      if (!document.body.classList.contains("split-notes-fullscreen")) return;
      if (this.app.workspace.getActiveViewOfType(ItemView) === this) {
        this.toggleFullscreen();
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Panel inşası — çekirdek yaprak başlığı + okuma içeriği            */
  /* ---------------------------------------------------------------- */
  buildPane(side) {
    const pane = this.panesEl.createDiv({ cls: "split-notes-pane" });
    this.panes[side] = pane;

    /* Yaprak başlığı: çekirdek .view-header görünümü */
    const header = pane.createDiv({ cls: "split-notes-pane-header" });
    const title = header.createDiv({
      cls: "split-notes-pane-title",
      text: "Not seçilmedi"
    });
    title.addEventListener("click", () => this.chooseFile(side));
    title.setAttribute("aria-label", "Bu panel için not seç");
    title.addClass("split-notes-pane-title-button");

    const actions = header.createDiv({ cls: "split-notes-pane-actions" });

    const editBtn = actions.createDiv({ cls: "clickable-icon" });
    setIcon(editBtn, "pencil");
    editBtn.setAttribute("aria-label", "Yeni sekmede aç");
    editBtn.addEventListener("click", () => this.openInEditor(side));

    const moreBtn = actions.createDiv({ cls: "clickable-icon" });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.setAttribute("aria-label", "Diğer seçenekler");
    moreBtn.addEventListener("click", (evt) => this.paneMenu(evt, side));
    header.addEventListener("contextmenu", (evt) => this.paneMenu(evt, side));

    /* İçerik: scroll alanı dış sarmalayıcıdır; markdown preview kendi
       başına kaydırmaz (styles.css). */
    const scrollEl = pane.createDiv({ cls: "split-notes-scroll" });
    const previewEl = scrollEl.createDiv({ cls: "markdown-preview-view" });
    this.scrolls[side] = scrollEl;

    this.showEmptyState(side);
    this.registerSyncScroll(side, scrollEl);
  }

  showEmptyState(side) {
    const previewEl = this.panes[side].querySelector(".markdown-preview-view");
    if (!previewEl) return;
    previewEl.empty();
    const empty = previewEl.createDiv({ cls: "empty-state" });
    empty.createDiv({ cls: "empty-state-title", text: "Panel boş" });
    empty.createDiv({
      cls: "empty-state-content",
      text: "Başlığa dokunarak görüntülenecek notu seçin."
    });
    this.setTitle(side, null);
  }

  setTitle(side, file) {
    const title = this.panes[side].querySelector(".split-notes-pane-title");
    if (!title) return;
    if (!file) {
      title.setText("Not seçilmedi");
      return;
    }
    /* Backlink sayacı: bu nota giden bağlantı sayısı */
    const backlinks = this.app.metadataCache.getBacklinksForFile(file);
    const count = backlinks ? Object.keys(backlinks.data || {}).length : 0;
    title.setText(count ? file.basename + "  (" + count + ")" : file.basename);
  }

  /* ---------------------------------------------------------------- */
  /* Not seçme / açma                                                  */
  /* ---------------------------------------------------------------- */
  chooseFile(side) {
    new NoteSuggestModal(this.app, (file) => this.setFile(side, file)).open();
  }

  /* setFile: kullanıcı gezinmesi — geçmişe eklenir. */
  setFile(side, file) {
    this.lastSide = side;
    this.rememberScroll(side);
    this.files[side] = file;
    this.pushHistory(side, file);
    this.renderPane(side);
    void this.saveState();
  }

  /* Giden notun kaydırma konumunu hafızaya al */
  rememberScroll(side) {
    if (!this.files[side]) return;
    const el = this.scrolls[side];
    if (el) this.scrollMemory.set(this.files[side].path, el.scrollTop);
  }

  /* loadWithoutHistory: programatik yükleme (geri/ileri, çift yükleme). */
  loadWithoutHistory(side, file) {
    this.files[side] = file;
    this.renderPane(side);
    void this.saveState();
  }

  async openInEditor(side) {
    const file = this.files[side];
    if (!file) return;
    await this.app.workspace.openLinkText(file.path, "/", false);
  }

  swap() {
    const f = this.files.left;
    this.files.left = this.files.right;
    this.files.right = f;
    /* Geçmiş, kaydırma izleri ve son panel de yer değiştirir */
    const h = this.history.left;
    this.history.left = this.history.right;
    this.history.right = h;
    const l = this.lastScrollTops.left;
    this.lastScrollTops.left = this.lastScrollTops.right;
    this.lastScrollTops.right = l;
    if (this.lastSide) this.lastSide = this.lastSide === "left" ? "right" : "left";
    this.renderPane("left");
    this.renderPane("right");
    void this.saveState();
  }

  clearPane(side) {
    this.files[side] = null;
    if (this.components[side]) {
      this.components[side].unload();
      this.components[side] = null;
    }
    this.showEmptyState(side);
    void this.saveState();
  }

  /* ---------------------------------------------------------------- */
  /* Panel boyutlandırma + odak modu                                    */
  /* ---------------------------------------------------------------- */
  buildDivider() {
    const divider = this.panesEl.createDiv({ cls: "split-notes-divider" });
    divider.setAttribute("aria-label", "Panel boyutunu değiştir");
    let dragging = false;

    const onDrag = (clientX, clientY) => {
      const rect = this.panesEl.getBoundingClientRect();
      let ratio;
      if (this.isColumnLayout()) {
        ratio = (clientY - rect.top) / Math.max(1, rect.height);
      } else {
        ratio = (clientX - rect.left) / Math.max(1, rect.width);
      }
      ratio = Math.min(0.9, Math.max(0.1, ratio));
      this.plugin.settings.paneRatio = Math.round(ratio * 100) / 100;
      this.applyPaneRatio();
    };

    divider.addEventListener("pointerdown", (evt) => {
      dragging = true;
      divider.addClass("is-dragging");
      evt.preventDefault();
    });
    this.registerDomEvent(document, "pointermove", (evt) => {
      if (!dragging) return;
      onDrag(evt.clientX, evt.clientY);
    });
    this.registerDomEvent(document, "pointerup", () => {
      if (!dragging) return;
      dragging = false;
      divider.removeClass("is-dragging");
      void this.plugin.saveSettings();
    });

    /* Çift tıklama: panelleri eşitle */
    divider.addEventListener("dblclick", () => this.focusPane(null));
  }

  isColumnLayout() {
    return this.contentEl.hasClass("is-column") ||
      (this.plugin.settings.splitDirection !== "row" &&
        this.panesEl.clientWidth <= 600);
  }

  applyPaneRatio() {
    const r = Math.min(0.9, Math.max(0.1, Number(this.plugin.settings.paneRatio) || 0.5));
    if (this.panes.left) this.panes.left.style.flexGrow = String(r);
    if (this.panes.right) {
      this.panes.right.style.flexGrow = String(Math.round((1 - r) * 100) / 100);
    }
  }

  /* Odak modu: side null = eşit boyut */
  focusPane(side) {
    this.plugin.settings.paneRatio = side ? (side === "left" ? 0.8 : 0.2) : 0.5;
    this.applyPaneRatio();
    void this.plugin.saveSettings();
  }

  /* ---------------------------------------------------------------- */
  /* Hızlı çift erişimi: kullanım sırasına göre menü                    */
  /* ---------------------------------------------------------------- */
  showQuickPairs(evt) {
    const menu = new Menu();
    const pairs = this.plugin.getSortedPairs();
    if (!pairs.length) {
      menu.addItem((item) =>
        item.setTitle("Kayıtlı çift yok").setIcon("info").setDisabled(true)
      );
    } else {
      for (const pair of pairs.slice(0, 7)) {
        menu.addItem((item) =>
          item
            .setTitle(pair.name)
            .setIcon("layers")
            .onClick(() => this.loadPair(pair))
        );
      }
      if (pairs.length > 7) {
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Tümünü ara...")
            .setIcon("search")
            .onClick(() => this.pickPair())
        );
      }
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Mevcut panelleri çift olarak kaydet")
        .setIcon("bookmark-plus")
        .onClick(() => this.saveCurrentAsPair())
    );
    if (evt && typeof evt === "object" && "pageX" in evt) {
      menu.showAtMouseEvent(evt);
    } else {
      const rect = (this.fsBtn || this.contentEl).getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Kalıp çifti: "{ad} ↔ {ad} çözüm" biçiminde otomatik eşleştirme    */
  /* ---------------------------------------------------------------- */
  applyPairTemplate(side) {
    const tpl = (this.plugin.settings.pairTemplate || "").trim();
    const file = this.files[side];
    if (!tpl || !file) {
      new Notice(tpl ? "Önce panele not seçin." : "Ayarda kalıp tanımlı değil.");
      return;
    }
    const parts = tpl.split("↔").map((s) => s.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      new Notice("Kalıp hatalı: \u201C{ad} ↔ {ad} çözüm\u201D biçiminde olmalı.");
      return;
    }
    const renderTpl = (t, name) => t.replace(/\{ad\}/g, name);
    const candidate = renderTpl(side === "left" ? parts[1] : parts[0], file.basename);
    const found = this.app.vault.getMarkdownFiles().find(
      (f) => f.basename === candidate
    );
    if (found) this.setFile(side === "left" ? "right" : "left", found);
    else new Notice("Eş bulunamadı: " + candidate);
  }

  /* ---------------------------------------------------------------- */
  /* Panelde arama (bul + vurgula)                                      */
  /* ---------------------------------------------------------------- */
  searchInPane(side) {
    const modal = new Modal(this.app);
    modal.contentEl.createEl("h3", { text: "Panelde ara" });
    let input = null;
    new Setting(modal.contentEl)
      .setName("Metin")
      .addText((text) => {
        input = text;
        text.setValue(this.search.term || "");
      });
    new Setting(modal.contentEl).addButton((btn) =>
      btn.setButtonText("Ara").setCta().onClick(() => {
        const term = ((input && input.getValue()) || "").trim();
        modal.close();
        if (term) this.runSearch(side, term);
      })
    );
    modal.open();
  }

  runSearch(side, term) {
    const previewEl = this.panes[side].querySelector(".markdown-preview-view");
    if (!previewEl) return;
    /* Aynı terim tekrar aranırsa sonraki sonuca atla */
    if (this.search.term === term && this.search.side === side && this.search.hits) {
      this.search.index = (this.search.index + 1) % this.search.hits;
      this.jumpToHit(side);
      new Notice("Sonuç " + (this.search.index + 1) + "/" + this.search.hits);
      return;
    }
    this.clearSearch(side);
    const search = { term, side, hits: 0, index: 0 };
    const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && n.parentElement.closest("a")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const lower = term.toLowerCase();
    for (const node of nodes) {
      const idx = node.nodeValue.toLowerCase().indexOf(lower);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + term.length);
      const mark = document.createElement("span");
      mark.classList.add("split-notes-search-hit");
      try {
        range.surroundContents(mark);
        search.hits++;
      } catch (e) { /* düğüm sınırında bölünemiyorsa atla */ }
    }
    this.search = search;
    if (!search.hits) {
      new Notice("Bulunamadı: " + term);
      this.search.term = null;
      return;
    }
    this.jumpToHit(side);
    new Notice(term + " — " + search.hits + " sonuç");
  }

  jumpToHit(side) {
    const hits = this.panes[side].querySelectorAll(".split-notes-search-hit");
    if (!hits.length) return;
    hits.forEach((h) => h.classList.remove("is-active"));
    const hit = hits[this.search.index % hits.length];
    hit.classList.add("is-active");
    const r = hit.getBoundingClientRect();
    const el = this.scrolls[side];
    const elR = el.getBoundingClientRect();
    el.scrollTop += r.top - elR.top - el.clientHeight / 3;
  }

  clearSearch(side) {
    this.panes[side].querySelectorAll(".split-notes-search-hit").forEach((h) => {
      const parent = h.parentElement;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(h.textContent || ""), h);
      parent.normalize();
    });
    this.search = { term: null, side: null, hits: 0, index: -1 };
  }

  /* ---------------------------------------------------------------- */
  /* Başlık bazlı senkron kaydırma yardımcıları                         */
  /* ---------------------------------------------------------------- */
  currentHeadingIndex(side) {
    const el = this.scrolls[side];
    const headings = el.querySelectorAll("h1, h2, h3, h4, h5, h6");
    if (!headings.length) return null;
    const elTop = el.getBoundingClientRect().top;
    let idx = 0;
    headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top - elTop <= 8) idx = i;
    });
    return idx;
  }

  headingTop(side, index) {
    if (index === null) return null;
    const el = this.scrolls[side];
    const headings = el.querySelectorAll("h1, h2, h3, h4, h5, h6");
    if (!headings.length) return null;
    const h = headings[Math.min(index, headings.length - 1)];
    const r = h.getBoundingClientRect();
    const elR = el.getBoundingClientRect();
    return Math.max(0, el.scrollTop + r.top - elR.top - 8);
  }

  /* ---------------------------------------------------------------- */
  /* Çiftler (kayıtlı not çiftleri)                                    */
  /* ---------------------------------------------------------------- */
  pickPair() {
    if (!this.plugin.settings.pairs.length) {
      new Notice("Kayıtlı çift yok. Panelleri açıp “Mevcut panelleri çift olarak kaydet” komutunu kullanın.");
      return;
    }
    new PairPickerModal(this.app, this.plugin, (pair) => this.loadPair(pair)).open();
  }

  loadPair(pair) {
    const load = (side, path) => {
      if (!path) return;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f && "basename" in f) this.setFile(side, f);
      else new Notice("Çiftteki not bulunamadı: " + path);
    };
    load("left", pair.leftPath);
    load("right", pair.rightPath);
    /* Sık kullanılan çift önerileri için kullanımı say */
    const usage = this.plugin.settings.pairUsage || {};
    usage[pair.name] = (usage[pair.name] || 0) + 1;
    this.plugin.settings.pairUsage = usage;
    void this.plugin.saveSettings();
  }

  /* Mevcut panelleri ad sorarak kaydet */
  saveCurrentAsPair() {
    if (!this.files.left && !this.files.right) {
      new Notice("Kaydedilecek not yok: paneller boş.");
      return;
    }
    const nameOf = (file) => (file ? file.basename : "—");
    const defaultName = nameOf(this.files.left) + " ↔ " + nameOf(this.files.right);
    new PairNameModal(this.app, defaultName, (name) => {
      const existing = this.plugin.settings.pairs.find((p) => p.name === name);
      const entry = {
        name,
        leftPath: this.files.left ? this.files.left.path : null,
        rightPath: this.files.right ? this.files.right.path : null
      };
      if (existing) Object.assign(existing, entry);
      else this.plugin.settings.pairs.push(entry);
      void this.plugin.saveSettings();
      new Notice(existing ? "Çift güncellendi: " + name : "Çift kaydedildi: " + name);
    }).open();
  }

  /* ---------------------------------------------------------------- */
  /* Panel geçmişi (geri / ileri)                                      */
  /* ---------------------------------------------------------------- */
  pushHistory(side, file) {
    if (!file) return;
    const h = this.history[side];
    const path = file.path;
    if (h.stack[h.index] === path) return;
    /* İleriyi kes, yeni girdiyi ekle */
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(path);
    /* Geçmişi sınırlı tut: en eski girdiler düşer */
    if (h.stack.length > HISTORY_LIMIT) h.stack = h.stack.slice(-HISTORY_LIMIT);
    h.index = h.stack.length - 1;
  }

  canGoBack(side) {
    return this.history[side].index > 0;
  }

  canGoForward(side) {
    const h = this.history[side];
    return h.index < h.stack.length - 1;
  }

  navigate(side, dir) {
    const h = this.history[side];
    const next = h.index + dir;
    if (next < 0 || next >= h.stack.length) return;
    h.index = next;
    const f = this.app.vault.getAbstractFileByPath(h.stack[next]);
    if (f && "basename" in f) {
      this.loadWithoutHistory(side, f);
    } else {
      new Notice("Not bulunamadı: " + h.stack[next]);
    }
  }

  /* Geçmiş komutları için son kullanılan panel */
  getLastSide() {
    return this.lastSide || "left";
  }

  /* ---------------------------------------------------------------- */
  /* Çekirdek sağ tık menüsü                                           */
  /* ---------------------------------------------------------------- */
  paneMenu(evt, side) {
    const file = this.files[side];
    const menu = new Menu();
    if (file) {
      menu.addItem((item) =>
        item
          .setTitle("Yeni sekmede aç")
          .setIcon("file-text")
          .onClick(() => this.openInEditor(side))
      );
      menu.addItem((item) =>
        item
          .setTitle("Önbellekten yenile")
          .setIcon("rotate-cw")
          .onClick(() => this.renderPane(side))
      );
      menu.addSeparator();
    }
    /* Gezinme geçmişi */
    menu.addItem((item) =>
      item
        .setTitle("Geri")
        .setIcon("chevrons-left")
        .setDisabled(!this.canGoBack(side))
        .onClick(() => this.navigate(side, -1))
    );
    menu.addItem((item) =>
      item
        .setTitle("İleri")
        .setIcon("chevrons-right")
        .setDisabled(!this.canGoForward(side))
        .onClick(() => this.navigate(side, 1))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Not seç...")
        .setIcon("search")
        .onClick(() => this.chooseFile(side))
    );
    menu.addItem((item) =>
      item
        .setTitle("Mevcut panelleri çift olarak kaydet")
        .setIcon("bookmark")
        .onClick(() => this.saveCurrentAsPair())
    );
    menu.addItem((item) =>
      item
        .setTitle("Panelleri değiştir")
        .setIcon("arrow-left-right")
        .onClick(() => this.swap())
    );
    menu.addItem((item) =>
      item
        .setTitle("Bu panele odaklan")
        .setIcon("zoom-in")
        .onClick(() => this.focusPane(side))
    );
    menu.addItem((item) =>
      item
        .setTitle("Panelleri eşitle")
        .setIcon("columns-2")
        .onClick(() => this.focusPane(null))
    );
    menu.addItem((item) =>
      item
        .setTitle("Kalıptan eşleştir")
        .setIcon("wand")
        .onClick(() => this.applyPairTemplate(side))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Panelde ara...")
        .setIcon("search")
        .onClick(() => this.searchInPane(side))
    );
    if (this.search.term) {
      menu.addItem((item) =>
        item
          .setTitle("Aramayı temizle")
          .setIcon("x-circle")
          .onClick(() => this.clearSearch(side))
      );
    }
    if (file) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Paneli temizle")
          .setIcon("x")
          .onClick(() => this.clearPane(side))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /* ---------------------------------------------------------------- */
  /* Render — kaydırma konumunu koru                                   */
  /* ---------------------------------------------------------------- */
  async renderPane(side) {
    const gen = ++this.renderGeneration;
    const file = this.files[side];
    this.setTitle(side, file);
    const previewEl = this.panes[side].querySelector(".markdown-preview-view");
    if (!previewEl) return;

    if (this.components[side]) {
      this.components[side].unload();
      this.components[side] = null;
    }

    if (!file) {
      this.showEmptyState(side);
      return;
    }

    const previousScrollTop = this.scrolls[side].scrollTop;
    previewEl.empty();

    /* Görseller çekirdek görüntüleyici gibi gösterilir */
    const ext = file.extension ? file.extension.toLowerCase() : "";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)) {
      previewEl.createEl("img", {
        cls: "split-notes-image",
        attr: { src: this.app.vault.getResourcePath(file), alt: file.basename }
      });
      this.scrolls[side].scrollTop = 0;
      return;
    }
    if (ext === "pdf") {
      const note = previewEl.createDiv({ cls: "empty-state" });
      note.createDiv({ cls: "empty-state-title", text: "PDF önizleme" });
      note.createDiv({
        cls: "empty-state-content",
        text: "PDF'ler bu panelde gösterilemiyor. \u201CYeni sekmede aç\u201D ile açın."
      });
      return;
    }

    const sizer = previewEl.createDiv({ cls: "markdown-preview-sizer" });

    const component = new Component();
    component.load();
    this.components[side] = component;

    try {
      const content = await this.app.vault.cachedRead(file);
      await MarkdownRenderer.render(
        this.app,
        content,
        sizer,
        file.path,
        component
      );
      /* Bu render bu sırada bayatladıysa (başka not seçildi) sonucu
         boşuna uygulamayı bırak; yenisi zaten yolda. */
      if (gen !== this.renderGeneration || this.files[side] !== file) {
        component.unload();
        if (this.components[side] === component) this.components[side] = null;
        return;
      }
      this.wireLinks(side, previewEl, file);
      const saved = this.scrollMemory.get(file.path);
      this.scrolls[side].scrollTop =
        Number.isFinite(saved) ? saved : previousScrollTop;
    } catch (err) {
      console.error("split-notes: render hatası", err);
      new Notice("Not görüntülenemedi: " + file.path);
      this.showEmptyState(side);
    }
  }

  /* İç linkler çekirdek davranışla açılır: hedef panelde gösterilir,
     Shift/Cmd ile yeni sekmede açılır. */
  wireLinks(side, el, sourceFile) {
    el.on("click", "a.internal-link, a[data-href]", (evt, target) => {
      evt.preventDefault();
      const href = target.getAttribute("data-href") || target.getAttribute("href");
      if (!href) return;
      const dest = this.app.metadataCache.getFirstLinkpathDest(href, sourceFile.path);
      if (!dest) {
        new Notice("Not bulunamadı: " + href);
        return;
      }
      if (evt.shiftKey || (evt.metaKey || evt.ctrlKey)) {
        void this.app.workspace.openLinkText(dest.path, "/", false);
        return;
      }
      /* Akıllı hedef: not zaten bir panelde açıksa o paneli tazele,
         değilse diğer panelde aç. */
      if (this.plugin.settings.linkTarget === "smart") {
        if (this.files.left && this.files.left.path === dest.path) {
          this.renderPane("left");
          return;
        }
        if (this.files.right && this.files.right.path === dest.path) {
          this.renderPane("right");
          return;
        }
        this.setFile(side === "left" ? "right" : "left", dest);
        return;
      }
      const targetSide =
        this.plugin.settings.linkTarget === "other"
          ? (side === "left" ? "right" : "left")
          : side;
      this.setFile(targetSide, dest);
    });

    /* Harici linkler sistem tarayıcısında açılır */
    el.on("click", "a.external-link, a[href^='http']", (evt, target) => {
      evt.preventDefault();
      const href = target.getAttribute("data-href") || target.getAttribute("href");
      if (href) window.open(href, "_blank");
    });
  }

  /* ---------------------------------------------------------------- */
  /* Senkron kaydırma                                                   */
  /* ---------------------------------------------------------------- */
  registerSyncScroll(side, scrollEl) {
    this.lastScrollTops[side] = 0;

    scrollEl.addEventListener("scroll", () => {
      /* Delta: bu kaydırma olayında ne kadar ilerledik */
      const prevTop = this.lastScrollTops[side];
      const delta = scrollEl.scrollTop - prevTop;
      this.lastScrollTops[side] = scrollEl.scrollTop;

      const pending = this.programmaticScrolls[side];
      if (pending) {
        window.clearTimeout(pending.timeout);
        this.programmaticScrolls[side] = null;
        // Hedef panelin programatik scroll olayıdır; geri senkronlama.
        if (Math.abs(scrollEl.scrollTop - pending.top) < 2) return;
      }

      if (!this.plugin.settings.syncScroll) return;

      const other = side === "left" ? "right" : "left";
      const otherEl = this.scrolls[other];
      if (!otherEl) return;

      let targetTop;
      if (this.plugin.settings.syncScrollMode === "heading") {
        /* Başlık bazlı: görünür başlık sırası diğer panelde eşlenir */
        const hIndex = this.currentHeadingIndex(side);
        const otherHeadingTop = this.headingTop(other, hIndex);
        if (otherHeadingTop === null) return;
        targetTop = otherHeadingTop;
      } else if (this.plugin.settings.syncScrollMode === "delta") {
        /* Aynı mesafe: ne kadar kaydırırsan diğer panel o kadar kayar */
        const targetMax = Math.max(0, otherEl.scrollHeight - otherEl.clientHeight);
        targetTop = Math.min(Math.max(0, otherEl.scrollTop + delta), targetMax);
      } else {
        /* Aynı oran: uzun/kısa notlarda oransal konum korunur */
        const sourceMax = scrollEl.scrollHeight - scrollEl.clientHeight;
        const targetMax = otherEl.scrollHeight - otherEl.clientHeight;
        if (sourceMax <= 0 || targetMax <= 0) return;
        const ratio = Math.min(1, Math.max(0, scrollEl.scrollTop / sourceMax));
        targetTop = ratio * targetMax;
      }
      const oldPending = this.programmaticScrolls[other];
      if (oldPending) window.clearTimeout(oldPending.timeout);

      const pendingTarget = { top: targetTop, timeout: null };
      // Scroll olayı bazı durumlarda (aynı konum/arka plan) gönderilmeyebilir;
      // zaman aşımı, işaretin sonraki gerçek kullanıcı kaydırmasını yutmasını önler.
      pendingTarget.timeout = window.setTimeout(() => {
        if (this.programmaticScrolls[other] === pendingTarget) {
          this.programmaticScrolls[other] = null;
        }
      }, 150);
      this.programmaticScrolls[other] = pendingTarget;
      this.lastScrollTops[other] = targetTop;
      otherEl.scrollTop = targetTop;
    }, { passive: true });
  }

  /* ---------------------------------------------------------------- */
  /* Dosya yaşam döngüsü                                                */
  /* ---------------------------------------------------------------- */
  refreshIfVisible(file) {
    for (const side of ["left", "right"]) {
      if (this.files[side] && this.files[side].path === file.path) {
        this.debouncedRender(side);
      }
    }
  }

  onRename(file, oldPath) {
    for (const side of ["left", "right"]) {
      if (this.files[side] && this.files[side].path === oldPath) {
        this.files[side] = file;
        this.setTitle(side, file);
        void this.saveState();
      }
      /* Geçmişteki eski yolları da güncelle */
      const h = this.history[side];
      h.stack = h.stack.map((p) => (p === oldPath ? file.path : p));
    }
    /* Kayıtlı çiftlerdeki eski yolları da güncelle (yoksa çift bozulur) */
    let pairsChanged = false;
    for (const pair of this.plugin.settings.pairs) {
      if (pair.leftPath === oldPath) { pair.leftPath = file.path; pairsChanged = true; }
      if (pair.rightPath === oldPath) { pair.rightPath = file.path; pairsChanged = true; }
    }
    if (pairsChanged) void this.plugin.saveSettings();
    /* Kaydırma hafızasındaki eski anahtarı taşı */
    if (this.scrollMemory.has(oldPath)) {
      this.scrollMemory.set(file.path, this.scrollMemory.get(oldPath));
      this.scrollMemory.delete(oldPath);
    }
  }

  onDelete(file) {
    for (const side of ["left", "right"]) {
      if (this.files[side] && this.files[side].path === file.path) {
        this.clearPane(side);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Durum kaydı                                                        */
  /* ---------------------------------------------------------------- */
  async saveState() {
    if (!this.plugin.settings.rememberNotes) return;
    const state = this.plugin.settings;
    state.leftPath = this.files.left ? this.files.left.path : null;
    state.rightPath = this.files.right ? this.files.right.path : null;
    await this.plugin.saveSettings();
  }

  async restoreState() {
    const { leftPath, rightPath } = this.plugin.settings;
    const load = (side, path) => {
      if (!path) return;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f && "basename" in f) this.loadWithoutHistory(side, f);
    };
    load("left", leftPath);
    load("right", rightPath);
  }

  get debouncedRender() {
    if (!this._debounced) {
      this._debounced = {
        left: debounce(() => this.renderPane("left"), 250, true),
        right: debounce(() => this.renderPane("right"), 250, true)
      };
    }
    return this._debounced;
  }
}

/* ================================================================== */
/* Ayarlar sekmesi — çekirdek eklenti ayar görünümü                    */
/* ================================================================== */
class SplitNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Panel yönü")
      .setDesc("Panellerin yan yana mı, alt alta mı dizileceği.")
      .addDropdown((drop) =>
        drop
          .addOptions({
            auto: "Otomatik (dar ekranda alt alta)",
            row: "Yan yana",
            column: "Alt alta"
          })
          .setValue(this.plugin.settings.splitDirection)
          .onChange(async (value) => {
            this.plugin.settings.splitDirection = value;
            await this.plugin.saveSettings();
            this.plugin.applyLayout();
          })
      );

    new Setting(containerEl)
      .setName("Son notları hatırla")
      .setDesc("Görünüm yeniden açıldığında son görüntülenen notlar geri yüklenir.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.rememberNotes)
          .onChange(async (value) => {
            this.plugin.settings.rememberNotes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Senkron kaydırma")
      .setDesc("Bir panel kaydırıldığında diğeri aynı oranda kayar.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncScroll)
          .onChange(async (value) => {
            this.plugin.settings.syncScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Senkron kaydırma türü")
      .setDesc("Aynı mesafe: ne kadar kaydırırsan diğer panel de o kadar kayar. Aynı oran: paneller oransal konumda eşlenir. Başlık bazlı: paneller aynı sıradaki başlıkta hizalanır.")
      .addDropdown((drop) =>
        drop
          .addOptions({
            delta: "Aynı mesafe (ne kadar kaydırsan o kadar)",
            proportional: "Aynı oran (oransal konum)",
            heading: "Başlık bazlı (aynı sıradaki başlıkta hizala)"
          })
          .setValue(this.plugin.settings.syncScrollMode)
          .onChange(async (value) => {
            this.plugin.settings.syncScrollMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bağlantı hedefi")
      .setDesc("Bir nottaki bağlantıya dokunduğunda hedef not nerede açılsın?")
      .addDropdown((drop) =>
        drop
          .addOptions({
            other: "Diğer panelde aç",
            same: "Aynı panelde aç",
            smart: "Akıllı: açıksa o panelde, yoksa diğerinde"
          })
          .setValue(this.plugin.settings.linkTarget)
          .onChange(async (value) => {
            this.plugin.settings.linkTarget = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Alt menüyü gizle (mobil)")
      .setDesc("Mobildeki alt gezinme menüsünü tamamen gizler; paneller ekranın dibine kadar iner. Komut paletinden de değiştirilebilir.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideNavbar)
          .onChange(async (value) => {
            this.plugin.settings.hideNavbar = value;
            await this.plugin.saveSettings();
            this.plugin.updateGlobalClasses();
          })
      );

    new Setting(containerEl)
      .setName("Üst çubuğu gizle (saat alanı)")
      .setDesc("Uygulamanın en üstünde saat çubuğu için ayrılan boşluğu kaldırır; notlar en tepeden başlar. Komut paletinden de değiştirilebilir.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.hideStatusBar = value;
            await this.plugin.saveSettings();
            this.plugin.updateGlobalClasses();
          })
      );

    new Setting(containerEl)
      .setName("Gerçek tam ekran")
      .setDesc("Tam ekranda panel başlıkları da gizlenir; ekranda yalnızca iki not kalır. Çıkmak için iki parmakla küçültme hareketi yapın (masaüstünde Esc).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hidePaneHeadersInFullscreen)
          .onChange(async (value) => {
            this.plugin.settings.hidePaneHeadersInFullscreen = value;
            await this.plugin.saveSettings();
            this.plugin.applyChromelessToActiveView();
          })
      );

    new Setting(containerEl)
      .setName("Tam ekran üst payı (piksel)")
      .setDesc("Tam ekranda panellerin saat çubuğunun altından başlaması için üstte bırakılacak boşluk. 0 (varsayılan) = otomatik algıla: eklenti cihazın saat alanını kendisi ölçer.")
      .addText((text) => {
        text.inputEl.type = "number";
        text
          .setValue(String(this.plugin.settings.fullscreenTopInset ?? 0))
          .onChange(async (value) => {
            this.plugin.settings.fullscreenTopInset =
              Math.max(0, Math.round(Number(value) || 0));
            await this.plugin.saveSettings();
            this.plugin.applyTopInset();
          });
      });

    new Setting(containerEl)
      .setName("Tam ekranda saati göster")
      .setDesc("Açık: tam ekranda da saat çubuğu görünür ve paneller onun altından başlar; üst pay yatay ve dikey ekran için ayrı ayrı ölçülür. Kapalı: saat gizlenir, paneller en tepeden başlar.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showClockInFullscreen)
          .onChange(async (value) => {
            this.plugin.settings.showClockInFullscreen = value;
            await this.plugin.saveSettings();
            const v = this.plugin.getActiveSplitView();
            this.plugin.applyNativeFullscreenMode(!!(v && v.isFullscreen));
            this.plugin.applyTopInset();
          })
      );

    new Setting(containerEl)
      .setName("Çift şablonu (kalıp)")
      .setDesc("Örnek: {ad} ↔ {ad} çözüm. Kullanım: bir panele bir not aç, panel menüsünden (⋮) \u201CKalıptan eşleştir\u201D'e dokun. Eklenti notun adını kalıba yerleştirir (örn. \u201CSınav ↔ Sınav çözüm\u201D) ve uyan diğer notu karşı panele otomatik açar. Sol panelden çağırırsan sağ panele, sağdan çağırırsan sola açar.")
      .addText((text) =>
        text
          .setPlaceholder("{ad} ↔ {ad} çözüm")
          .setValue(this.plugin.settings.pairTemplate || "")
          .onChange(async (value) => {
            this.plugin.settings.pairTemplate = value.trim();
            await this.plugin.saveSettings();
          })
      );

    /* ---------------------------------------------------------------- */
    /* Çiftler yönetimi                                                  */
    /* ---------------------------------------------------------------- */
    containerEl.createEl("h4", { text: "Çiftler" });
    new Setting(containerEl)
      .setName("Mevcut panelleri çift olarak kaydet")
      .setDesc("Açık görünümdeki iki notu, ad vererek kaydeder.")
      .addButton((btn) =>
        btn
          .setButtonText("Kaydet")
          .setCta()
          .onClick(() => {
            const view = this.plugin.getFirstView();
            if (view) view.saveCurrentAsPair();
            else new Notice("Önce çift not görünümünü açın.");
          })
      );

    if (!this.plugin.settings.pairs.length) {
      containerEl.createDiv({
        cls: "setting-item-description",
        text: "Henüz kayıtlı çift yok."
      });
      return;
    }

    for (const pair of this.plugin.settings.pairs.slice()) {
      const usage = (this.plugin.settings.pairUsage || {})[pair.name] || 0;
      const s = new Setting(containerEl)
        .setName(pair.name)
        .setDesc(
          (pair.leftPath || "—") + "  ↔  " + (pair.rightPath || "—") +
          "   •   " + usage + " kez yüklendi"
        );
      s.addButton((btn) =>
        btn.setButtonText("Yükle").onClick(async () => {
          const view = await this.plugin.activateView();
          view.loadPair(pair);
        })
      );
      s.addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip("Çifti sil")
          .onClick(async () => {
            this.plugin.settings.pairs =
              this.plugin.settings.pairs.filter((p) => p !== pair);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    }
  }
}

/* ================================================================== */
/* Eklenti                                                             */
/* ================================================================== */
class SplitNotesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.applyTopInset();
    this.applyNativeFullscreenMode(false);

    /* Gövde sınıfları yalnızca çift görünüm etkinken açık: başka bir
       nota geçildiğinde alt menü / üst çubuk / tam ekran geri gelir. */
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.updateGlobalClasses())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.updateGlobalClasses();
        this.applyTopInset();
      })
    );

    /* Cihaz döndürülünce / pencere boyutlanınca yatay-dikey için ayrı
       ölçülen saat payını yeniden uygula. */
    const reapplyInset = debounce(() => this.applyTopInset(), 250, true);
    this.registerDomEvent(window, "orientationchange", reapplyInset);
    this.registerDomEvent(window, "resize", reapplyInset);

    this.registerView(VIEW_TYPE, (leaf) => new SplitNotesView(leaf, this));

    this.addSettingTab(new SplitNotesSettingTab(this.app, this));

    this.addRibbonIcon("columns-2", "Çift not görünümü", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open",
      name: "Çift not görünümünü aç",
      callback: () => void this.activateView()
    });

    this.addCommand({
      id: "open-with-active",
      name: "Aktif notu çift görünümde aç",
      callback: () => void this.activateViewWithActive()
    });

    this.addCommand({
      id: "toggle-fullscreen",
      name: "Tam ekranı aç/kapat",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.toggleFullscreen();
        return true;
      }
    });

    this.addCommand({
      id: "swap",
      name: "Panellerin yerini değiştir",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.swap();
        return true;
      }
    });

    /* ---- Yeni: panele gönderme ---- */
    const sendTo = (side) => {
      return () => void this.activateViewWithActive(side);
    };
    this.addCommand({
      id: "send-active-left",
      name: "Aktif notu sol panele gönder",
      callback: sendTo("left")
    });
    this.addCommand({
      id: "send-active-right",
      name: "Aktif notu sağ panele gönder",
      callback: sendTo("right")
    });

    /* ---- Yeni: çiftler ---- */
    this.addCommand({
      id: "save-pair",
      name: "Mevcut panelleri çift olarak kaydet",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.saveCurrentAsPair();
        return true;
      }
    });

    this.addCommand({
      id: "load-pair",
      name: "Kayıtlı çift yükle...",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.pickPair();
        return true;
      }
    });

    /* ---- Yeni: alt menü gizle/göster ---- */
    this.addCommand({
      id: "toggle-navbar",
      name: "Alt menüyü gizle/göster (mobil)",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.toggleNavbar();
        return true;
      }
    });

    /* ---- Yeni: üst çubuk (saat alanı) gizle/göster ---- */
    this.addCommand({
      id: "toggle-statusbar",
      name: "Üst çubuğu (saat alanı) gizle/göster",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.toggleStatusBar();
        return true;
      }
    });

    /* ---- Yeni: tam ekranda panel başlıklarını gizle/göster ---- */
    this.addCommand({
      id: "toggle-pane-headers",
      name: "Tam ekranda panel başlıklarını gizle/göster",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) {
          this.settings.hidePaneHeadersInFullscreen =
            !this.settings.hidePaneHeadersInFullscreen;
          void this.saveSettings();
          this.applyChromelessToActiveView();
        }
        return true;
      }
    });

    /* ---- Yeni: panel geçmişi ---- */
    this.addCommand({
      id: "history-back",
      name: "Son kullanılan panelde geri git",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        const side = view.getLastSide();
        if (!view.canGoBack(side)) return false;
        if (!checking) view.navigate(side, -1);
        return true;
      }
    });
    this.addCommand({
      id: "history-forward",
      name: "Son kullanılan panelde ileri git",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        const side = view.getLastSide();
        if (!view.canGoForward(side)) return false;
        if (!checking) view.navigate(side, 1);
        return true;
      }
    });

    /* ---- 3.4: odak modu ve panelde arama ---- */
    this.addCommand({
      id: "focus-left",
      name: "Sol panele odaklan",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.focusPane("left");
        return true;
      }
    });
    this.addCommand({
      id: "focus-right",
      name: "Sağ panele odaklan",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.focusPane("right");
        return true;
      }
    });
    this.addCommand({
      id: "balance-panes",
      name: "Panelleri eşitle",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.focusPane(null);
        return true;
      }
    });
    this.addCommand({
      id: "search-in-left",
      name: "Sol panelde ara",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.searchInPane("left");
        return true;
      }
    });
    this.addCommand({
      id: "search-in-right",
      name: "Sağ panelde ara",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.searchInPane("right");
        return true;
      }
    });
  }

  onunload() {
    document.body.classList.remove("split-notes-hide-navbar");
    document.body.classList.remove("split-notes-hide-statusbar");
    document.body.classList.remove("split-notes-fullscreen");
    document.body.classList.remove("split-notes-native-fs");
    this.applyNativeFullscreenMode(false);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.pairs)) this.settings.pairs = [];
    if (typeof this.settings.pairUsage !== "object" || this.settings.pairUsage === null) {
      this.settings.pairUsage = {};
    }
    if (!Number.isFinite(this.settings.paneRatio)) this.settings.paneRatio = 0.5;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* Yön ayarı değişince TÜM açık çift görünümlerini güncelle */
  applyLayout() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (!(leaf.view instanceof SplitNotesView)) return;
      const el = leaf.view.contentEl;
      el.removeClass("is-row", "is-column");
      const d = this.settings.splitDirection;
      if (d === "row") el.addClass("is-row");
      if (d === "column") el.addClass("is-column");
      leaf.view.applyPaneRatio();
    });
  }

  /* "Gerçek tam ekran" ayarı değişince tüm çift görünümlerini güncelle */
  applyChromelessToActiveView() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof SplitNotesView) {
        leaf.view.applyChromeless(leaf.view.isFullscreen);
      }
    });
  }

  tryNativeStatusBarHide() {
    try {
      const statusBar =
        window.Capacitor && window.Capacitor.Plugins &&
        window.Capacitor.Plugins.StatusBar;
      if (statusBar && typeof statusBar.hide === "function") {
        const r = statusBar.hide();
        return Promise.resolve(r || true).then(() => true).catch(() => false);
      }
    } catch (e) {
      // no-op: native bridge may be absent or unsupported
    }
    return Promise.resolve(false);
  }

  tryNativeStatusBarShow() {
    try {
      const statusBar = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
      if (statusBar && typeof statusBar.show === "function") {
        statusBar.show();
      }
    } catch (e) {
      // no-op
    }
  }

  tryBrowserFullscreenHide() {
    const root = document.documentElement;
    if (!root || typeof root.requestFullscreen !== "function") return false;
    try {
      /* navigationUI desteklenmiyorsa kural dışı düşebilir; promise
         reddini yakala ki konsol kirlenmesin. */
      const p = root.requestFullscreen({ navigationUI: "hide" });
      if (p && typeof p.catch === "function") p.catch(() => {});
      return true;
    } catch (e) {
      try {
        const p = root.requestFullscreen();
        if (p && typeof p.catch === "function") p.catch(() => {});
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  exitBrowserFullscreen() {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen();
      }
    } catch (e) {
      // no-op
    }
  }

  applyNativeFullscreenMode(enabled) {
    if (enabled) {
      if (this.settings.showClockInFullscreen) {
        /* Ayar açık: native saat çubuğu GÖRÜNÜR kalır, paneller saat
           için ayrılan payın altından başlar (yön bazlı ölçüm). */
        document.body.classList.remove("split-notes-native-fs");
        this.tryNativeStatusBarShow();
      } else {
        this.tryNativeStatusBarHide()
          .then((ok) => {
            /* Native saat gizlendiyse üstte ayrıca pay bırakmaya gerek
               yok; CSS bu sınıfla payı sıfırlar. */
            document.body.classList.toggle("split-notes-native-fs", !!ok);
          })
          .catch(() => {});
      }
      this.tryBrowserFullscreenHide();
    } else {
      document.body.classList.remove("split-notes-native-fs");
      this.tryNativeStatusBarShow();
      this.exitBrowserFullscreen();
    }
  }

  /* Saat çubuğu payı otomatik ölçümü. İki kaynağın en büyüğü kullanılır:
     1) Obsidian'ın kendi app-container üst dolgusu — cihazda saat için
        ayrılan alanın birebir aynısı (en güvenilir ölçü).
     2) CSS env()/var() zincirinin ara bir elemanla çözümlenen değeri. */
  measureSafeAreaTop() {
    let measured = 0;
    try {
      const app = document.querySelector(".app-container");
      if (app) {
        const native = parseFloat(getComputedStyle(app).paddingTop);
        if (Number.isFinite(native) && native > measured) measured = native;
      }
    } catch (e) { /* yok say */ }
    try {
      /* Obsidian'ın resmi değişkenleri: Android'de --status-bar-height,
         mobilde --safe-area-inset-top tanımlıdır. */
      const styles = getComputedStyle(document.body);
      for (const name of ["--status-bar-height", "--safe-area-inset-top"]) {
        const v = parseFloat(styles.getPropertyValue(name));
        if (Number.isFinite(v) && v > measured) measured = v;
      }
    } catch (e) { /* yok say */ }
    try {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;" +
        "height:0;width:0;padding-top:var(--safe-area-inset-top, env(safe-area-inset-top, 0px));";
      document.body.appendChild(probe);
      const v = parseFloat(getComputedStyle(probe).paddingTop);
      probe.remove();
      if (Number.isFinite(v) && v > measured) measured = v;
    } catch (e) { /* yok say */ }
    return Math.round(measured);
  }

  /* Tam ekran üst payı: manuel değer 0 ise (varsayılan) cihazın saat
     alanı otomatik ölçülür. Manuel değer yalnızca otomatik ölçüm
     tutmuyorsa gerekli bir yedektir. */
  applyTopInset() {
    const manual = Math.max(0, Math.round(Number(this.settings.fullscreenTopInset) || 0));
    if (manual > 0) {
      document.body.style.setProperty("--split-notes-top-inset", manual + "px");
      return;
    }
    /* Saat payı yatay ve dikey ekranda FARKLIDIR; her yön için ayrı
       ölçüm saklanır ve cihaz döndürülünce doğru olan uygulanır. */
    const key =
      (typeof screen !== "undefined" && screen.orientation &&
        String(screen.orientation.type || "").startsWith("landscape")) ||
      window.innerWidth > window.innerHeight
        ? "landscape"
        : "portrait";
    if (!this._measuredTop) this._measuredTop = {};
    /* native-fs açıkken (saat gizliyken) app-container dolgusu 0'a iner
       ve ölçüm yanıltıcı 0 çıkar; o durumda ölçme, saklanan değeri koru. */
    const clockHidden =
      document.body.classList.contains("split-notes-fullscreen") &&
      document.body.classList.contains("split-notes-native-fs");
    if (!clockHidden) {
      const measured = this.measureSafeAreaTop();
      if (measured > 0) this._measuredTop[key] = measured;
    }
    const fallback = key === "portrait" ? "landscape" : "portrait";
    const inset =
      this._measuredTop[key] || this._measuredTop[fallback] || 0;
    document.body.style.setProperty("--split-notes-top-inset", inset + "px");
  }

  /* Şu anda görüntülenen görünüm çift not görünümü mü? */
  getActiveSplitView() {
    const view = this.app.workspace.getActiveViewOfType(SplitNotesView);
    return view instanceof SplitNotesView ? view : null;
  }

  /* Gövde sınıfları YALNIZCA çift görünüm etkinken uygulanır; başka
     bir nota/viewa geçilince hepsi kaldırılır. */
  updateGlobalClasses() {
    const view = this.getActiveSplitView();
    const on = !!view;
    document.body.classList.toggle(
      "split-notes-hide-navbar",
      on && !!this.settings.hideNavbar
    );
    document.body.classList.toggle(
      "split-notes-hide-statusbar",
      on && !!this.settings.hideStatusBar
    );
    const fullscreenNow = on && !!(view && view.isFullscreen);
    /* Tam ekrandan başka görünüme geçildiyse native saat çubuğunu ve
       tarayıcı tam ekranını geri getir (yoksa saat gizli kalır). */
    if (!fullscreenNow && document.body.classList.contains("split-notes-fullscreen")) {
      this.applyNativeFullscreenMode(false);
    }
    document.body.classList.toggle("split-notes-fullscreen", fullscreenNow);
  }

  /* Komutlar yalnızca ETKİN çift görünümü hedefler; arka plandaki
     sekmedeki görünümü değil. */
  getActiveView() {
    return this.getActiveSplitView();
  }

  /* Arka planda açık olsa bile ilk çift görünümü (ayarlar sekmesi için) */
  getFirstView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf && leaf.view instanceof SplitNotesView ? leaf.view : null;
  }

  /* Çiftleri kullanım sayısına göre sırala (sık kullanılan önce) */
  getSortedPairs() {
    const usage = this.settings.pairUsage || {};
    return this.settings.pairs
      .slice()
      .sort((a, b) => (usage[b.name] || 0) - (usage[a.name] || 0));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async activateViewWithActive(side) {
    const view = await this.activateView();
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Aktif not yok.");
      return;
    }
    if (side) view.setFile(side, file);
    else view.setFile("left", file);
  }
}

module.exports = SplitNotesPlugin;
