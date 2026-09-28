// 浏览器闸跑在页面里的场景：注入后由 tools/playtest.cjs 的 `scenario|interact <名>` 调 window.__scn.<名>()。
//
// 本回合八条腿（verify.sh 的清单；boot / render / store 各跑两种 URL 形态 ⇒ 共十一段）：
//   · boot       场景 A · 启动、URL 定盘、页内引擎与 node 证人逐字相同（含"界面那行字"的读数）
//   · render     场景 B · 像素与剖分：细线/粗线只在剖分说的地方出现、外沿没被裁掉、棋盘色对得上表
//   · pointer    场景 C · **CDP 真指针**把一张盘走完（页面只交坐标；粗线外那一点必须点不动）
//   · keyboard   场景 D · **真键盘通道**（Input.dispatchKeyEvent；页面一个 press() 都不调）
//   · resume     场景 E · 跨**真刷新**续玩（刷新前证人由 node 从旧上下文取走再送回来）
//   · resumefrag 场景 E' · 阴性自证：同文档只换 #fragment，那条"换了文档"的证人必须红
//   · sizes      场景 F · 五档尺寸：布局/命中/画布像素三件事同时成立
//   · reproof    场景 G · 出货对照：worker 那条链交回的盘，node 侧 generate() 必须一字不差地重算出来
//   · store      场景 H · 一个键、一份档：坏档读成没档，半对的档写不进去
//
// 规矩与兄弟仓同名同姓，内容是本仓自己的：
//   * 一条断言只写一次 `ck(名, 条件, 细节)`，机器可读的 `RESULT <json>` 由 playtest.cjs 打在 stdout
//     最后一行；一条断言都没发生的场景在 tools/verify.sh 里直接判红；
//   * **期望值来自 node**：真解、reg、尝试次数全部由 `node tools/playtest.cjs witness <tier> <seed>`
//     现算（它 import 的就是浏览器加载的那批 js/ 模块），经 argv → window.__expectRaw 传进来。
//     页内不许"跟自己的上一版对表"，也不许把真解算出来再抄：真解只以"要被扫掉的东西"这个身份进页面；
//   * 指针腿与键盘腿走 **CDP**（tools/playtest.cjs 的 interact），页面只交坐标与键名；
//   * 判定用的读数留在 rows 里；墙钟与视口那类回读以 `_` 前缀交回，供复验、不进可 diff 的通道。
//
// 这一段跑在 js/main.js **之前**（Page.addScriptToEvaluateOnNewDocument），所以启动期的未捕获异常
// 与资源 404 抓得到：那是浏览器闸要抓的第一类 bug，页面自己永远打印不出来。
((w) => {
  // ---------------------------------------------------------------- 探针：启动期的错与 404
  const PROBE = { js: [], res: [] };
  w.__probe = PROBE;
  w.addEventListener('error', (ev) => {
    const t = ev && ev.target;
    if (t && t !== w && (t.tagName || t.src || t.href)) {
      PROBE.res.push(`${t.tagName || 'node'}:${t.src || t.href || ''}`);
    } else {
      PROBE.js.push(String((ev && (ev.message || ev.error)) || 'error'));
    }
  }, true);
  w.addEventListener('unhandledrejection', (ev) => PROBE.js.push('rejection: ' + String(ev.reason)));
  const realError = w.console.error;
  w.console.error = function () {
    PROBE.js.push('[console.error] ' + [].map.call(arguments, String).join(' '));
    return realError.apply(this, arguments);
  };

  // ---------------------------------------------------------------- 断言小台
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  // 一次导航/回合里攒下的断言交回 node 保管并清空：Page.reload 之后这是**新文档**，
  // 模块级 rows 跟着旧文档一起没了，不交回来那条腿就变成"只验了后半截"。
  const drain = () => {
    const o = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length };
    rows.length = 0;
    return o;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = () => w.norinori;
  const S = () => w.norinori.snapshot();
  const text = (node) => ((node || {}).textContent || '');
  const exp = () => JSON.parse(w.__expectRaw || 'null');

  /**
   * 动态 import 必须按 document.baseURI 解析：Pages 把本仓挂在 /<repo>/ 下，斜杠开头的说明符会解到
   * 域名根上 404（本地"根形态"跑起来一切正常 —— 最坏的那种绿）。
   * 场景用它拿引擎与主题表，判的正是"界面 import 的那批模块与闸 import 的是不是同一批"。
   */
  const mod = (rel) => import(new URL(rel, document.baseURI).href);

  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const marksOf = (solution) => Array.from(solution, (v) => (v ? '#' : 'o')).join('');
  const elCenter = (node) => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  // 第一格左上角再往外 3 像素：还在画布上（pad=14），但已经出了网格 ⇒ 真点击应当什么也不做。
  const outsideGrid = () => {
    const g = H().geo();
    const c = H().centerOf(0);
    return { x: c.x - g.cell / 2 - 3, y: c.y - g.cell / 2 - 3 };
  };

  const booted = async () => Promise.race([
    H().ready,
    wait(40000).then(() => { throw new Error('norinori.ready 40 秒没落地：一条盘都没开到'); }),
  ]);

  /** 等 worker 交出这一档这一尺寸的盘（出货时间有尾巴：硬骨档单次 attempt 实测 0.6～2.3 秒）。 */
  const settle = async (want, timeoutMs = 40000) => {
    const t0 = Date.now();
    for (;;) {
      const s = S();
      if (!s.generating && s.n > 0 && (!want || (s.tierKey === want.key && s.w === want.w && s.h === want.h))) return s;
      if (Date.now() - t0 > timeoutMs) throw new Error(`worker 在 ${timeoutMs}ms 里没出货（${JSON.stringify(want || null)}）`);
      await wait(40);
    }
  };

  const KEY = 'norinori.save.v1';
  const readStore = () => JSON.parse(w.localStorage.getItem(KEY) || 'null');

  // ================================================================ 场景 A：启动与定盘
  const boot = async () => {
    await booted();
    const e = exp();
    const s = S();

    ck('boot/探针/无未捕获异常', PROBE.js.length === 0, PROBE.js.slice(0, 4).join(' | '));
    ck('boot/探针/无资源 404', PROBE.res.length === 0, PROBE.res.slice(0, 4).join(' | '));
    ck('boot/闸的脸在场', !!(H() && H().snapshot && H().geo && H().pixelAt && H().dom),
      JSON.stringify(Object.keys(H() || {})));
    if (!e || !e.ok) {
      ck('boot/node 证人可用', false, `witness 交回 ${JSON.stringify(e)}`);
      return report({ note: 'node 侧没出货，后面的断言没法判' });
    }

    eq('boot/档位', s.tierKey, e.tier);
    eq('boot/种子', s.seed, e.seed);
    if (e.via === 'default') {
      // 不带查询串那一跑判的是"默认种子那一路"：种子必须是模块里那个常数，**不是按日期算的**。
      // 明天再跑，Date.now() 那种写法就会给出另一个种子，这一条当场红（本组织栽过两次）。
      ck('boot/默认种子那一路没被 URL 干扰', s.pinned === false, 'pinned=true：没带查询串却以为自己被定盘了');
      eq('boot/开机来源=默认种子', s.bootedFrom, 'default-seed');
    } else {
      ck('boot/URL 定盘被认出来', s.pinned === true, 'pinned=false：?tier=&seed= 没走 URL 那条开机路径');
      eq('boot/开机来源=URL', s.bootedFrom, 'url');
    }
    ck('boot/主线程已经交回', s.generating === false, '还在 generating 就断言读数就是抢跑');
    eq('boot/盘面尺寸', `${s.w}x${s.h}`, `${e.w}x${e.h}`);

    // 跨引擎的同一张盘：node 现算的 reg 必须与 Chrome 里 worker 算出来的一字不差。
    ck('boot/reg 与 node 证人相同', s.regStr === e.regStr, `got ${s.regStr.slice(0, 40)}… want ${e.regStr.slice(0, 40)}…`);
    eq('boot/第几次尝试出货', s.attemptNo, e.attemptNo);
    eq('boot/界面上的尝试读数', text(H().dom.attemptN), String(e.attemptNo + 1));
    ck('boot/界面种子行里有这个种子', text(H().dom.seed).includes(s.seedText), `${text(H().dom.seed)} 里找不到 ${s.seedText}`);
    ck('boot/界面档位行里有这个档', text(H().dom.seed).includes(e.tier), text(H().dom.seed));

    // 页面手里的判定与引擎的判定：rejudge 用 js/engine 再判一次那张真解。
    const rj = H().rejudge(marksOf(e.solution));
    ck('boot/真解过完整判定', rj.check.ok === true, JSON.stringify(rj.check));
    ck('boot/真解让 status 报 solved', rj.status.solved === true, JSON.stringify(rj.status));
    eq('boot/黑格数=2×区域数', e.solution.reduce((a, b) => a + b, 0), 2 * rj.partition.regionCount);
    ck('boot/剖分自洽', rj.partition.ok === true, JSON.stringify(rj.partition));

    // 唯一性：出货链上已经数过一遍，这里是浏览器里的**第二遍**（同一批模块、另一个引擎）。
    const u = H().uniqueness(Uint8Array.from(e.reg), e.w, e.h);
    ck('boot/穷举器数完没掐停', u.exhausted === true, JSON.stringify(u));
    eq('boot/穷举器数到恰好一个解', u.count, 1);

    // 零猜测：页内 import 的求解器必须不靠猜推到底，且推出来的就是 node 证人里那条真解。
    const solver = await mod('js/engine/solver.js');
    const run = solver.solve(Uint8Array.from(e.reg), e.w, e.h);
    ck('boot/求解器推到底', run.complete === true && !run.contradiction,
      JSON.stringify(run.contradiction || { unknown: run.unknown }));
    eq('boot/求解器推出来的=真解', Array.from(run.state).map((v) => (v === solver.BLACK ? 1 : 0)).join(''), e.solution.join(''));
    eq('boot/求解器落子数=格数', run.steps, e.w * e.h);
    ck('boot/规则表是那一五条', Object.keys(solver.RULES).sort().join(',') === Object.keys(H().engine.RULES).sort().join(','),
      `${Object.keys(solver.RULES)} vs ${Object.keys(H().engine.RULES)}`);

    // 开局那一眼：不许已经"推完"，胜利卡片不许在场。
    ck('boot/开局没报 solved', s.status.solved === false, JSON.stringify(s.status));
    ck('boot/状态行成人话', text(H().dom.status).length > 4, JSON.stringify(text(H().dom.status)));
    ck('boot/胜利卡片是藏的', H().dom.veil.hidden === true && getComputedStyle(H().dom.veil).display === 'none',
      `hidden=${H().dom.veil.hidden} display=${getComputedStyle(H().dom.veil).display}`);

    // 画布背板像素 = CSS 尺寸 × dpr（粗线糊成一团通常就是从这一位开始漂的）。
    const g = H().geo();
    const box = H().canvasBox();
    ck('boot/背板像素=dpr×CSS', Math.abs(H().dom.canvas.width - Math.round(box.width * g.dpr)) <= 1,
      `canvas.width=${H().dom.canvas.width} box.width=${box.width} dpr=${g.dpr}`);
    ck('boot/几何数在场', g.cell > 0 && g.pad > 0 && g.dpr >= 1, JSON.stringify(g));

    return report({ tier: e.tier, seed: e.seed, via: e.via || 'url', regStr: s.regStr, _timeOrigin: s.timeOrigin, _baseURI: s.baseURI, _metrics: s.metrics });
  };

  // ================================================================ 场景 B：像素与剖分
  const render = async () => {
    await booted();
    const s = S();
    const { Palette, Board } = await mod('js/theme.js');
    const geo = H().geo();
    const black = rgbOf(Palette.black);
    const dot = rgbOf(Palette.dot);
    const cellBg = rgbOf(Palette.cellBg);
    const cellBgAlt = rgbOf(Palette.cellBgAlt);
    const regionLine = rgbOf(Palette.regionLine);
    const gridLine = rgbOf(Palette.gridLine);
    const boardBg = rgbOf(Palette.boardBg);

    // 1) 每一格的中心：空盘时必须是那两色底纹之一，而且要按 (r+c) 奇偶对上 ——
    //    这一条同时钉住了 offX/offY/cell 三个数：错任何一格，取样就落到别的格上去。
    let parityBad = 0;
    for (let i = 0; i < s.n; i += 1) {
      const c = H().centerOf(i);
      const px = H().pixelAt(c.x, c.y);
      const r = (i / s.w) | 0;
      const want = (r + i % s.w) % 2 === 0 ? cellBg : cellBgAlt;
      if (dist(px, want) > 12) parityBad += 1;
    }
    eq('render/每格中心都是该出现的底纹色', parityBad, 0);

    // 2) 相邻两格的中点：剖分不同 ⇒ 粗线色；剖分相同 ⇒ 不许是粗线色。
    let boundaryWrong = 0;
    let sameRegionWrong = 0;
    let boundaryChecked = 0;
    let sameChecked = 0;
    for (let i = 0; i < s.n; i += 1) {
      const r = (i / s.w) | 0;
      const c = i % s.w;
      const pairs = [];
      if (c + 1 < s.w) pairs.push([i, i + 1]);
      if (r + 1 < s.h) pairs.push([i, i + s.w]);
      for (const [a, b] of pairs) {
        const pa = H().centerOf(a);
        const pb = H().centerOf(b);
        const px = H().pixelAt((pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
        if (s.reg[a] !== s.reg[b]) {
          boundaryChecked += 1;
          if (dist(px, regionLine) >= dist(px, gridLine)) boundaryWrong += 1;
        } else {
          sameChecked += 1;
          if (dist(px, regionLine) < dist(px, gridLine)) sameRegionWrong += 1;
        }
      }
    }
    ck('render/粗线数得出来', boundaryChecked > 0, `粗线一条都没量到（同区域 ${sameChecked} 条）`);
    eq('render/粗线只画在剖分不同的地方', boundaryWrong, 0);
    eq('render/细线不许有粗线的颜色', sameRegionWrong, 0);

    // 3) 最外圈粗线完整落在画布内：上边界取样是粗线色，再往上的内边距是盘底色。
    //    pixelAt 收的是 **client 坐标**（它自己减 box.top/box.left），所以取样纵坐标必须从
    //    canvasBox() 起算：直接把 geo.offY 当纵坐标是画布内偏移，14 像素在页面上落到画布之外，
    //    pixelAt 回 null，dist 就拿 null 去减——那条腿当场炸掉（炸得对，但不该由闸自己写错单位）。
    const top = H().centerOf(0);
    const cbox = H().canvasBox();
    const bw = Math.max(2, geo.cell * Board.regionWidth);
    const edgeY = cbox.top + geo.offY;
    const onTopEdge = H().pixelAt(top.x, edgeY);
    ck('render/外沿粗线没被裁掉', geo.offY - bw / 2 >= 0 && dist(onTopEdge, regionLine) < dist(onTopEdge, boardBg),
      `offY=${geo.offY} 线宽=${bw.toFixed(2)} 上边界取样 ${onTopEdge}，regionLine=${regionLine}，boardBg=${boardBg}`);
    const inPad = H().pixelAt(top.x, edgeY - bw / 2 - 3);
    ck('render/粗线外还留着内边距', dist(inPad, boardBg) <= 8, `取样 ${inPad} vs ${boardBg}`);

    // 4) 两种笔的痕迹看得出来是两种，线条宽度按格宽比例走。
    ck('render/空格中心不是黑', dist(H().pixelAt(top.x, top.y), black) > 24,
      `中心 ${H().pixelAt(top.x, top.y)} 与黑 ${black} 太近`);
    ck('render/色表里黑与白点分得开', dist(black, dot) > 60, `Palette.black 与 Palette.dot 只差 ${dist(black, dot)}`);
    ck('render/粗线与细线分得开', dist(regionLine, gridLine) > 60, `regionLine/gridLine 只差 ${dist(regionLine, gridLine)}`);
    const bgGap = dist(cellBg, cellBgAlt);
    ck('render/两种底纹分得开又不太远', bgGap > 6 && bgGap < 120, `差 ${bgGap}：太近看不出格，太远就不是一张纸`);
    ck('render/粗线宽度按格宽比例', Board.regionWidth * geo.cell >= 3, `cell=${geo.cell} → bw=${(Board.regionWidth * geo.cell).toFixed(2)}`);

    return report({ tier: s.tierKey, seed: s.seed, boundaryChecked, sameChecked, _geo: geo });
  };

  // ================================================================ 场景 C：真指针走完一张盘
  const pointer = async (ctx) => {
    await booted();
    const round = (ctx || {}).round;
    const e = exp();
    if (!e || !e.ok) {
      ck('pointer/node 证人可用', false, JSON.stringify(e));
      return report({ done: true });
    }
    const s = S();
    const whites = [];
    const blacks = [];
    e.solution.forEach((v, i) => { (v ? blacks : whites).push(i); });

    if (round === 0) {
      eq('pointer/开局全盘是空的', s.marks, '.'.repeat(s.n));
      const out = outsideGrid();
      ck('pointer/粗线外那一点命中不了格子', H().hitAt(out.x, out.y) === null, String(H().hitAt(out.x, out.y)));
      const pend = [out, elCenter(H().dom.penWhite)];
      for (const i of whites) pend.push(H().centerOf(i));
      return { ...drain(), pending: pend };
    }

    if (round === 1) {
      // 那一次越界点击不许留下任何痕迹：步数只等于白点格数。
      eq('pointer/越界点击没落子', s.moves, whites.length);
      eq('pointer/白点笔真的换了', s.pen, H().engine.WHITE);
      let bad = 0;
      for (const i of whites) if (s.marks[i] !== 'o') bad += 1;
      for (const i of blacks) if (s.marks[i] !== '.') bad += 1;
      eq('pointer/每一颗白点都落在该落的那格', bad, 0);
      const { Palette } = await mod('js/theme.js');
      const w0 = H().centerOf(whites[0]);
      ck('pointer/白点是那个颜色', dist(H().pixelAt(w0.x, w0.y), rgbOf(Palette.dot)) <= 12,
        `取样 ${H().pixelAt(w0.x, w0.y)} vs ${Palette.dot}`);
      // 换黑笔，然后在同一格上连点两下：落黑 → 擦掉。改主意不必另找橡皮。
      const b0 = H().centerOf(blacks[0]);
      return { ...drain(), pending: [elCenter(H().dom.penBlack), b0, b0] };
    }

    if (round === 2) {
      eq('pointer/黑格笔换回来了', s.pen, H().engine.BLACK);
      eq('pointer/同格再点一次擦掉了那颗黑', s.marks[blacks[0]], '.');
      eq('pointer/擦掉也记一步', s.moves, whites.length + 2);
      ck('pointer/没落满就不算解', s.status.solved === false, JSON.stringify(s.status));
      ck('pointer/没解就不许亮胜利卡片', H().dom.veil.hidden === true,
        `hidden=${H().dom.veil.hidden} display=${getComputedStyle(H().dom.veil).display}`);
      return { ...drain(), pending: blacks.map((i) => H().centerOf(i)) };
    }

    if (round === 3) {
      eq('pointer/落子数=格数+那一次擦掉', s.moves, s.n + 2);
      eq('pointer/落成的就是真解', s.marks, marksOf(e.solution));
      ck('pointer/页面自己判定推完了', s.status.solved === true, JSON.stringify(s.status));
      ck('pointer/状态行说推完了', text(H().dom.status).includes('推完了'), text(H().dom.status));
      ck('pointer/胜利卡片亮了', H().dom.veil.hidden === false && getComputedStyle(H().dom.veil).display !== 'none',
        `hidden=${H().dom.veil.hidden} display=${getComputedStyle(H().dom.veil).display}`);
      ck('pointer/累计解出 +1', s.totals.solved >= 1, JSON.stringify(s.totals));
      const { Palette } = await mod('js/theme.js');
      const b0 = H().centerOf(blacks[0]);
      ck('pointer/黑格是那个颜色', dist(H().pixelAt(b0.x, b0.y), rgbOf(Palette.black)) <= 12,
        `取样 ${H().pixelAt(b0.x, b0.y)} vs ${Palette.black}`);
      // 卡片铺满 .board-wrap：推完之后盘面交给这张卡，再点格不动它（要改走撤销/清空/换一局）。
      return { ...drain(), pending: [b0] };
    }

    if (round === 4) {
      const b0 = H().centerOf(blacks[0]);
      const under = document.elementFromPoint(b0.x, b0.y);
      ck('pointer/推完之后那一点落在卡片上而不是格子上',
        under === H().dom.veil || H().dom.veil.contains(under),
        `命中 ${under && `${under.tagName}#${under.id}`}`);
      eq('pointer/卡片挡住了盘面（不谎报成还能改）', s.marks, marksOf(e.solution));
      eq('pointer/被挡住的那一点没记步数', s.moves, s.n + 2);
      return { ...drain(), pending: [elCenter(H().dom.winNext)] };
    }

    // 卡片上的「换一局」是**真指针**点出来的：种子换到链条的下一环，旧局不许留在盘上。
    const fresh = await settle({ key: e.tier, w: e.w, h: e.h }, 60000);
    ck('pointer/换一局换了种子', fresh.seed !== e.seed, `${fresh.seed} 还等于 ${e.seed}`);
    eq('pointer/换一局是同一档位', fresh.tierKey, e.tier);
    eq('pointer/新局开局全盘是空的', fresh.marks, '.'.repeat(fresh.n));
    eq('pointer/新局步数归零', fresh.moves, 0);
    ck('pointer/换一局把卡片收回去了', H().dom.veil.hidden === true, `hidden=${H().dom.veil.hidden}`);
    ck('pointer/新一局仍然自洽', fresh.status.solved === false && H().rejudge(fresh.marks).partition.ok === true,
      JSON.stringify(fresh.status));
    return report({ done: true, marks: s.marks, tier: e.tier, seed: e.seed, nextSeed: fresh.seed });
  };

  // ================================================================ 场景 D：真键盘通道
  const keyboard = async (ctx) => {
    await booted();
    const round = (ctx || {}).round;
    const s = S();
    if (round === 0) {
      // 先用一次真点击把焦点交给画布（点的是粗线外那一点：落子为空，焦点是浏览器给的）。
      return { ...drain(), pending: [outsideGrid()] };
    }
    if (round === 1) {
      ck('keyboard/焦点落在画布上', document.activeElement === H().dom.canvas,
        `activeElement=${document.activeElement && document.activeElement.tagName}`);
      eq('keyboard/那一下没落子', s.moves, 0);
      return { ...drain(), pendingKeys: ['2', 'ArrowRight', 'ArrowDown', ' ', '1', ' '] };
    }
    if (round === 2) {
      eq('keyboard/方向键挪的是焦点格', s.selected, s.w + 1);
      eq('keyboard/空格在焦点格落子', s.marks[s.selected], '#');
      eq('keyboard/白笔先黑笔后，两下都算步数', s.moves, 2);
      return { ...drain(), pendingKeys: ['u'] };
    }
    if (round === 3) {
      // 撤销回到的是**上一步的值**（白），不是"擦干净"：这条钉的是 undoStack 的语义。
      eq('keyboard/撤销回到上一步那颗白点', s.marks[s.selected], 'o');
      return { ...drain(), pendingKeys: ['u', 'h'] };
    }
    eq('keyboard/再撤一次就空了', s.marks[s.selected], '.');
    ck('keyboard/提示这一格真的被圈出来', s.hintCells.length <= 1, JSON.stringify(s.hintCells));
    // 提示给的必须是"本轮可证事实"：与页内 import 的引擎对一遍，不看界面自己说什么。
    const solver = await mod('js/engine/solver.js');
    const fresh = new Uint8Array(s.n);
    for (let i = 0; i < s.n; i += 1) fresh[i] = s.marks[i] === '#' ? solver.BLACK : s.marks[i] === 'o' ? solver.WHITE : solver.UNKNOWN;
    const facts = solver.deriveFacts(Uint8Array.from(s.reg), s.w, s.h, fresh).facts;
    eq('keyboard/提示与引擎的事实集同意的条数', s.hintCells.length, facts.length ? 1 : 0);
    ck('keyboard/提示那格的规则名在表里', !s.hintCells.length || Object.keys(solver.RULES).some((k) => text(H().dom.msg).includes(k)),
      text(H().dom.msg));
    return report({ done: true, marks: s.marks, _facts: facts.length });
  };

  // ================================================================ 场景 E：跨真刷新续玩
  const resume = async (ctx) => {
    await booted();
    const round = (ctx || {}).round;
    const carry = (ctx || {}).carry || {};
    const s = S();
    if (round === 0) {
      H().clearStore();
      ck('resume/清档之后没存档', (readStore() || {}).resume === null, JSON.stringify(readStore()));
      // 三下真点击（默认黑笔）：0、1 两颗相邻黑格是**故意**的坏局面，续局之后它还得是坏局面。
      return { ...drain(), pending: [0, 1, 2].map((i) => H().centerOf(i)) };
    }
    if (round === 1) {
      eq('resume/三下点击都落了', s.moves, 3);
      eq('resume/落子进了存档', (readStore() || {}).resume.marks, s.marks);
      // 下一跳是**裸 URL**（同源、同路径、去掉 ?tier=&seed=）：玩家平时看见的就是这个形状，
      // 界面无从知道"上一局"是哪一个，只有存档答得上来。带着 pin 刷新判的是另一回事（见 round 3）。
      const bare = `${location.origin}${location.pathname}`;
      return {
        ...drain(),
        reload: `goto:${bare}`,
        pre: { tierKey: s.tierKey, seed: s.seed, regStr: s.regStr, marks: s.marks, moves: s.moves, totals: s.totals },
      };
    }
    if (round === 3) {
      // 又一次真导航，但这次 URL 带着 pin：链接说的题面赢，玩家从这一格重新推。
      const pre = carry.pre || {};
      const now = S();
      eq('resume/带 pin 的链接走的是题面', now.bootedFrom, 'url');
      ck('resume/带 pin 的链接不冒充续局', now.restored === false, `restored=${now.restored}`);
      eq('resume/带 pin 的链接开局是空的', now.marks, '.'.repeat(now.n));
      eq('resume/带 pin 的链接步数从零开始', now.moves, 0);
      eq('resume/带 pin 的题面就是 node 证人那张剖分', now.regStr, pre.regStr);
      ck('resume/累计账跨得过 pin', now.totals.games >= 1, JSON.stringify(now.totals));
      return report({ done: true, marks: now.marks, via: 'pin-precedence', _preTimeOrigin: pre.timeOrigin });
    }
    // 刷新之后：这个文档的 window 是新的，证人由 node 从**旧上下文**里取走再送回来。
    const pre = carry.pre || {};
    const now = S();
    ck('resume/换了文档（timeOrigin 由 node 取）', String(pre.timeOrigin) !== String(now.timeOrigin),
      `两边都是 ${now.timeOrigin}`);
    ck('resume/旧上下文的哨兵没跟过来', w.__norinoriPreReloadSentinel === undefined,
      `哨兵还在：${w.__norinoriPreReloadSentinel}`);
    eq('resume/开机走的是存档', now.bootedFrom, 'store');
    ck('resume/页面自己报的是续局', now.restored === true, `restored=${now.restored}`);
    eq('resume/续的是 node 证人那张剖分', now.regStr, pre.regStr);
    eq('resume/续的是 node 证人那份落子', now.marks, pre.marks);
    eq('resume/档位续上了', now.tierKey, pre.tierKey);
    eq('resume/种子续上了', now.seed, pre.seed);
    eq('resume/步数续上了', now.moves, pre.moves);
    ck('resume/累计账没被回滚', now.totals.games >= (pre.totals ? pre.totals.games : 0) && now.totals.moves >= 3,
      JSON.stringify({ now: now.totals, pre: pre.totals }));
    ck('resume/界面那行字念的是这局', text(H().dom.progress).includes('黑 3'), text(H().dom.progress));
    ck('resume/坏局面没有被偷偷判成解', now.status.solved === false, JSON.stringify(now.status));
    // 撤销栈**不在**存档里（存档存的是局面，不是走到它的走法）：续局之后那颗按钮就该是灰的。
    ck('resume/续局之后撤销是灰的', H().dom.undo.disabled === true, `undo.disabled=${H().dom.undo.disabled}`);
    return { ...drain(), reload: `goto:${location.origin}${location.pathname}?tier=${pre.tierKey}&seed=${pre.seed}` };
  };

  // ================================================================ 场景 E'：阴性自证（片段导航不算重载）
  const resumefrag = async (ctx) => {
    await booted();
    const round = (ctx || {}).round;
    const carry = (ctx || {}).carry || {};
    const s = S();
    if (round === 0) {
      // 这一条腿由 playtest.cjs 派**同文档片段跳转**：不是导航，window 还在、store.load() 一次都没跑。
      return { ...drain(), reload: 'fragment:#probe-not-a-navigation', pre: { regStr: s.regStr, marks: s.marks } };
    }
    const now = S();
    // 这两条**必须红**：红不了就等于"续局腿其实没换文档也能过"，那 E 那条腿就是假的。
    ck('resumefrag/换了文档（阴性自证：应当红）', String((carry.pre || {}).timeOrigin) !== String(now.timeOrigin),
      `同文档片段跳转：timeOrigin 两边都是 ${now.timeOrigin}`);
    ck('resumefrag/走了存档恢复路径（阴性自证：应当红）', now.bootedFrom === 'store', `bootedFrom=${now.bootedFrom}`);
    return report({ done: true });
  };

  // ================================================================ 场景 F：五档尺寸
  const sizes = async () => {
    await booted();
    const TIERS = H().engine.TIERS;
    const { Board } = await mod('js/theme.js');
    const seen = [];
    for (let k = 0; k < TIERS.length; k += 1) {
      const t = TIERS[k];
      H().newGame(t.key, 20260929 + k * 977);
      const s = await settle(t);
      const g = H().geo();
      const box = H().canvasBox();
      seen.push({ tier: t.key, cell: g.cell, size: g.size, dpr: g.dpr, css: Math.round(box.width), backing: H().dom.canvas.width });
      eq(`sizes/${t.key} 盘面尺寸`, `${s.w}x${s.h}`, `${t.w}x${t.h}`);
      ck(`sizes/${t.key} 格边在区间里`, g.cell >= Board.cellMin && g.cell <= Board.cellMax, `cell=${g.cell}`);
      ck(`sizes/${t.key} 画布没被裁`, Math.abs(box.width - g.size) <= 1, `box=${box.width} size=${g.size}`);
      ck(`sizes/${t.key} 背板像素=dpr×CSS`, Math.abs(H().dom.canvas.width - Math.round(g.size * g.dpr)) <= 1,
        `canvas.width=${H().dom.canvas.width} size=${g.size} dpr=${g.dpr}`);
      let hitBad = 0;
      let outsideBad = 0;
      for (let i = 0; i < s.n; i += 1) {
        const c = H().centerOf(i);
        if (H().hitAt(c.x, c.y) !== i) hitBad += 1;
        const left = c.x - g.cell / 2;
        const top = c.y - g.cell / 2;
        if (left < box.left - 0.5 || top < box.top - 0.5 || left + g.cell > box.right + 0.5 || top + g.cell > box.bottom + 0.5) outsideBad += 1;
      }
      ck(`sizes/${t.key} 每格中心都命中自己`, hitBad === 0, `${hitBad} 格偏了`);
      ck(`sizes/${t.key} 每格都在画布内`, outsideBad === 0, `${outsideBad} 格出界`);
      ck(`sizes/${t.key} 内边距留得下粗线`, g.pad >= (Board.regionWidth * g.cell) / 2,
        `pad=${g.pad} bw/2=${((Board.regionWidth * g.cell) / 2).toFixed(2)}`);
      eq(`sizes/${t.key} 换局之后盘面清空`, s.marks, '.'.repeat(s.n));
    }
    return report({ tiers: seen.length, _seen: seen });
  };

  // ================================================================ 场景 G：出货对照（worker ↔ node）
  const reproof = async () => {
    await booted();
    const e = exp();
    const samples = (e && e.samples) || [];
    if (!samples.length) {
      ck('reproof/闸没交样本', false, JSON.stringify(e));
      return report({ nodeWitness: 'generateSamples', samples: [] });
    }
    // 主线程是不是还活着：worker 在另一条线程上跑，页面心跳应当按 25ms 的节奏走。
    // 判的是**比例**而不是"每张盘至少跳一次"：实测单张出货 warmup 9ms／easy 14ms／tricky 59ms／
    // hard 986ms（本机 2026-09-29），前两张连一个周期都不到，一次心跳都不该有——
    // 那条"每样本 >=1"的断言量的其实是 Chrome 的定时器对齐，不是主线程有没有被钉住。
    let ticks = 0;
    let elapsedMs = 0;
    const beat = setInterval(() => { ticks += 1; }, 25);
    const out = [];
    for (const s of samples) {
      const before = S();
      const t0 = performance.now();
      const r = await H().generateViaWorker(s.tier, s.seed, 400);
      elapsedMs += performance.now() - t0;
      const after = S();
      ck(`reproof/${s.tier}#${s.seed} 出货了`, r.ev === 'ok', `ev=${r.ev} reason=${r.reason || ''} attempts=${r.attempts}`);
      if (r.ev === 'ok') {
        out.push({
          tier: s.tier,
          seed: s.seed,
          regStr: Array.from(r.reg).join(','),
          solutionStr: Array.from(r.solution).join(''),
          attemptNo: r.attemptNo,
        });
      }
      ck(`reproof/${s.tier}#${s.seed} 没动玩家眼前这局`, after.regStr === before.regStr && after.seed === before.seed,
        '对照用的那条 worker 串到了玩家的这一局上');
    }
    clearInterval(beat);
    const expected = Math.floor(elapsedMs / 25);
    ck('reproof/生成期间主线程没被钉住', expected < 4 || ticks * 2 >= expected,
      `${Math.round(elapsedMs)}ms 里心跳 ${ticks} 次（按 25ms 该有 ${expected} 次；主线程要是被钉住就是 0 次）`);
    return report({ nodeWitness: 'generateSamples', samples: out, _ticks: ticks, _elapsedMs: Math.round(elapsedMs), _expectedTicks: expected });
  };

  // ================================================================ 场景 H：一个键、一份档
  const store = async () => {
    await booted();
    const st = await mod('js/store.js');

    const keys = Object.keys(w.localStorage).filter((k) => k.startsWith('norinori.'));
    eq('store/只有那一个键', keys.length, 1);
    eq('store/键名', keys[0], KEY);

    H().clearStore();
    const cleared = st.load();
    ck('store/清档之后 resume 是空的', cleared.resume === null, JSON.stringify(cleared.resume));
    eq('store/清档之后账是零', cleared.totals.games, 0);

    // 一次真实落子之后页面自己写过档（这一腿判的是持久化，用的是合成 pointerdown；
    // 命中盒与事件目标归场景 C 那条真指针腿管）。
    const s0 = S();
    const c0 = H().centerOf(0);
    H().dom.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: c0.x, clientY: c0.y, bubbles: true }));
    const one = st.load();
    ck('store/落子之后有档', !!one.resume, JSON.stringify(one));
    eq('store/档里的落子与页面一致', one.resume && one.resume.marks, S().marks);
    ck('store/落子真的落下了', S().marks !== s0.marks, '合成事件没走通落子路径');
    ck('store/档里 reg 串长度=格数', one.resume && one.resume.regStr.split(',').length === one.resume.w * one.resume.h,
      one.resume ? `${one.resume.regStr.split(',').length} vs ${one.resume.w * one.resume.h}` : '没档');

    // 档里那份剖分必须是引擎认的：存进去的必须是"能判定的题面"，不是一串坐标残骸。
    const grid = await mod('js/engine/grid.js');
    const restoredReg = Uint8Array.from(one.resume.regStr.split(',').map(Number));
    ck('store/档里的剖分引擎认得', grid.validatePartition(restoredReg, one.resume.w, one.resume.h).ok === true,
      JSON.stringify(grid.validatePartition(restoredReg, one.resume.w, one.resume.h)));

    // 坏档：JSON 都解不开 ⇒ 读成"没有档"，并且当场抹掉（留着只会让玩家每次刷新看见同一个谎）。
    w.localStorage.setItem(KEY, '{oops');
    ck('store/坏档读成没档', st.load().resume === null, '');
    ck('store/坏档被抹掉了', w.localStorage.getItem(KEY) === null, '解不开的档还留在磁盘上');

    // 半对的档：marks 长度对不上格数 ⇒ 不许被接受，也不许被写回去。
    const half = { version: st.SAVE_VERSION, totals: st.emptyTotals(), resume: { seed: 1, tierKey: 'easy', attemptNo: 0, w: 5, h: 4, regStr: '0,0,0', marks: '.#', moves: 0, hints: 0, elapsedMs: 0, at: 1 } };
    w.localStorage.setItem(KEY, JSON.stringify(half));
    ck('store/形状不对的档读成没档', st.load().resume === null, '');
    ck('store/拒绝写入半对的档', st.saveResume(half.resume) === false, 'saveResume 接了一份对不上的档');
    w.localStorage.removeItem(KEY);

    // 版本不符 ⇒ 当没档（改天存档形状变了，不许拿旧形状硬恢复出另一张盘）。
    H().dom.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: c0.x, clientY: c0.y, bubbles: true }));
    const v = readStore();
    eq('store/档带版本号', v.version, st.SAVE_VERSION);
    v.version = st.SAVE_VERSION + 99;
    w.localStorage.setItem(KEY, JSON.stringify(v));
    ck('store/版本号不对就读成没档', st.load().resume === null, '');
    w.localStorage.removeItem(KEY);

    return report({ _key: KEY });
  };

  w.__scn = { boot, render, pointer, keyboard, resume, resumefrag, sizes, reproof, store };
})(window);
