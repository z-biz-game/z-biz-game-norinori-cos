// 页面装配 + 浏览器闸的那张脸（window.norinori）。
//
// 四条纪律：
//  1) 只有一个判定入口：页面上的"对不对"来自 js/ui/game.js 的 status()，而它调的是引擎。
//     main.js 里不许出现第二套"数黑格 / 看骨牌"的代码——出了两套，浏览器看到的和 CI 看到的就分家。
//  2) 只有一份几何：画布尺寸、点击命中、格中心坐标全部问 js/render/board.js 的同一个 view 对象。
//  3) 页面上没有"闸专用"的输入通道：期望值由 node 经 window.__expectRaw 注进来（见 tools/scenarios.js），
//     页面只拿它跟自己比，从不照它摆自己的状态。URL 里只认 ?tier=&seed= ——
//     同一个文档里换个 #fragment 不算导航，用它当交接通道等于让闸自己对自己。
//  4) 墙钟只当读数，绝不当输入：elapsedMs 只进面板与存档，种子里不许有 Date/performance。

import { applyThemeVars } from './theme.js';
import { BoardView } from './render/board.js';
import { Game } from './ui/game.js';
import { BLACK, WHITE, UNKNOWN, RULES, stateToBlack } from './engine/solver.js';
import { validatePartition, checkSolution } from './engine/grid.js';
import { TIERS, tierByKey, generate } from './engine/generate.js';
import { derive } from './engine/rng.js';
import { countByRegion } from './engine/counter.js';
import * as store from './store.js';

const DEFAULT_SEED = 20260929; // 不是按日期算的：换一局走 derive(seed,'next')，链子决定论、能复现
const DEFAULT_TIER = 'easy';
const WORKER_SRC = 'js/gen-worker.js';

const el = (id) => document.getElementById(id);
const dom = {
  canvas: el('board'),
  wrap: document.querySelector('.board-wrap'),
  veil: el('win-veil'),
  winWhy: el('win-why'),
  winNext: el('win-next'),
  tier: el('tier'),
  penBlack: el('pen-black'),
  penWhite: el('pen-white'),
  newGame: el('new-game'),
  hint: el('hint'),
  undo: el('undo'),
  check: el('check'),
  clear: el('clear'),
  status: el('status'),
  progress: el('progress'),
  seed: el('seed'),
  attemptN: el('attempt-n'),
  totals: el('totals'),
  msg: el('msg'),
};

const view = new BoardView(dom.canvas);
const game = new Game(new Uint8Array(0), 0, 0);

const S = {
  tierKey: DEFAULT_TIER,
  seed: DEFAULT_SEED,
  attemptNo: 0,
  pen: BLACK,
  selected: null,
  hintCells: [],
  wrong: [],
  generating: false,
  progressAttempts: 0,
  msg: '',
  metrics: null,
  startedAt: performance.now(),
  baseElapsedMs: 0,
  totals: store.emptyTotals(),
  pinned: false,
  restored: false,
  bootedFrom: '',
};

let worker = null;
let reqSeq = 0;

const regStr = (reg = game.reg) => Array.from(reg).join(',');
const seedText = () => `0x${(S.seed >>> 0).toString(16)}`;
const elapsedMs = () => Math.round(S.baseElapsedMs + (performance.now() - S.startedAt));

function urlState() {
  const q = new URLSearchParams(location.search);
  const rawSeed = q.get('seed');
  let seed = null;
  if (rawSeed !== null && rawSeed !== '') {
    const n = /^0x[0-9a-f]+$/i.test(rawSeed) ? parseInt(rawSeed, 16) : Number(rawSeed);
    if (Number.isFinite(n)) seed = n >>> 0;
  }
  const tierKey = q.get('tier');
  return { seed, tierKey: tierKey && tierByKey(tierKey) ? tierKey : null };
}

// ── 出题：worker 那条链 ────────────────────────────────────────────────
// 相对 document.baseURI 解析：Pages 把站点发在 /<repo>/ 前缀下，硬编 "/" 在这一形全部 404。
const workerUrl = () => new URL(WORKER_SRC, document.baseURI).href;

// 换一局 / 换档位 = 丢弃上一条链。链在 worker 里是同步死循环，唯一的取消手段就是 terminate 换人。
function requestNew() {
  if (worker) worker.terminate();
  worker = new Worker(workerUrl(), { type: 'module' });
  const reqId = ++reqSeq;
  worker.onmessage = (e) => {
    const d = e.data || {};
    if (d.reqId !== reqId) return; // 上一条被 terminate 的链的尾巴消息
    if (d.ev === 'progress') {
      S.progressAttempts = d.attempts;
      setMsg(`已检查 ${d.attempts} 张候选盘（这一张卡在「${d.reason}」）`);
      render();
      return;
    }
    worker.terminate();
    worker = null;
    if (d.ev === 'ok') adopt(d);
    else if (d.ev === 'empty') {
      S.generating = false;
      const why = Object.entries(d.reasons || {}).map(([k, v]) => `${k}:${v}`).join(' ');
      setMsg(`这条种子链的 ${d.attempts} 次尝试都没出货（${why}）——换一局再试`);
      render();
    } else if (d.ev === 'error') {
      S.generating = false;
      setMsg(`出题 worker 说：档位「${d.tierKey}」不在表里`);
      render();
    }
  };
  worker.onerror = (e) => {
    worker.terminate();
    worker = null;
    S.generating = false;
    setMsg(`出题 worker 起不来：${e.message || '加载失败'}`);
    render();
  };
  S.generating = true;
  S.progressAttempts = 0;
  setMsg('正在出题…');
  worker.postMessage({ cmd: 'generate', reqId, tierKey: S.tierKey, seed: S.seed });
  render();
}

function newGame(tierKey = S.tierKey, seed = S.seed, advance = false) {
  S.tierKey = tierKey;
  S.seed = (advance ? derive(seed, 'next') : seed) >>> 0;
  S.attemptNo = 0;
  S.metrics = null;
  S.baseElapsedMs = 0;
  S.startedAt = performance.now();
  S.selected = null;
  S.hintCells = [];
  S.wrong = [];
  S.restored = false;
  dom.veil.hidden = true;
  dom.tier.value = S.tierKey;
  requestNew();
}

// 出货了：这一局从这里才算存在。
function adopt(d) {
  const reg = Uint8Array.from(d.reg);
  const v = validatePartition(reg, d.w, d.h);
  if (!v.ok) {
    S.generating = false;
    setMsg(`出货盘的剖分不自洽（${v.why}）——这是引擎的 bug，页面没有力气自救`);
    render();
    return;
  }
  S.generating = false;
  S.attemptNo = d.attemptNo;
  S.metrics = d.metrics;
  game.setPuzzle(reg, d.w, d.h);
  view.setPuzzle(reg, d.w, d.h);
  store.addTotals({ games: 1 });
  S.totals = store.load().totals;
  layout();
  persist();
  render();
  dom.canvas.focus();
  signalBoard();
}

function persist() {
  if (!game.n) return;
  store.saveResume({
    seed: S.seed,
    tierKey: S.tierKey,
    attemptNo: S.attemptNo,
    w: game.w,
    h: game.h,
    regStr: regStr(),
    marks: game.encode(),
    moves: game.moves,
    hints: game.hints,
    elapsedMs: elapsedMs(),
    at: Date.now(),
  });
}

// 撤销栈不住在存档里：恢复的是"这个局面"，不是"到达它的走法"。
// 所以续局之后按撤销会被告知"没有可撤的落子"——这是明说的边界，不是漏掉的特性。
function restore(resume) {
  const reg = Uint8Array.from(resume.regStr.split(',').map(Number));
  const v = validatePartition(reg, resume.w, resume.h);
  if (!v.ok) {
    setMsg(`存档里那张盘的剖分不自洽（${v.why}），改从默认种子开一局`);
    return false;
  }
  S.tierKey = resume.tierKey;
  S.seed = resume.seed >>> 0;
  S.attemptNo = resume.attemptNo;
  S.baseElapsedMs = resume.elapsedMs;
  S.startedAt = performance.now();
  S.totals = store.load().totals;
  S.restored = true;
  game.setPuzzle(reg, resume.w, resume.h);
  view.setPuzzle(reg, resume.w, resume.h);
  game.decode(resume.marks);
  game.moves = resume.moves;
  game.hints = resume.hints;
  layout();
  render();
  setMsg(`从存档续局（种子 ${seedText()}，已落 ${game.moves} 子）`);
  signalBoard();
  return true;
}

// ── 绘制与读数 ────────────────────────────────────────────────────────
// 布局问的是 .board-wrap 那侧由 CSS 定死的宽度，不是画布自己的宽度：
// 问画布就变成"画多大就量多大"的自反馈循环，窗口一变就会一路涨到卡死。
function layout() {
  if (!game.n) return;
  const availW = Math.max(240, dom.wrap.clientWidth || 340);
  const availH = Math.max(240, window.innerHeight - 150);
  view.layout(availW, Math.min(availW, availH));
}

function setMsg(text) {
  S.msg = text;
}

function say(text, cls) {
  dom.status.textContent = text;
  dom.status.className = `read${cls ? ` ${cls}` : ''}`;
}

function render() {
  if (view.geo) view.draw(game.state, { selected: S.selected, hints: S.hintCells, wrong: S.wrong });
  const st = game.status();
  const partition = game.n ? validatePartition(game.reg, game.w, game.h) : { ok: false, regionCount: 0 };
  const regionCount = partition.regionCount || 0;
  const wantBlack = 2 * regionCount;

  dom.seed.textContent = `${seedText()}｜档位 ${S.tierKey}`;
  dom.attemptN.textContent = String(S.generating ? S.progressAttempts : S.attemptNo + 1);
  dom.progress.textContent = S.generating || !game.n
    ? ''
    : `黑 ${st.counts.black}／白 ${st.counts.white}／未定 ${st.counts.unknown}｜这盘 ${regionCount} 块区域，黑格该有 ${wantBlack} 颗`;

  if (S.generating) {
    say('正在出题…');
  } else if (!game.n) {
    say('还没开局。');
  } else if (st.conflict) {
    say(`推不下去了：第 ${st.conflict.cell} 格被同时判成黑与白`, 'bad');
    S.wrong = [st.conflict.cell];
  } else if (st.solved) {
    say('两条规则都过了：这盘推完了', 'good');
    showVeil(st, regionCount);
  } else if (st.violation) {
    say(`落满了，但 ${st.violation.rule} 没过`, 'bad');
  } else {
    say(`本轮可证的有 ${st.provable} 条｜还差 ${st.counts.unknown} 格`);
  }

  dom.totals.textContent = `累计：解出 ${S.totals.solved} 局／玩了 ${S.totals.games} 局｜落子 ${S.totals.moves}｜提示 ${S.totals.hints}`;
  dom.msg.textContent = S.msg;
  dom.newGame.disabled = S.generating;
  dom.hint.disabled = S.generating || !game.n;
  dom.undo.disabled = S.generating || !game.undoStack.length;
  dom.check.disabled = S.generating || !game.n;
  dom.clear.disabled = S.generating || !game.n;
  if (!st.solved) dom.veil.hidden = true;
}

function showVeil(st, regionCount) {
  const m = S.metrics || {};
  dom.winWhy.textContent = `${regionCount} 块区域、${st.counts.black} 颗黑格，链条 ${m.chain ?? '—'} 轮、${m.steps ?? '—'} 步。`
    + `这一局用时 ${Math.round(elapsedMs() / 1000)} 秒，提示 ${game.hints} 次。`;
  dom.veil.hidden = false;
}

// ── 交互 ──────────────────────────────────────────────────────────────
function putAt(i) {
  if (S.generating || i == null || !game.n) return;
  if (!game.put(i, S.pen)) return;
  afterMove(`第 ${i} 格`);
}

function afterMove(what) {
  S.hintCells = [];
  S.wrong = [];
  const st = game.status();
  store.addTotals({ moves: 1 });
  if (st.solved) store.addTotals({ solved: 1 });
  S.totals = store.load().totals;
  setMsg(st.solved ? '推完了' : what);
  persist();
  render();
}

function setPen(p) {
  S.pen = p;
  dom.penBlack.classList.toggle('on', p === BLACK);
  dom.penWhite.classList.toggle('on', p === WHITE);
  dom.penBlack.setAttribute('aria-pressed', String(p === BLACK));
  dom.penWhite.setAttribute('aria-pressed', String(p === WHITE));
}

function doHint() {
  if (S.generating || !game.n) return;
  const one = game.hint();
  if (one.conflict) {
    setMsg(`提示说：这一局已经矛盾了（第 ${one.conflict.cell} 格）`);
  } else if (!one.fact) {
    setMsg('提示说：这一步五条局部规则都推不出必然结论——该换个角度了');
  } else {
    const f = one.fact;
    S.hintCells = [f.cell];
    S.selected = f.cell;
    store.addTotals({ hints: 1 });
    S.totals = store.load().totals;
    setMsg(`${f.rule}：${RULES[f.rule]}（第 ${f.cell} 格${f.value === BLACK ? '涂黑' : '点白'}）`);
    persist();
  }
  render();
  dom.canvas.focus();
}

function doCheck() {
  if (S.generating || !game.n) return;
  const st = game.status();
  if (st.conflict) {
    S.wrong = [st.conflict.cell];
    setMsg(`矛盾在第 ${st.conflict.cell} 格：${st.conflict.why}`);
  } else if (st.violation) {
    if (st.violation.rule === 'R1') {
      S.wrong = st.violation.cells;
      setMsg(`骨牌不成对：${st.violation.cells.length} 颗黑格的同伴数不是 1（第 ${st.violation.cells.join('、')} 格）`);
    } else {
      S.wrong = [];
      setMsg(`区域数不对：${st.violation.regions.length} 块区域的黑格数不是 2（区域 ${st.violation.regions.join('、')}）`);
    }
  } else if (!st.filled) {
    S.wrong = [];
    setMsg(`还没落满：未定 ${st.counts.unknown} 格，落下的那些都合法`);
  } else {
    S.wrong = [];
    setMsg('两条规则都过了');
  }
  render();
}

function doUndo() {
  const last = game.undo();
  if (!last) {
    setMsg('没有可撤的落子');
  } else {
    S.selected = last.i;
    S.hintCells = [];
    S.wrong = [];
    setMsg(`撤销第 ${last.i} 格`);
  }
  persist();
  render();
  dom.canvas.focus();
}

function doClear() {
  game.clearAll();
  S.hintCells = [];
  S.wrong = [];
  setMsg('棋盘清空');
  persist();
  render();
}

function moveSelected(dr, dc) {
  if (!game.n) return;
  const from = S.selected == null ? 0 : S.selected;
  const r = Math.max(0, Math.min(game.h - 1, Math.floor(from / game.w) + dr));
  const c = Math.max(0, Math.min(game.w - 1, (from % game.w) + dc));
  S.selected = r * game.w + c;
  render();
}

function eraseSelected() {
  if (S.selected == null || !game.erase(S.selected)) return;
  store.addTotals({ moves: 1 });
  S.totals = store.load().totals;
  setMsg(`擦掉第 ${S.selected} 格`);
  persist();
  render();
}

// ── 事件接线 ──────────────────────────────────────────────────────────
dom.canvas.addEventListener('pointerdown', (e) => {
  const i = view.hitCell(e.clientX, e.clientY);
  if (i == null) return; // 粗线外沿与内边距：命中不了就不算落子
  e.preventDefault();
  S.selected = i;
  putAt(i);
});
dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

dom.canvas.addEventListener('keydown', (e) => {
  const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
  if (step) {
    e.preventDefault();
    moveSelected(step[0], step[1]);
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (S.selected != null) putAt(S.selected);
    return;
  }
  if (e.key === 'e' || e.key === 'E') {
    e.preventDefault();
    eraseSelected();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'SELECT' || t.tagName === 'BUTTON')) return; // 别让快捷键抢走按钮的空格
  const k = e.key.toLowerCase();
  if (k === '1') setPen(BLACK);
  else if (k === '2') setPen(WHITE);
  else if (k === 'u') doUndo();
  else if (k === 'h') doHint();
  else if (k === 'n') newGame(S.tierKey, S.seed, true);
  else return;
  e.preventDefault();
});

for (const t of TIERS) {
  const o = document.createElement('option');
  o.value = t.key;
  o.textContent = `${t.label} ${t.w}×${t.h}`;
  dom.tier.appendChild(o);
}
dom.tier.value = S.tierKey;
dom.tier.addEventListener('change', () => newGame(dom.tier.value, S.seed, false));
dom.penBlack.addEventListener('click', () => setPen(BLACK));
dom.penWhite.addEventListener('click', () => setPen(WHITE));
dom.newGame.addEventListener('click', () => newGame(S.tierKey, S.seed, true));
dom.winNext.addEventListener('click', () => newGame(S.tierKey, S.seed, true));
dom.hint.addEventListener('click', doHint);
dom.undo.addEventListener('click', doUndo);
dom.check.addEventListener('click', doCheck);
dom.clear.addEventListener('click', doClear);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layout();
    render();
  }, 100);
});

// ── 闸的脸 ────────────────────────────────────────────────────────────
// 方法全部读**同一批**活对象（game / view / store），另开一条 worker 做出题对照。
// 这里没有"为闸准备的假数据"：任何一个读数都是玩家此刻看到的那个。
let signalBoard = () => {};
const facade = {
  ready: new Promise((resolve) => {
    signalBoard = () => resolve(facade.snapshot());
  }),
  snapshot() {
    return {
      url: location.href,
      baseURI: document.baseURI,
      timeOrigin: performance.timeOrigin,
      tierKey: S.tierKey,
      seed: S.seed,
      seedText: seedText(),
      attemptNo: S.attemptNo,
      w: game.w,
      h: game.h,
      n: game.n,
      reg: Array.from(game.reg),
      regStr: regStr(),
      marks: game.encode(),
      moves: game.moves,
      hints: game.hints,
      pen: S.pen,
      selected: S.selected,
      hintCells: S.hintCells.slice(),
      wrongCells: S.wrong.slice(),
      generating: S.generating,
      msg: S.msg,
      status: game.status(),
      totals: S.totals,
      metrics: S.metrics,
      elapsedMs: elapsedMs(),
      pinned: S.pinned,
      restored: S.restored,
      bootedFrom: S.bootedFrom,
      storeAvailable: store.load().available,
    };
  },
  geo: () => view.geo,
  canvasBox: () => view.canvas.getBoundingClientRect().toJSON(),
  centerOf: (i) => view.centerOf(i),
  centers: () => Array.from({ length: game.n }, (_, i) => view.centerOf(i)),
  hitAt: (x, y) => view.hitCell(x, y),
  pixelAt: (x, y) => view.pixelAt(x, y),
  engine: { RULES, BLACK, WHITE, UNKNOWN, TIERS },
  // 闸要判的是**玩家看见的那行字**，所以界面节点与本文档的身份也交出去（只读用法）。
  // doc.timeOrigin 是续局腿的证人之一：新文档里它必须换个值，否则那就是同文档片段跳转。
  doc: { timeOrigin: String(performance.timeOrigin), href: location.href, baseURI: document.baseURI },
  dom,
  newGame,
  setPen,
  // 独立 import 引擎再判一次：页面上的读数与引擎的读数必须是同一句话。
  rejudge(marks) {
    const g = new Game(Uint8Array.from(game.reg), game.w, game.h);
    if (marks && !g.decode(marks)) return { err: 'marks 长度对不上' };
    return {
      status: g.status(),
      check: checkSolution(stateToBlack(g.state), game.reg, game.w, game.h),
      partition: validatePartition(game.reg, game.w, game.h),
    };
  },
  // 这盘到底是不是唯一解：拿引擎里的穷举计数器数一遍（出题链上已经数过，这里是**第二遍**）。
  uniqueness(reg = game.reg, w = game.w, h = game.h) {
    return countByRegion(Uint8Array.from(reg), w, h, { budget: 400_000 });
  },
  // 换一局那条链的对照：同一 (tier, seed) 走一遍引擎里的 generate()（同步，会占主线程）。
  generateSync: (tierKey, seed) => generate(tierKey, seed >>> 0),
  // 另起一条 worker 做对照，不碰玩家眼前这一局。
  generateViaWorker(tierKey, seed, maxAttempts) {
    return new Promise((resolve, reject) => {
      const w = new Worker(workerUrl(), { type: 'module' });
      const reqId = ++reqSeq;
      w.onmessage = (e) => {
        const d = e.data || {};
        if (d.reqId !== reqId) return;
        if (d.ev === 'ok' || d.ev === 'empty' || d.ev === 'error') {
          w.terminate();
          resolve(d);
        }
      };
      // 这条 reject 是**边界**上的：module worker 起不来（老 Safari、被 CSP 拦掉）在 DOM 那一侧
      // 只表现为 onerror，Promise 永远不 settle 的话闸会挂在超时上，读起来像"闸自己坏了"。
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message || 'worker 加载失败'));
      };
      w.postMessage({ cmd: 'generate', reqId, tierKey, seed: seed >>> 0, maxAttempts });
    });
  },
  clearStore() {
    store.save({ resume: null, totals: store.emptyTotals() });
    return store.load();
  },
};
window.norinori = facade;

// ── 开机 ──────────────────────────────────────────────────────────────
applyThemeVars();
const url = urlState();
setPen(BLACK);

(function boot() {
  const saved = store.load();
  if (url.seed !== null || url.tierKey) {
    // URL 指到哪儿就是哪儿：带 seed/tier 的开机会**忽略**存档，因为闸要的是那张已知的盘。
    S.pinned = true;
    S.bootedFrom = 'url';
    if (url.seed !== null) S.seed = url.seed;
    if (url.tierKey) S.tierKey = url.tierKey;
    dom.tier.value = S.tierKey;
    render();
    requestNew();
  } else if (saved.resume && restore(saved.resume)) {
    S.bootedFrom = 'store';
  } else {
    S.bootedFrom = saved.available ? 'default-seed' : 'default-seed(no-store)';
    render();
    requestNew();
  }
})();

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  const unsupported = () => {
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();
