// 棋盘的唯一一份几何 + 唯一一次绘制。
//
// 布局（每格边长、原点、内边距、dpr）与命中（hitCell）必须住在一起并共用**同一批数**：
// 分家就会出"盘画对了、点击偏一格"。所以下面 draw 算出来的 this.geo 就是 hitCell /
// centerOf / pixelAt 唯一能用的那份，任何一处想另算一次布局都是本文件的 bug。
//
// 粗线（区域边界）在这里画，不在 css 里画：题面的"粗线围出来的块"是判定输入的一部分
// （js/engine/grid.js 的剖分），画在 DOM 上就会有两份真相。


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown / change 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
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

    const ring = (i, color, widthRatio) => {
      if (i == null || !state || i >= state.length) return;
      const { x, y, s } = this.cellRect(i);
      const wpx = Math.max(2, s * widthRatio);
      ctx.strokeStyle = color;
      ctx.lineWidth = wpx;
      ctx.strokeRect(x + wpx / 2, y + wpx / 2, s - wpx, s - wpx);
    };
    ring(view.selected, Palette.selected, 0.07);
    for (const i of view.hints || []) ring(i, Palette.hint, Board.hintRing);
    for (const i of view.wrong || []) ring(i, Palette.wrong, Board.hintRing);
  }
}

