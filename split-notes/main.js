"use strict";

const obsidian = require("obsidian");

const VIEW_TYPE = "split-notes-view";

/* ------------------------------------------------------------------ */
/* Not seçici (FuzzySuggestModal) — çekirdek eklenti hissi veren arayüz */
/* ------------------------------------------------------------------ */
class NoteSuggestModal extends obsidian.FuzzySuggestModal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Not seç...");
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

/* ------------------------------------------------------------------ */
/* Ana görünüm                                                         */
/* ------------------------------------------------------------------ */
class SplitNotesView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.leftFile = null;
    this.rightFile = null;
    this.renderers = { left: null, right: null };
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Çift Not Görünümü";
  }

  getIcon() {
    return "columns-2";
  }

  async onOpen() {
    this.containerEl.classList.add("split-notes-view-container");
    this.contentEl.empty();
    this.contentEl.addClass("split-notes-content");

    /* Üst bar: iki not seçici */
    const header = this.contentEl.createDiv({ cls: "split-notes-header" });

    const leftBtn = header.createEl("button", {
      cls: "split-notes-picker",
      text: "Not seç"
    });
    leftBtn.addEventListener("click", () => {
      new NoteSuggestModal(this.app, (file) => this.setFile("left", file)).open();
    });
    this.leftPicker = leftBtn;

    const swapBtn = header.createEl("button", {
      cls: "split-notes-swap",
      attr: { "aria-label": "Yerleri değiştir" }
    });
    obsidian.setIcon(swapBtn, "arrow-left-right");
    swapBtn.addEventListener("click", () => this.swap());

    const rightBtn = header.createEl("button", {
      cls: "split-notes-picker",
      text: "Not seç"
    });
    rightBtn.addEventListener("click", () => {
      new NoteSuggestModal(this.app, (file) => this.setFile("right", file)).open();
    });
    this.rightPicker = rightBtn;

    /* İki panel */
    this.panesEl = this.contentEl.createDiv({ cls: "split-notes-panes" });

    this.leftPane = this.panesEl.createDiv({ cls: "split-notes-pane" });
    this.leftPane.createDiv({ cls: "split-notes-pane-empty", text: "Soldaki not için \"Not seç\"e dokun" });

    this.rightPane = this.panesEl.createDiv({ cls: "split-notes-pane" });
    this.rightPane.createDiv({ cls: "split-notes-pane-empty", text: "Sağdaki not için \"Not seç\"e dokun" });
  }

  async onClose() {
    Object.values(this.renderers).forEach((r) => r && r.unload());
  }

  setFile(side, file) {
    if (side === "left") this.leftFile = file;
    else this.rightFile = file;
    this.renderPane(side);
  }

  swap() {
    const f = this.leftFile;
    this.leftFile = this.rightFile;
    this.rightFile = f;
    this.renderPane("left");
    this.renderPane("right");
  }

  async renderPane(side) {
    const file = side === "left" ? this.leftFile : this.rightFile;
    const picker = side === "left" ? this.leftPicker : this.rightPicker;
    const pane = side === "left" ? this.leftPane : this.rightPane;

    if (picker) picker.setText(file ? file.basename : "Not seç");
    if (!file || !pane) return;

    /* Önceki render bileşenini temizle */
    if (this.renderers[side]) {
      this.renderers[side].unload();
      this.renderers[side] = null;
    }
    pane.empty();

    const scrollEl = pane.createDiv({ cls: "split-notes-scroll" });
    const component = new obsidian.Component();
    component.load();
    this.renderers[side] = component;

    try {
      const content = await this.app.vault.cachedRead(file);
      await obsidian.MarkdownRenderer.render(
        this.app,
        content,
        scrollEl,
        file.path,
        component
      );

      /* Not linkleri bu görünümde de çalışsın */
      scrollEl.addEventListener("click", (evt) => {
        const target = evt.target instanceof HTMLElement ? evt.target : null;
        const anchor = target && target.closest("a[data-href], a.internal-link");
        if (!anchor) return;
        evt.preventDefault();
        const href = anchor.getAttribute("data-href") || anchor.getAttribute("href");
        if (!href) return;
        const dest = this.app.metadataCache.getFirstLinkpathDest(href, file.path);
        if (dest) this.setFile(side, dest);
        else new obsidian.Notice("Not bulunamadı: " + href);
      });
    } catch (err) {
      pane.setText("Not görüntülenemedi.");
      console.error("split-notes:", err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Eklenti                                                             */
/* ------------------------------------------------------------------ */
class SplitNotesPlugin extends obsidian.Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new SplitNotesView(leaf, this));

    this.addRibbonIcon("columns-2", "Çift Not Görünümü", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-split-notes",
      name: "Çift not görünümünü aç",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "open-split-notes-with-active",
      name: "Aktif notu çift görünümde aç",
      callback: () => this.activateViewWithActive()
    });

    this.app.workspace.onLayoutReady(() => this.restoreLastNotes());
  }

  onunload() {
    /* Görünümü kapatınca leaf'i bırak */
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
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

  restoreLastNotes() {
    /* Klasördeki son açılan iki not varsa otomatik doldur */
    this.app.workspace.iterateAllLeaves(() => {});
  }
}

module.exports = SplitNotesPlugin;
