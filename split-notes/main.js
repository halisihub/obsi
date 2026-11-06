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
 * 3.0: Çiftler (kayıtlı not çiftleri), mobil panel odağı, panele gönderme,
 *      panel başına gezinme geçmişi.
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
  TextComponent,
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
  hideNavbar: false         // mobil alt menü gizli mi
};

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
    return this.plugin.settings.pairs;
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
    this.buildPane("right");

    /* Çekirdek görünüm başlığı düğmesi: senkron kaydırmayı
       tek dokunuşla aç/kapat (ayarlara girmeden). */
    this.syncBtn = this.addAction("link-2", "Senkron kaydırma", () => {
      this.plugin.settings.syncScroll = !this.plugin.settings.syncScroll;
      void this.plugin.saveSettings();
      this.updateSyncButton();
    });
    this.updateSyncButton();

    /* Çekirdek görünüm başlığı düğmesi: kayıtlı çiftleri yükle */
    this.addAction("layers", "Çift yükle...", () => {
      this.pickPair();
    });

    /* Çekirdek görünüm başlığı düğmesi: tam ekran */
    this.fsBtn = this.addAction("maximize-2", "Tam ekran", () => {
      this.toggleFullscreen();
    });

    /* EN SAĞ düğme: mobil alt menüyü gizle/göster */
    this.navBtn = this.addAction("eye-off", "Alt menüyü gizle/göster", () => {
      this.toggleNavbar();
    });
    this.applyNavbar();

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
    this.applyNavbar();
  }

  applyNavbar() {
    const on = this.plugin.settings.hideNavbar;
    document.body.classList.toggle("split-notes-hide-navbar", on);
    if (this.navBtn) {
      this.navBtn.classList.toggle("is-on", on);
      this.navBtn.setAttribute(
        "aria-label",
        on ? "Alt menü gizli — göstermek için dokun" : "Alt menüyü gizle"
      );
    }
  }

  /* Tam ekran: üst/alt çubukları gizle, paneller tüm ekranı kaplasın */
  toggleFullscreen() {
    const on = !document.body.classList.contains("split-notes-fullscreen");
    document.body.classList.toggle("split-notes-fullscreen", on);
    if (this.fsBtn) this.fsBtn.classList.toggle("is-on", on);
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
    if (title) title.setText(file ? file.basename : "Not seçilmedi");
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
    this.files[side] = file;
    this.pushHistory(side, file);
    this.renderPane(side);
    void this.saveState();
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
  /* Çiftler (kayıtlı not çiftleri)                                    */
  /* ---------------------------------------------------------------- */
  pickPair() {
    if (!this.plugin.settings.pairs.length) {
      new Notice("Kayıtlı çift yok. Panelleri açıp \u201CMevcut panelleri çift olarak kaydet\u201D komutunu kullanın.");
      return;
    }
    new PairPickerModal(this.app, this.plugin, (pair) => this.loadPair(pair)).open();
  }

  loadPair(pair) {
    const load = (side, path) => {
      if (!path) return;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f && "basename" in f) this.setFile(side, f);
    };
    load("left", pair.leftPath);
    load("right", pair.rightPath);
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
      this.wireLinks(side, previewEl, file);
      this.scrolls[side].scrollTop = previousScrollTop;
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
      } else {
        /* Ayara göre: aynı panelde ya da diğer panelde aç */
        const targetSide =
          this.plugin.settings.linkTarget === "other"
            ? (side === "left" ? "right" : "left")
            : side;
        this.setFile(targetSide, dest);
      }
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
      if (this.plugin.settings.syncScrollMode === "delta") {
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
    if (leftPath) {
      const f = this.app.vault.getAbstractFileByPath(leftPath);
      if (f && "basename" in f) this.setFile("left", f);
    }
    if (rightPath) {
      const f = this.app.vault.getAbstractFileByPath(rightPath);
      if (f && "basename" in f) this.setFile("right", f);
    }
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
      .setDesc("Aynı mesafe: ne kadar kaydırırsan diğer panel de o kadar kayar. Aynı oran: paneller oransal konumda eşlenir (uzun/kısa not uyumu).")
      .addDropdown((drop) =>
        drop
          .addOptions({
            delta: "Aynı mesafe (ne kadar kaydırsan o kadar)",
            proportional: "Aynı oran (oransal konum)"
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
            same: "Aynı panelde aç"
          })
          .setValue(this.plugin.settings.linkTarget)
          .onChange(async (value) => {
            this.plugin.settings.linkTarget = value;
            await this.plugin.saveSettings();
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
            const view = this.plugin.getActiveView();
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
      const s = new Setting(containerEl)
        .setName(pair.name)
        .setDesc((pair.leftPath || "—") + "  ↔  " + (pair.rightPath || "—"));
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
  }

  onunload() {
    document.body.classList.remove("split-notes-hide-navbar");
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.pairs)) this.settings.pairs = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* Yön ayarı değişince açık görünümü anında güncelle */
  applyLayout() {
    const view = this.getActiveView();
    if (!view) return;
    view.contentEl.removeClass("is-row", "is-column");
    if (this.settings.splitDirection === "row") view.contentEl.addClass("is-row");
    if (this.settings.splitDirection === "column") view.contentEl.addClass("is-column");
  }

  /* "Gerçek tam ekran" ayarı değişince açık görünümü güncelle */
  applyChromelessToActiveView() {
    const view = this.getActiveView();
    if (!view) return;
    view.applyChromeless(
      document.body.classList.contains("split-notes-fullscreen")
    );
  }

  getActiveView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf && leaf.view instanceof SplitNotesView ? leaf.view : null;
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
