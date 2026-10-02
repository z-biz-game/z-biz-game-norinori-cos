// 棋盘的唯一一份几何 + 唯一一次绘制。
//
// 布局（每格边长、原点、内边距、dpr）与命中（hitCell）必须住在一起并共用**同一批数**：
// 分家就会出"盘画对了、点击偏一格"。所以下面 draw 算出来的 this.geo 就是 hitCell /
// centerOf / pixelAt 唯一能用的那份，任何一处想另算一次布局都是本文件的 bug。
//
// 粗线（区域边界）在这里画，不在 css 里画：题面的"粗线围出来的块"是判定输入的一部分
// （js/engine/grid.js 的剖分），画在 DOM 上就会有两份真相。

import { Board, Palette } from '../theme.js';
import { BLACK, WHITE } from '../engine/solver.js';

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.geo = null;
    this.reg = null;
    this.w = 0;
    this.h = 0;
    this.paper = null;
    this.paperPattern = null;
    this.loadPaper();
  }

  // 纸纹：位图由 assets/gen/make_art.py 生成（近白、摆幅 0..2/255），按 document.baseURI 解析
  // ——Pages 把站点发在 /<仓库名>/ 前缀下，硬编 "/textures/…" 在这一形 404。
  // 加载失败（file:// 直开、资源被策略挡掉）就退回平涂：纹理是材质，不是判定，不该为此抛异常。
  loadPaper() {
    if (typeof Image !== 'function') return;
    const img = new Image();
    img.onload = () => {
      this.paper = img;
      this.paperPattern = this.ctx.createPattern ? this.ctx.createPattern(img, 'repeat') : null;
    };
    img.onerror = () => { this.paper = null; };
    img.src = new URL('textures/paper-256.png', document.baseURI).href;
  }

  setPuzzle(reg, w, h) {
    this.reg = reg;
    this.w = w;
    this.h = h;
  }

  // 容器给多宽就画多大；格数变了要重算（换档位）。
  layout(availW, availH) {
    const { w, h } = this;
    if (!w || !h) return null;
    const pad = Board.pad;
    const byCells = Math.floor((Math.min(availW, availH || availW) - 2 * pad) / Math.max(w, h));
    const cell = Math.max(Board.cellMin, Math.min(Board.cellMax, byCells));
    const size = 2 * pad + cell * Math.max(w, h);
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.geo = {
      cell, pad, dpr, size,
      offX: pad + (cell * w < cell * h ? Math.floor((cell * Math.max(w, h) - cell * w) / 2) : 0),
      offY: pad + (cell * h < cell * w ? Math.floor((cell * Math.max(w, h) - cell * h) / 2) : 0),
    };
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    return this.geo;
  }

  cellRect(i) {
    const { cell, offX, offY } = this.geo;
    const r = Math.floor(i / this.w);
    const c = i % this.w;
    return { x: offX + c * cell, y: offY + r * cell, s: cell };
  }

  // 画布**客户坐标**下的格中心：指针闸用它去派发真实 click，
  // 所以它必须与 draw 刚刚用过的那批数是同一份。
  centerOf(i) {
    const box = this.canvas.getBoundingClientRect();
    const rect = this.cellRect(i);
    return {
      x: box.left + rect.x + rect.s / 2,
      y: box.top + rect.y + rect.s / 2,
    };
  }

  pixelAt(clientX, clientY) {
    const box = this.canvas.getBoundingClientRect();
    const g = this.geo;
    const x = Math.round((clientX - box.left) * g.dpr);
    const y = Math.round((clientY - box.top) * g.dpr);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return null;
    const d = this.ctx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  hitCell(clientX, clientY) {
    if (!this.geo) return null;
    const box = this.canvas.getBoundingClientRect();
    const g = this.geo;
    const x = clientX - box.left - g.offX;
    const y = clientY - box.top - g.offY;
    if (x < 0 || y < 0) return null;
    const c = Math.floor(x / g.cell);
    const r = Math.floor(y / g.cell);
    if (c < 0 || c >= this.w || r < 0 || r >= this.h) return null;
    return r * this.w + c;
  }

  draw(state, view = {}) {
    const g = this.geo;
    if (!g) return;
    const { ctx } = this;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.size, g.size);
    ctx.fillStyle = Palette.boardBg;
    ctx.fillRect(0, 0, g.size, g.size);

    for (let i = 0; i < this.w * this.h; i += 1) {
      const { x, y, s } = this.cellRect(i);
      const r = Math.floor(i / this.w);
      const c = i % this.w;
      ctx.fillStyle = (r + c) % 2 === 0 ? Palette.cellBg : Palette.cellBgAlt;
      ctx.fillRect(x, y, s, s);
    }

    // 细线：同区域相邻格之间。
    ctx.strokeStyle = Palette.gridLine;
    ctx.lineWidth = Board.gridWidth;
    ctx.beginPath();
    for (let i = 0; i < this.w * this.h; i += 1) {
      const a = this.cellRect(i);
      const right = i + 1 < this.w * this.h && (i + 1) % this.w !== 0 && this.reg[i + 1] === this.reg[i];
      const down = i + this.w < this.w * this.h && this.reg[i + this.w] === this.reg[i];
      if (right) { ctx.moveTo(a.x + a.s, a.y); ctx.lineTo(a.x + a.s, a.y + a.s); }
      if (down) { ctx.moveTo(a.x, a.y + a.s); ctx.lineTo(a.x + a.s, a.y + a.s); }
    }
    ctx.stroke();

    // 粗线：不同区域之间 + 每块区域的外沿。题面给的"粗线"就是它，画在这里而不是 DOM 上，
    // 是为了让"看到的边界"与"判定的剖分"只有一个来源。
    ctx.strokeStyle = Palette.regionLine;
    ctx.lineCap = 'square';
    for (let i = 0; i < this.w * this.h; i += 1) {
      const a = this.cellRect(i);
      const edges = [
        [i - this.w < 0 || this.reg[i - this.w] !== this.reg[i], a.x, a.y, a.x + a.s, a.y],
        [i + this.w >= this.w * this.h || this.reg[i + this.w] !== this.reg[i], a.x, a.y + a.s, a.x + a.s, a.y + a.s],
        [(i % this.w === 0) || this.reg[i - 1] !== this.reg[i], a.x, a.y, a.x, a.y + a.s],
        [(i % this.w === this.w - 1) || this.reg[i + 1] !== this.reg[i], a.x + a.s, a.y, a.x + a.s, a.y + a.s],
      ];
      const bw = Math.max(2, a.s * Board.regionWidth);
      ctx.lineWidth = bw;
      ctx.beginPath();
      for (const [on, x0, y0, x1, y1] of edges) {
        if (!on) continue;
        // 线必须钉在共边正中：加半个像素的"对齐偏移"会让相邻两格各画一根，粗线糊成一条带。
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    }

    // 纸纹叠层：multiply 一遍近白的噪声（摆幅 0..2/255 ⇒ 亮度最多降 0.8%）。
    // 画在"底 + 棋格 + 粗细线"之后、黑格与白点之前：那两样是判定色，一个字节都不许被改过，
    // 而底纹的 0.8% 落在闸的取样容差（≤12）里，且离"内边距 dist ≤8"那条也还有余量。
    if (this.paperPattern) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = this.paperPattern;
      ctx.fillRect(0, 0, g.size, g.size);
      ctx.restore();
    }

    for (let i = 0; i < this.w * this.h; i += 1) {
      const { x, y, s } = this.cellRect(i);
      const v = state[i];
      if (v === BLACK) {
        const inset = s * Board.blackInset;
        ctx.fillStyle = Palette.black;
        ctx.fillRect(x + inset, y + inset, s - 2 * inset, s - 2 * inset);
      } else if (v === WHITE) {
        ctx.fillStyle = Palette.dot;
        ctx.beginPath();
        ctx.arc(x + s / 2, y + s / 2, s * Board.dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 提示环的呼吸：pulse∈[0,1) 是仿真时钟的相位，±18% 半径。pulse 恒 0 就是静图
    // ——reduceMotion 下 main.js 把它钉在 0，这里不需要再判一次。
    const pulse = 1 + 0.18 * Math.sin((view.pulse || 0) * Math.PI * 2);
    const ring = (i, color, widthRatio, breathe = 1) => {
      if (i == null || !state || i >= state.length) return;
      const { x, y, s } = this.cellRect(i);
      const wpx = Math.max(2, s * widthRatio);
      const shrink = (breathe - 1) * s * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = wpx;
      ctx.strokeRect(x + wpx / 2 - shrink, y + wpx / 2 - shrink, s - wpx + 2 * shrink, s - wpx + 2 * shrink);
    };
    ring(view.selected, Palette.selected, 0.07);
    for (const i of view.hints || []) ring(i, Palette.hint, Board.hintRing, pulse);
    for (const i of view.wrong || []) ring(i, Palette.wrong, Board.hintRing);

    // 落子涟漪：每颗都裁在**它所在那格的内 70% 盒子**里。这不是好看，是不越界——
    // 闸在共边中点与粗线上取样判色，粒子跑出格子就会把 accent 盖到判据上。
    const parts = view.particles || [];
    if (parts.length) {
      ctx.save();
      ctx.beginPath();
      for (const p of parts) {
        const { x, y, s } = this.cellRect(p.cell == null ? 0 : p.cell);
        ctx.rect(x + s * 0.15, y + s * 0.15, s * 0.7, s * 0.7);
      }
      ctx.clip();
      for (const p of parts) {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life)) * 0.55;
        ctx.fillStyle = p.kind === 2 ? Palette.wrong : p.kind === 1 ? Palette.dot : Palette.accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1, this.geo.cell * 0.05 * (0.6 + p.life)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }
}

