import { renderPage } from "../pdf/engine";
import { state } from "../state";
import { h } from "./dialogs";
import type { Viewer } from "./viewer";

const THUMB_WIDTH = 116;

export class Thumbs {
  private observer: IntersectionObserver;
  private version = 0;

  constructor(private list: HTMLElement, private viewer: Viewer) {
    this.observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && void this.renderThumb(e.target as HTMLElement)),
      { root: list, rootMargin: "300px 0px" },
    );
    state.on((change) => {
      if (change === "document") this.rebuild();
      if (change === "meta" || change === "document") this.highlight();
    });
  }

  private rebuild() {
    this.version++;
    this.observer.disconnect();
    this.list.replaceChildren(
      ...state.pages.map((info, i) => {
        const ratio = info.height / info.width;
        const frame = h("div", { class: "thumb-frame" });
        frame.style.width = `${THUMB_WIDTH}px`;
        frame.style.height = `${THUMB_WIDTH * ratio}px`;
        const btn = h("button", { class: "thumb", type: "button", title: `Page ${i + 1}` }, [frame, h("span", { textContent: String(i + 1) })]);
        btn.dataset.index = String(i);
        btn.addEventListener("click", () => {
          state.setCurrentPage(i);
          this.viewer.scrollToPage(i);
        });
        this.observer.observe(btn);
        return btn;
      }),
    );
  }

  private async renderThumb(btn: HTMLElement) {
    if (btn.dataset.rendered || !state.pdf) return;
    btn.dataset.rendered = "1";
    const version = this.version;
    const index = Number(btn.dataset.index);
    const page = await state.pdf.getPage(index + 1);
    const canvas = h("canvas");
    await renderPage(page, canvas, (THUMB_WIDTH / state.pages[index].width) * (window.devicePixelRatio || 1));
    if (version === this.version) btn.querySelector(".thumb-frame")?.replaceChildren(canvas);
  }

  private highlight() {
    for (const el of this.list.children as HTMLCollectionOf<HTMLElement>) {
      const active = Number(el.dataset.index) === state.currentPage;
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
    const active = this.list.querySelector<HTMLElement>(".thumb.active");
    if (active) {
      const top = active.offsetTop - this.list.offsetTop;
      if (top < this.list.scrollTop || top + active.offsetHeight > this.list.scrollTop + this.list.clientHeight) {
        this.list.scrollTo({ top: top - 12 });
      }
    }
  }
}
