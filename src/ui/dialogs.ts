import { icon } from "./icons";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; html?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, html, ...rest } = props;
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  Object.assign(el, rest);
  el.append(...children);
  return el;
}

export function toast(message: string, kind: "info" | "error" | "success" = "info", ms = 3500) {
  let host = document.querySelector<HTMLElement>(".toasts");
  if (!host) {
    host = h("div", { class: "toasts" });
    host.setAttribute("role", "status");
    document.body.append(host);
  }
  const el = h("div", { class: `toast ${kind}`, textContent: message });
  host.append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 250);
  }, ms);
}

export interface ModalAction {
  label: string;
  primary?: boolean;
  onClick: () => void | boolean | Promise<void | boolean>; // return false to keep the modal open
}

export function modal(title: string, body: HTMLElement, actions: ModalAction[], onClose?: () => void) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const buttons = actions.map((a) => {
    const btn = h("button", { class: a.primary ? "btn primary" : "btn", textContent: a.label, type: "button" });
    btn.addEventListener("click", async () => {
      const keep = (await a.onClick()) === false;
      if (!keep) close();
    });
    return btn;
  });
  const closeBtn = h("button", { class: "icon-btn", html: icon("close"), title: "Close", type: "button" });
  closeBtn.addEventListener("click", close);
  const dialog = h("div", { class: "modal" }, [
    h("header", {}, [h("h2", { textContent: title }), closeBtn]),
    h("div", { class: "modal-body" }, [body]),
    h("footer", {}, buttons),
  ]);
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", title);
  const backdrop = h("div", { class: "backdrop" }, [dialog]);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
  (buttons.find((_, i) => actions[i].primary) ?? closeBtn).focus();
  return close;
}

/** Full-window progress indicator; returns an updater and a close function. */
export function progress(label: string) {
  const bar = h("div", { class: "progress-bar" }, [h("div", { class: "progress-fill" })]);
  const text = h("p", { textContent: label });
  const backdrop = h("div", { class: "backdrop busy" }, [h("div", { class: "modal small" }, [text, bar])]);
  document.body.append(backdrop);
  return {
    update(done: number, total: number, detail?: string) {
      (bar.firstChild as HTMLElement).style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      text.textContent = detail ?? `${label} (${Math.min(done + 1, total)} of ${total})`;
    },
    close: () => backdrop.remove(),
  };
}

/** Signature pad: resolves with a trimmed transparent PNG data URL, or null. */
export function signaturePad(): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const canvas = h("canvas", { class: "sig-canvas", width: 1040, height: 360 });
    const ctx = canvas.getContext("2d")!;
    ctx.lineWidth = 5;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = "#1b2a4a";
    let drawing = false;
    let empty = true;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
    };
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      empty = false;
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 0.1, y);
      ctx.stroke();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    });
    canvas.addEventListener("pointerup", () => (drawing = false));
    const clear = h("button", { class: "link-btn", textContent: "Clear", type: "button" });
    clear.addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      empty = true;
    });
    const body = h("div", { class: "sig-wrap" }, [
      h("p", { class: "muted", textContent: "Draw your signature with the mouse, pen or finger." }),
      canvas,
      clear,
    ]);
    modal(
      "Add signature",
      body,
      [
        { label: "Cancel", onClick: () => {} },
        {
          label: "Place signature",
          primary: true,
          onClick: () => {
            if (empty) return false;
            result = trimCanvas(canvas);
          },
        },
      ],
      () => resolve(result),
    );
  });
}

function trimCanvas(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const pad = 6;
  const w = Math.max(1, maxX - minX + pad * 2);
  const hgt = Math.max(1, maxY - minY + pad * 2);
  const out = h("canvas", { width: w, height: hgt });
  out.getContext("2d")!.drawImage(canvas, minX - pad, minY - pad, w, hgt, 0, 0, w, hgt);
  return out.toDataURL("image/png");
}
