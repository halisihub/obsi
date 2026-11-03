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
 */

const {
  Component,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
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
  hidePaneHeadersInFullscreen: false // gerçek tam ekran: panel başlıkları da gizlenir
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
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Çift not görünümü"; }
  getIcon() { return "columns-2"; }

  async onOpen() {
    const { settings } = this.plugin;
    this.contentEl.empty();
    this.contentEl.addClass("split-notes");

    /* Yön: kullanıcı seçimi varsa sınıfla sabitle, yoksa CSS'teki
       medya sorgusu (dar ekran = alt alta) geçerli olur. */
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

    /* Çekirdek görünüm başlığı düğmesi: tam ekran */
    this.fsBtn = this.addAction("maximize-2", "Tam ekran", () => {
      this.toggleFullscreen();
    });

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

  setFile(side, file) {
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
    menu.addItem((item) =>
      item
        .setTitle("Not seç...")
        .setIcon("search")
        .onClick(() => this.chooseFile(side))
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
  }

  onunload() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  async activateViewWithActive() {
    const view = await this.activateView();
    const file = this.app.workspace.getActiveFile();
    if (file) view.setFile("left", file);
  }
}

module.exports = SplitNotesPlugin;
