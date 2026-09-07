/**
 * TrigEdit — the Text Trigger Editor, a plugin for the scmJS map editor
 * (https://github.com/jeany55/scm-js).
 *
 * Triggers ▸ Text Trigger Editor… (Ctrl+Shift+T) shows the map's triggers as text in
 * SCMDraft 2's TrigEdit syntax and compiles the text back into the map. The syntax, the
 * printer and the parser are the editor's own (`api.triggers.text`, the same format File ▸
 * Import / Export Triggers read and write); this plugin is the dialog around them: the
 * Triggers / Briefing switch, Compile, Format, Reload, word wrap, a gutter that marks the
 * line that did not parse, and a comment fence around every run of triggers another plugin
 * generates (`api.triggers.claims`), so a reader knows which rows a rebuild will replace.
 *
 * Other plugins reach it two ways: the `trigedit.open` command (`{ briefing?: boolean }`),
 * and the `trigedit.text` dialog slot — a row at the left of the footer, lent the editor's
 * `text` field — which is how the scmjs.dev plugin puts its Explain / Write / Ask buttons in.
 *
 * `text.ts` is the pure half (the fencing and the words) and has the tests. Plain DOM only,
 * in the editor's own widget classes plus a scoped stylesheet.
 */
import type { DialogHandle, PluginApi } from "@scm-js/plugin-api";
import { compiledText, countLines, describeError, fencedText, gutterText, statusText, type TextError } from "./text";

const STYLE = `
.trigedit { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 10px; }
.trigedit .code-editor { flex: 1; min-height: 0; display: grid; grid-template-columns: 44px 1fr; background: var(--bg-0, #0a0c10); border: 1px solid var(--border, #2c3341); box-shadow: var(--bevel-sunken); border-radius: var(--radius, 3px); overflow: hidden; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 18px; }
.trigedit .code-editor .gutter { padding: 8px 6px; text-align: right; color: var(--text-faint, #5d6675); background: var(--bg-1, #12151b); border-right: 1px solid var(--border, #2c3341); overflow: hidden; white-space: pre; user-select: none; }
.trigedit .code-editor textarea { resize: none; border: none; outline: none; background: transparent; padding: 8px 10px; color: var(--text, #dde2ea); white-space: pre; overflow: auto; tab-size: 4; font: inherit; line-height: inherit; }
.trigedit .code-editor.wrap textarea { white-space: pre-wrap; }
.trigedit .trigedit-status { display: flex; align-items: center; gap: 8px; min-height: 18px; color: var(--text-dim, #99a2b3); font-size: var(--fs-xs, 10.5px); }
.trigedit .trigedit-status.error { color: var(--danger, #ff7a7a); }
`;

interface OpenOptions {
  briefing?: boolean;
}

/** One editor; opening it again brings the open dialog forward rather than a second one. */
class TextTriggerEditor {
  private dialog: DialogHandle | null = null;
  private briefing = false;
  private text = "";
  private error: TextError | null = null;
  private status = "";
  private wrap = false;
  private textarea: HTMLTextAreaElement | null = null;
  private gutter: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private editorEl: HTMLElement | null = null;
  private radios: { triggers: HTMLInputElement; briefing: HTMLInputElement } | null = null;

  private readonly api: PluginApi;

  constructor(api: PluginApi) {
    this.api = api;
  }

  isOpen(): boolean {
    return this.dialog?.isOpen() ?? false;
  }

  open(options: OpenOptions = {}): void {
    if (!this.api.document.isOpen()) {
      this.api.ui.toast({ kind: "info", title: "Open a map first", detail: "The Text Trigger Editor edits the triggers of the open map." });
      return;
    }
    if (this.isOpen()) {
      if (options.briefing !== undefined && options.briefing !== this.briefing) this.switchTo(options.briefing);
      this.textarea?.focus();
      return;
    }
    this.briefing = options.briefing === true;
    this.load("");
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.dialog = this.api.ui.dialog({
      title: "Text Trigger Editor",
      size: "full",
      mount: (body) => this.mount(body),
      buttons: [
        { label: "Compile & Close", primary: true, run: () => this.compile() },
        { label: "Cancel" },
        { label: "Apply", closes: false, run: () => { this.compile(); } },
      ],
      // The slot other plugins add to: the text as the person sees it, and which list it is — read live.
      slot: {
        id: "trigedit.text",
        payload: { get briefing() { return self.briefing; } },
        fields: { text: { get: () => this.text, set: (text) => this.setText(text, { error: null, status: "" }) } },
      },
    });
  }

  close(): void {
    this.dialog?.close();
  }

  /** The map changed under the dialog: re-read it, or close when there is no map any more. */
  documentChanged(): void {
    if (!this.isOpen()) return;
    if (!this.api.document.isOpen()) { this.close(); return; }
    this.load("Reloaded: the map changed.");
  }

  /* ── The text and the map ─────────────────────────────── */

  /** What the map holds, as text: TRIG with every claimed run fenced, or MBRF as it is. */
  private source(): string {
    const { triggers } = this.api;
    if (this.briefing) return triggers.text.print(triggers.briefing(), { briefing: true });
    return fencedText(triggers.list(), triggers.claims(), (slice) => triggers.text.print(slice));
  }

  private load(status: string): void {
    this.setText(this.source(), { error: null, status });
  }

  private setText(text: string, more: { error?: TextError | null; status?: string } = {}): void {
    this.text = text;
    if (more.error !== undefined) this.error = more.error;
    if (more.status !== undefined) this.status = more.status;
    if (this.textarea && this.textarea.value !== text) this.textarea.value = text;
    this.render();
  }

  /** Parse the text and replace the list; the map is untouched when it does not parse. Returns whether it compiled. */
  private compile(): boolean {
    let count = 0;
    try {
      this.api.document.update(this.briefing ? "Compile briefing" : "Compile triggers", (tx) => {
        count = (this.briefing ? tx.briefing : tx.triggers).fromText(this.text, { replace: true });
      });
      this.error = null;
      this.status = compiledText(count, this.briefing);
      this.render();
      return true;
    } catch (err) {
      this.error = describeError(err);
      this.status = "";
      this.render();
      return false;
    }
  }

  /** Parse and print again: the parser's idea of the layout. */
  private format(): void {
    const { text } = this.api.triggers;
    try {
      const parsed = text.parse(this.text, { briefing: this.briefing }).map((t) => t.trigger);
      this.setText(text.print(parsed, { briefing: this.briefing }), { error: null, status: "Formatted." });
    } catch (err) {
      this.error = describeError(err);
      this.status = "";
      this.render();
    }
  }

  /** Switching lists re-reads the map, so compile first. */
  private switchTo(briefing: boolean): void {
    this.briefing = briefing;
    if (this.radios) { this.radios.triggers.checked = !briefing; this.radios.briefing.checked = briefing; }
    this.load("");
  }

  /* ── The dialog ───────────────────────────────────────── */

  private mount(body: HTMLElement): () => void {
    const { widgets: w, el } = this.api.ui;
    const triggers = w.checkbox("Triggers", { radio: true, name: "trigedit-list", value: !this.briefing, title: "TRIG — the map's triggers", onChange: (on) => { if (on) this.switchTo(false); } });
    const briefing = w.checkbox("Briefing", { radio: true, name: "trigedit-list", value: this.briefing, title: "MBRF — the mission briefing, in the same syntax with the briefing actions", onChange: (on) => { if (on) this.switchTo(true); } });
    this.radios = { triggers: triggers.input, briefing: briefing.input };
    const wrap = w.checkbox("Word wrap", { value: this.wrap, onChange: (on) => { this.wrap = on; this.editorEl?.classList.toggle("wrap", on); } });
    const bar = w.row(
      triggers, briefing,
      w.button("Compile", { className: "sm", title: "Parse the text and put the result into the map; the map is untouched when a line does not parse", onClick: () => { this.compile(); } }),
      w.button("Format", { className: "sm", title: "Parse and print the text again in the printer's layout", onClick: () => this.format() }),
      w.button("Reload", { className: "sm", title: "Throw the text away and read the map again", onClick: () => this.load("Reloaded from the map.") }),
      el("span", { className: "grow" }),
      wrap,
    );

    this.gutter = el("div", { className: "gutter" });
    this.textarea = el("textarea", { spellcheck: "false" });
    this.textarea.value = this.text;
    this.textarea.addEventListener("input", () => { this.text = this.textarea?.value ?? ""; this.status = ""; this.render(); });
    // The gutter follows the text as it scrolls.
    this.textarea.addEventListener("scroll", () => { if (this.gutter && this.textarea) this.gutter.scrollTop = this.textarea.scrollTop; });
    this.editorEl = el("div", { className: this.wrap ? "code-editor wrap" : "code-editor" }, this.gutter, this.textarea);
    this.statusEl = el("div", { className: "trigedit-status" });

    body.append(el("style", {}, STYLE), el("div", { className: "trigedit" }, bar, this.editorEl, this.statusEl));
    this.render();
    queueMicrotask(() => this.textarea?.focus());
    return () => {
      this.textarea = null; this.gutter = null; this.statusEl = null; this.editorEl = null; this.radios = null;
      this.dialog = null;
    };
  }

  private render(): void {
    if (!this.gutter || !this.statusEl) return;
    const lines = countLines(this.text);
    this.gutter.textContent = gutterText(lines, this.error?.line ?? null);
    if (this.gutter && this.textarea) this.gutter.scrollTop = this.textarea.scrollTop;
    this.statusEl.classList.toggle("error", this.error !== null);
    this.statusEl.textContent = this.error ? this.error.message : statusText(lines, this.briefing, this.status);
  }
}

export default function activate(api: PluginApi): () => void {
  const editor = new TextTriggerEditor(api);
  const options = (v: unknown): OpenOptions => (typeof v === "object" && v !== null && "briefing" in v ? { briefing: (v as { briefing?: unknown }).briefing === true } : {});

  api.commands.register({ id: "open", title: "Text Trigger Editor", enabled: () => api.document.isOpen(), run: (v) => editor.open(options(v)) });
  api.menu.add("Triggers", { label: "Text Trigger Editor…", shortcut: "Ctrl+Shift+T", after: "Trigger Editor…", enabled: () => api.document.isOpen(), command: "open" });
  api.hotkeys.add("Ctrl+Shift+T", { command: "open" });
  api.events.on("document", () => editor.documentChanged());

  return () => editor.close();
}
