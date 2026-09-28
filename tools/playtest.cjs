#!/usr/bin/env node
// 最小 CDP 驱动（需要 Node 22+：全局 WebSocket/fetch，零依赖）· 乗りのり Norinori 浏览器闸
//
// env: CDP_PORT  devtools 端口，本仓 9379
//      BASE_URL  页面 origin，默认 http://127.0.0.1:5279/（根形态）；前缀形态用 5280
//      NAV_URL   scenario/interact 的**导航 URL**（同源，可带查询串）；缺省 = BASE_URL
//                verify.sh 用它跑 ?tier=&seed= 那一形态；续局腿反过来必须走**不带查询串**的那一形
//      VIEWPORT  可选 "WxH" 或 "WxHxD"（D=deviceScaleFactor，缺省 1）。
//                **覆写挂在 attach 出来的那个 session 上**：进程退出=会话关闭=覆写消失，
//                所以窄屏腿必须在自己那次调用里带 VIEWPORT，绝不许"先起一个进程设覆写就退出"
//                （那样跑断言的进程从没被覆写，只是把桌面断言在 vw 1280 上又跑一遍的假绿）。
//      MAX_ROUNDS interact 的回合上限（默认 10）
//      SABOTAGE  闸的**阴性自证**开关：把 node 证人里的一个数改错一位再交给页面。
//                绿不了的闸不是闸；它不参与任何正常判定，只用来证明"改错了会红"。
//
//   node tools/playtest.cjs open <url>              新开一个 tab，打印启动期 console
//   node tools/playtest.cjs eval '<expr>' [nonav]   求值（await promise），打印结果
//   node tools/playtest.cjs scenario <名> [json]    注入 tools/scenarios.js，跑 __scn.<名>()
//   node tools/playtest.cjs interact <名> [json]    同上，但走 **CDP 真指针 / 真按键 / 真刷新**多回合：
//                                                   页面交回 {pending:[{x,y}…]} ⇒ 本机 Input.dispatchMouseEvent 点下去
//                                                   页面交回 {pendingKeys:[{key}…]} ⇒ 本机 Input.dispatchKeyEvent 按下去
//                                                   页面交回 {reload:1} ⇒ 本机**先取刷新前证人**再 Page.reload
//                                                   页面交回 {carry:{…}} ⇒ 由 node 保管并在下一回合送回
//   node tools/playtest.cjs witness <tier> <seed>   **node 侧证人**（不起 Chrome）：用浏览器加载的
//                                                   同一批 js/ 模块现算那张盘的 reg / 真解 / 尝试序号 / 难度读数
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs logs
//
// 三条本组织付过学费的口径，写在这个文件的行为里：
//   · **scenario/interact 每次都重新 navigate**，所以"跨刷新"的读数拿到的是一次真导航之后的新文档；
//     期望值走 argv → window.__expectRaw（**原样字符串**，场景里自己 JSON.parse），
//     **不走 URL 的 #expect=**：同一个文档里只换 fragment 不是导航，window.norinori 还在、
//     存档根本没被读过，那条续局断言就成了闸自己对自己。
//   · 选哪个页面 attach 由 BASE_URL 的 origin 决定，不写死端口：一个悄悄落在 about:blank 上的 eval
//     读起来像"部署坏了"，实际是门禁连错了对象。
//   · **指针腿走 CDP，不走 element.click()**：dispatchMouseEvent 产生的是浏览器自己的
//     pointerdown/mouseup/click 序列，命中盒、事件目标、焦点都由 Chrome 决定 —— 这才叫"真指针"。
//     页面侧只允许交回坐标（它量到的 clientX/clientY），坐标到点击的这一步在 node 这边发生。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PORT = Number(process.env.CDP_PORT || 9379);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5279/';
const ORIGIN = new URL(BASE).origin;
const SABOTAGE = process.env.SABOTAGE === '1';
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

function parseViewport(s) {
  const str = String(s || '');
  if (!str) return null;
  const m = /^(\d+)x(\d+)(?:x(\d+))?$/.exec(str);
  if (!m) throw new Error(`VIEWPORT 形状不认识（要 WxH 或 WxHxD）：${str}`);
  const dpr = m[3] === undefined ? 1 : Number(m[3]);
  if (!(dpr >= 1 && dpr <= 8)) throw new Error(`deviceScaleFactor 不在 1..8 里：${dpr}`);
  return { width: Number(m[1]), height: Number(m[2]), dpr };
}
const VIEWPORT = parseViewport(process.env.VIEWPORT);

const logs = [];

/** 把串里第一个十六进制位翻掉：只给 SABOTAGE 的阴性自证用。 */
function breakOneDigit(s) {
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    if (/[0-9a-f]/i.test(str[i])) {
      const c = str[i];
      const next = String.fromCharCode(c.charCodeAt(0) + (/[0-8]/i.test(c) ? 1 : -1));
      return str.slice(0, i) + next + str.slice(i + 1);
    }
  }
  return str + 'x';
}

// ── node 侧证人：import 的就是浏览器加载的那批 js/ 模块 ──────────────────────────────────
async function engine() {
  const at = (rel) => import(pathToFileURL(path.join(__dirname, '..', ...rel.split('/'))).href);
  const gen = await at('js/engine/generate.js');
  const grid = await at('js/engine/grid.js');
  const counter = await at('js/engine/counter.js');
  const solver = await at('js/engine/solver.js');
  return { gen, grid, counter, solver };
}

/**
 * node 侧把一张盘算出来。交回的 solution 是**真值**：它只该出现在 node 侧与闸的期望值里，
 * 页面拿它当"要被扫掉的东西"，不当"页面算出来再对表的答案"。
 */
async function nodeWitness(tierKey, seed) {
  const { gen, grid, counter } = await engine();
  const g = gen.generate(tierKey, Number(seed));
  if (!g.ok) return { ok: false, reason: g.reason, tier: tierKey, seed: Number(seed) };
  const count = counter.countByRegion(g.reg, g.w, g.h, { budget: 400_000 });
  return {
    ok: true,
    tier: tierKey,
    seed: Number(seed),
    w: g.w,
    h: g.h,
    attempts: g.attempts,
    attemptNo: g.attempts - 1,
    reg: Array.from(g.reg),
    regStr: Array.from(g.reg).join(','),
    solution: Array.from(g.solution),
    solutionStr: Array.from(g.solution).join(''),
    metrics: g.metrics,
    check: grid.checkSolution(g.solution, g.reg, g.w, g.h),
    uniqueness: { exhausted: !!count.exhausted, count: count.count, atLeast: count.atLeast ?? null },
  };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  // witness 这一腿不连 Chrome：它是"页面读数的对照组"，必须先能独立跑起来。
  if (cmd === 'witness') {
    const w = await nodeWitness(arg, rest);
    console.log(JSON.stringify(w));
    process.exit(w.ok ? 0 : 1);
  }

  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  if (VIEWPORT) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.dpr,
      mobile: false,
    }, sessionId);
  }

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
  };

  /** 一次 CDP 真指针点击：move → press → release，坐标就是页面量到的 clientX/clientY。 */
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }, sessionId);
  };

  const KEYDESCRIPTOR = {
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
    ' ': { code: 'Space', vk: 32, text: ' ' },
    Enter: { code: 'Enter', vk: 13, text: '\r' },
    '1': { code: 'Digit1', vk: 49, text: '1' },
    '2': { code: 'Digit2', vk: 50, text: '2' },
    e: { code: 'KeyE', vk: 69, text: 'e' },
    h: { code: 'KeyH', vk: 72, text: 'h' },
    n: { code: 'KeyN', vk: 78, text: 'n' },
    u: { code: 'KeyU', vk: 85, text: 'u' },
  };

  /** 一次 CDP 真按键：keyDown（可打印键带 text）+ keyUp。未知键名直接抛：静默少派一个键就是假绿。 */
  const pressKey = async (name) => {
    const d = KEYDESCRIPTOR[name];
    if (!d) throw new Error(`键盘腿要派的键不在表里：${JSON.stringify(name)}`);
    const base = { key: name, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
    const txt = d.text ? { text: d.text } : {};
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...txt }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  };

  /**
   * 续局腿的**刷新前证人**：node 在派发 Page.reload **之前**自己跑一次 Runtime.evaluate。
   * 只有 node 手里有这份东西，刷新后的场景才可能拿到"不是这个文档给的"值 —— 同文档片段跳转
   * 冒充重载那一类假绿就死在这一句上（页面自己报的读数它也能报对，但它报不出第二个 timeOrigin）。
   * 顺手把哨兵串设进旧上下文：新文档里读不到它 = JS 上下文真的换了。
   */
  const SENTINEL = '__norinoriPreReloadSentinel';
  const preReloadWitness = async () => {
    const raw = await evaluate(`(() => {
      window.${SENTINEL} = ${JSON.stringify('norinori-verify-pre-reload')};
      const s = window.norinori && window.norinori.snapshot ? window.norinori.snapshot() : null;
      if (!s) throw new Error('刷新前证人取不到：window.norinori.snapshot() 是空的');
      return JSON.stringify({
        sentinel: window.${SENTINEL},
        timeOrigin: String(performance.timeOrigin),
        href: location.href,
        tierKey: s.tierKey, seed: s.seed, regStr: s.regStr, marks: s.marks,
        moves: s.moves, hints: s.hints, totals: s.totals, elapsedMs: s.elapsedMs,
      });
    })()`);
    return JSON.parse(raw);
  };

  /** 一次**真**刷新：Page.reload + 等文档重新 complete + 重新上膛（新文档的 window 是空的）。 */
  const reloadDocument = async () => {
    await cdp.send('Page.reload', { ignoreCache: false }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
    await arm();
  };

  const install = async () => {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await navigate(process.env.NAV_URL || BASE);
    await arm();
  };

  /**
   * 每次导航之后重新上膛：headless 会把页面报成 hidden，等重绘的场景就会对着一个假装在后台的
   * tab 超时；期望值走 window.__expectRaw（原样字符串），场景里自己 JSON.parse。
   * **续局腿刷新之后也要走这里**：新文档的 window 是空的，__expectRaw 不上膛就没有期望值。
   */
  const arm = async () => {
    let expectRaw = rest || 'null';
    // 阴性自证只改 boot 腿的**一个数**：把 node 证人里的尝试次数改错一位。
    // 挑这一位是因为它必须"页面显示的读数 == node 现算的读数"才绿得起来 ——
    // 闸若看不见界面，这一个改动就一片绿，那正是我们要能自证的那件事。
    if (SABOTAGE && cmd === 'scenario' && arg === 'boot') {
      try {
        const j = JSON.parse(expectRaw);
        if (j && j.attempts !== undefined) {
          j.attempts = Number(breakOneDigit(String(j.attempts)));
          j.attemptNo = j.attempts - 1;
          expectRaw = JSON.stringify(j);
        }
      } catch {
        /* 期望值本来就不是 JSON：交给场景自己报"没拿到证人" */
      }
    }
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});
      window.__expectRaw = ${JSON.stringify(expectRaw)}; 'ok'`);
  };

  const call = (name, roundArg) => `(async()=>{
      if (!window.__scn) throw new Error('scenarios.js never installed');
      const fn = window.__scn[${JSON.stringify(name)}];
      if (typeof fn !== 'function') {
        throw new Error('没有这个场景：' + ${JSON.stringify(name)} + '（已注册：' + Object.keys(window.__scn).join(',') + '）');
      }
      const r = await fn(${roundArg || 'undefined'});
      return JSON.stringify(r);
    })()`;

  /**
   * 走管道时 stdout 是**异步**写：`process.exit()` 紧跟在 console.log 后面会把最后一行 RESULT 截掉，
   * 门禁就把这条腿读成"这条腿一条断言都没发生"（真在本地 pipe 里复现过一次：同一命令接管道少尾行）。
   * 所以关键那一笔用 write 的回调拿回执：回调落地才是交给内核了，然后才准退。
   */
  /** 页面交回的行 + 需要时才跑的 node 证人，合成一条 RESULT 打在最后。 */
  const emit = async (out) => {
    const parsed = JSON.parse(out);
    if (parsed && parsed.nodeWitness === 'generateSamples') {
      const { gen } = await engine();
      const rows = parsed.rows || [];
      let matched = 0;
      for (const s of parsed.samples || []) {
        const g = gen.generate(s.tier, s.seed >>> 0);
        const pass = g.ok && Array.from(g.reg).join(',') === s.regStr
          && Array.from(g.solution).join('') === s.solutionStr
          && g.attempts - 1 === s.attemptNo;
        if (pass) matched += 1;
        rows.push({
          test: `reproof/worker-vs-generate/${s.tier}#${s.seed}`,
          pass,
          detail: pass ? '' : `node 侧 ${g.ok ? `reg=${Array.from(g.reg).join(',').slice(0, 24)}… attempts=${g.attempts}` : `没出货：${g.reason}`}`,
        });
      }
      parsed.rows = rows;
      parsed.fail = rows.filter((r) => !r.pass).length;
      parsed.matched = `${matched}/${(parsed.samples || []).length}`;
    }
    if (logs.length) await new Promise((res) => process.stderr.write(logs.slice(-40).join('\n') + '\n', res));
    await new Promise((res) => process.stdout.write('RESULT ' + JSON.stringify(parsed) + '\n', res));
  };

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === 'scenario') {
    await install();
    await emit(await evaluate(call(arg)));
  } else if (cmd === 'interact') {
    await install();
    const max = Number(process.env.MAX_ROUNDS || 10);
    let final = null;
    let carry = null;
    let keptRows = []; // 刷新**前**那几回合的断言：旧文档一死页内数组就没了，靠 node 兜住
    for (let round = 0; round < max; round++) {
      const ctxParts = [`round:${round}`];
      if (carry !== null) ctxParts.push(`carry:${JSON.stringify(carry)}`);
      final = JSON.parse(await evaluate(call(arg, `{${ctxParts.join(',')}}`)));
      if (final.carry) carry = Object.assign({}, carry || {}, final.carry);
      if (final && final.reload) {
        if (Array.isArray(final.rows)) keptRows = keptRows.concat(final.rows);
        const pre = await preReloadWitness();
        carry = Object.assign({}, carry || {}, { pre, pageReported: final.pre || null });
        if (typeof final.reload === 'string' && final.reload.startsWith('fragment:')) {
          // 阴性自证专用：**同文档**片段导航（不是导航：window 还在、store.load() 一次都没跑）。
          await evaluate(`location.href = ${JSON.stringify(final.reload.slice('fragment:'.length))}`);
          await sleep(200);
          await arm();
        } else if (typeof final.reload === 'string' && final.reload.startsWith('goto:')) {
          // 同源的**另一个 URL**：Page.navigate 是一次真导航（新文档、store 重新读一遍）。
          // 续局腿要的就是这个：不带 ?tier=&seed= 的裸 URL 上，界面只有存档可问。
          await navigate(final.reload.slice('goto:'.length));
          await arm();
        } else {
          await reloadDocument();
        }
        continue;
      }
      for (const p of (final && final.pending) || []) await clickAt(p.x, p.y);
      for (const k of (final && final.pendingKeys) || []) await pressKey(typeof k === 'string' ? k : k.key);
      // 页面每回合用 drain() 把攒下的断言交回（文档随时会因 reload 消失），node 在这里兜住。
      if (Array.isArray(final.rows)) keptRows = keptRows.concat(final.rows);
      if (final && final.done) break;
      if (!(final.pending && final.pending.length) && !(final.pendingKeys && final.pendingKeys.length)) {
        await sleep(120); // 页面在等 worker 的尾巴，下一回合再看
      }
    }
    final.rows = keptRows;
    final.fail = keptRows.filter((r) => !r.pass).length;
    await emit(JSON.stringify(final));
  } else if (cmd === 'shot') {
    // 后台标签页只在有重绘时才推合成帧，纯 CSS 状态变化后立刻截图会拿到上一帧 ⇒ 先 bringToFront。
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  const lines = ['ERROR ' + (err.message || err)];
  if (logs.length) lines.push(...logs.slice(-12));
  // 崩这一条腿时最值钱的就那行 ERROR：管道里它是异步写，直接 exit 会把它自己截掉。
  process.stderr.write(lines.join('\n') + '\n', () => process.exit(1));
});
