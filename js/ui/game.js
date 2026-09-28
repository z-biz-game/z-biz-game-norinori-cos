// 局面（不含任何 DOM，也不含任何像素）：落子、撤销、编码、判定。
//
// 判定一律交回引擎：本文件不许自己数"这颗黑格有没有同伴"。
// 三条出口各自的名字与 js/engine/ 里的那一个完全一致——
// 浏览器闸判的就是"页面上的读数与独立 import 进来的引擎读数是不是同一句话"。

import { UNKNOWN, BLACK, WHITE, stateToBlack, deriveFacts, deriveOne } from '../engine/solver.js';
import { checkSolution } from '../engine/grid.js';

export const MARK = { [UNKNOWN]: '.', [BLACK]: '#', [WHITE]: 'o' };
export const UNMARK = { '.': UNKNOWN, '#': BLACK, o: WHITE };

export class Game {
  constructor(reg, w, h) {
    this.reg = reg;
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.state = new Uint8Array(this.n);
    this.undoStack = [];
    this.moves = 0;
    this.hints = 0;
  }

  setPuzzle(reg, w, h) {
    this.reg = reg;
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.state = new Uint8Array(this.n);
    this.undoStack = [];
    this.moves = 0;
    this.hints = 0;
  }

  cell(i) {
    return i >= 0 && i < this.n ? this.state[i] : UNKNOWN;
  }

  // 同一格点同一支笔 = 擦掉；这就是"改主意"，不需要单独的橡皮按钮也能擦。
  put(i, value) {
    if (i < 0 || i >= this.n) return false;
    const from = this.state[i];
    const to = from === value ? UNKNOWN : value;
    if (from === to) return false;
    this.undoStack.push({ i, from, to });
    this.state[i] = to;
    this.moves += 1;
    return true;
  }

  // 擦掉一格：走与 put 同一条撤销记录，所以"擦"也能被撤销。
  erase(i) {
    if (i < 0 || i >= this.n || this.state[i] === UNKNOWN) return false;
    const from = this.state[i];
    this.undoStack.push({ i, from, to: UNKNOWN });
    this.state[i] = UNKNOWN;
    this.moves += 1;
    return true;
  }

  undo() {
    const last = this.undoStack.pop();
    if (!last) return null;
    this.state[last.i] = last.from;
    return last;
  }

  clearAll() {
    for (let i = 0; i < this.n; i += 1) this.state[i] = UNKNOWN;
    this.undoStack = [];
  }

  counts() {
    let black = 0;
    let white = 0;
    for (let i = 0; i < this.n; i += 1) {
      if (this.state[i] === BLACK) black += 1;
      else if (this.state[i] === WHITE) white += 1;
    }
    return { black, white, unknown: this.n - black - white };
  }

  encode() {
    let s = '';
    for (let i = 0; i < this.n; i += 1) s += MARK[this.state[i]];
    return s;
  }

  decode(s) {
    if (typeof s !== 'string' || s.length !== this.n) return false;
    for (let i = 0; i < this.n; i += 1) {
      const v = UNMARK[s[i]];
      if (v === undefined) return false;
      this.state[i] = v;
    }
    this.undoStack = [];
    return true;
  }

  // 页面上唯一的判定入口：一次 deriveFacts + 一次（填满时的）checkSolution。
  // conflict 与 solved 分开报，因为"这一步推不下去了"和"还没推完"是两句话。
  // 空盘（还没开局，n=0）必须明确读作"没推完"：unknown===0 在 n=0 时天生成立，
  // 不加这一句守卫，开机第一帧就会报"这盘推完了"，并把胜利卡片盖在还没生成的盘上。
  status() {
    if (!this.n) {
      return { counts: { black: 0, white: 0, unknown: 0 }, filled: false, conflict: null, provable: 0, solved: false, violation: null };
    }
    const { facts, conflict } = deriveFacts(this.reg, this.w, this.h, this.state);
    const c = this.counts();
    const filled = c.unknown === 0;
    const verdict = filled && !conflict ? checkSolution(stateToBlack(this.state), this.reg, this.w, this.h) : null;
    return {
      counts: c,
      filled,
      conflict,
      provable: facts.length,
      solved: !!(verdict && verdict.ok),
      violation: verdict && !verdict.ok ? verdict : null,
    };
  }

  hint() {
    const one = deriveOne(this.reg, this.w, this.h, this.state);
    if (one.conflict) return { conflict: one.conflict };
    if (!one.fact) return { fact: null };
    this.hints += 1;
    return one;
  }
}
