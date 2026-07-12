import { CanvasTexture, SRGBColorSpace, type Texture } from "three";

/**
 * Card face textures. Three flavors, all cached by content:
 *   - imageCardTexture: a resolved Scryfall image (+ counter badge overlay)
 *   - placeholderTexture: "numbers and text" face shown until the image loads
 *   - backTexture: a uniform card back for hidden cards
 */
const cache = new Map<string, Texture>();
const W = 256;
const H = 356;

function counterString(counters: Record<string, number>): string {
  return Object.entries(counters)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => {
      // +1/+1 and -1/-1 counters read as the aggregate P/T change (+n/+n, -n/-n).
      if (k === "+1/+1") return `+${v}/+${v}`;
      if (k === "-1/-1") return `-${v}/-${v}`;
      return `${v} ${k}`;
    })
    .join("  ");
}

function finalize(canvas: HTMLCanvasElement, key: string): Texture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

export function imageCardTexture(img: HTMLImageElement, counters: Record<string, number>): Texture {
  const counterStr = counterString(counters);
  const key = `img|${img.src}|${counterStr}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const w = img.naturalWidth || 488;
  const h = img.naturalHeight || 680;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  if (counterStr) drawBadge(ctx, counterStr, w, h);
  return finalize(canvas, key);
}

export function placeholderTexture(label: string, counters: Record<string, number>): Texture {
  const counterStr = counterString(counters);
  const key = `ph|${label}|${counterStr}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  drawFace(ctx, label || "card");
  if (counterStr) drawBadge(ctx, counterStr, W, H);
  return finalize(canvas, key);
}

export function backTexture(): Texture {
  const key = "#back";
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  drawBack(canvas.getContext("2d")!);
  return finalize(canvas, key);
}

// --- drawing helpers --------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFace(ctx: CanvasRenderingContext2D, label: string) {
  ctx.fillStyle = "#e9e2cf";
  roundRect(ctx, 6, 6, W - 12, H - 12, 22);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#2a2a2a";
  ctx.stroke();

  ctx.fillStyle = "#d8cfb4";
  roundRect(ctx, 18, 18, W - 36, 56, 12);
  ctx.fill();

  ctx.fillStyle = "#161616";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 26px system-ui, sans-serif";
  wrapText(ctx, label, W / 2, 46, W - 56, 28, 2);

  ctx.fillStyle = "#c4bb9e";
  roundRect(ctx, 18, 86, W - 36, 180, 10);
  ctx.fill();
  ctx.fillStyle = "#8a8268";
  ctx.font = "italic 16px system-ui, sans-serif";
  ctx.fillText("loading…", W / 2, 176);
}

function drawBack(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#1a2740";
  roundRect(ctx, 6, 6, W - 12, H - 12, 22);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#0c1326";
  ctx.stroke();
  ctx.fillStyle = "#36507f";
  roundRect(ctx, 30, 30, W - 60, H - 60, 14);
  ctx.fill();
  ctx.fillStyle = "#9fb4d8";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 34px serif";
  ctx.fillText("MTG", W / 2, H / 2);
}

function drawBadge(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  const pad = Math.round(w * 0.04);
  const fontSize = Math.round(w * 0.085);
  ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  const bw = tw + pad * 2;
  const bh = fontSize + pad;
  const x = w - bw - pad;
  const y = h - bh - pad;
  ctx.fillStyle = "rgba(20, 90, 40, 0.92)";
  roundRect(ctx, x, y, bw, bh, bh / 3);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + bw / 2, y + bh / 2);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  const startY = cy - ((shown.length - 1) * lineHeight) / 2;
  shown.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight, maxWidth));
}
