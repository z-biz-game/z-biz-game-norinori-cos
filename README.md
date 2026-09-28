# 乗りのり / Norinori

Nikoli 的二格区域涂黑：题面给你一张**已经切好区域的盘面**（粗线围出来的块，不是要求解的东西），
你要选出一些格子涂黑，满足两条：

1. **每块区域恰好两颗黑格**（不多不少）。
2. **黑格两两成对**：每一颗黑格必须恰好与一颗黑格上下左右相邻，这一对就是一块 1×2 / 2×1 的骨牌。
   骨牌**可以跨过区域边界**（跨出去以后两块区域各出一颗），但两块骨牌不许共边（可以共角）。

没有第三条：白格不需要连成一片，不要求对称，没有全局连通约束。
规则原文钉在 `DESIGN.md` 第一节（两条英文出处逐字抄在那里），因为"骨牌可跨区域"和"白格连通"
这两点正是网上大多数转述会写反的地方 —— 写反一条，出货的盘就不是同一个谜题。

**本仓现在交付到第二阶段：引擎与门禁 + 浏览器壳 + 浏览器闸。还没有 CI workflow、没上线**
——没写的东西不进清单，`package.json` 里也就没有它们的脚本。第三阶段接
`.github/workflows/{ci,pages}.yml`。

界面里跑的就是 `js/engine/` 那六个模块本身，不是它们的复刻：出题在 `js/gen-worker.js` 里跑，
主线程只收进度；判定、剖分自洽性、唯一性口径全部由同一个 `grid.js` / `counter.js` 提供。
所以"页面显示的盘"和"门禁数过的盘"是不是同一张，是一条可以判死的事实 —— 由 `reproof` 那条腿判，
见下面第五个承诺。

---

## 五条承诺，每条都是一条会红的命令

| 承诺 | 谁在判 | 现在的读数 |
| --- | --- | --- |
| 出货的每一盘**零猜测**能推到底 | `tools/solver-test.mjs` ①（每档 8 张出货盘 `solve` 到 `unknown=0`）＋ `tools/generate-test.mjs`（出货门：`run.complete` 是出货前提） | 40 张全推到底 |
| 唯一解**由第二套穷举器复核** | `tools/counter-test.mjs`（按区域枚举 vs 整盘位暴力，80 张 4x4 剖分逐盘同数）＋ `tests/counter-agree.test.mjs`（再拉第三套暴力枚举，40 张随机剖分三套同数） | 逐盘相同；4x4 里唯一解 4 张、随机 40 张里唯一解 1 张 |
| 提示只给**这一步可证的事实** | `tools/rule-test.mjs`：每条事实都必须被**全部相容解**支持（独立计数器数出来的解集），且提示通道 `deriveOne` 只能念本轮事实集里的那一条 | 147 条断言，夹具 6 张 + 死局 4 张 |
| 难度是**量出来的** | `tools/balance.mjs`：墙钟 p95、证明结点 p95、链深 [p10,p90] 命中、阶梯三维单调 | 277 条断言，每档 150 次 attempt |
| 页面显示的就是引擎数过的那张盘、点下去的就是画出来的那一格 | `tools/verify.sh`（真 headless Chrome，十腿 × 两形态）＋ `tools/playtest.cjs`（裸 CDP 驱动，零依赖）：`reproof` 腿把页面 worker 生成的四张盘逐张交回 node 证人比剖分与解，`pointer`/`keyboard` 腿只认 `Input.dispatchMouseEvent` / `dispatchKeyEvent` 派进来的真事件 | 每形态 10/10 腿、198 条断言、0 失败（另有 2 条是阴性自证腿**设计里**的红）；root 5279 与 Pages 前缀 5280 各跑一遍 |

一条命令跑全部（三道静态门 + 八套逻辑 RESULT 行 + 标定样本上的难度实测，本机 2026-09-29 实测 46s）：

```
npm test          # = node tools/check.mjs
```

`RESULT check ok=true checks=56 fails=0` 是这一轮的结论行。门禁自己也在被测：它把每套套件
**自报的 RESULT 行原样再念一遍**，所以"少跑了一套"在 CI 日志里读得出来；八套的标签必须两两不同。

单独跑：

```
node tools/check.mjs              # 总门
node tools/balance.mjs            # 难度实测（每档 150 次 attempt）
node tools/balance.mjs --dose     # 往线上注入不可能的假值，看闸咬不咬（6 条必须全咬）
node tools/generator-probe.mjs    # 观测器：只打账，不判
node tools/fixtures.js             # 夹具自检（手写推理自己站不站得住）
```

浏览器闸要真 Chrome 和 node ≥22（裸 CDP 用的是全局 `WebSocket`/`fetch`），两种 URL 形态各跑一遍，
本机 2026-09-29 实测每形态约 10 秒：

```
npm run verify                                # = bash tools/verify.sh（root 5279 + Pages 前缀 5280，十腿各一遍）
SHAPES=root bash tools/verify.sh              # 改东西时先只跑一种形态
LEGS="boot-url store" SHAPES=root bash tools/verify.sh
SABOTAGE=1 SHAPES=root LEGS="boot-url" bash tools/verify.sh   # 闸的阴性自证：改错一位期望值必须红且 rc≠0
npm start                                     # 自己开 root 形态（5279）看盘
npm run prefix                                # 自己开 Pages 前缀形态（5280/z-biz-game-norinori-cos/）
```

结尾那一行 `=== ALL GREEN（这一跑实际覆盖的 URL 形态：root prefix）===` 才是结论：
少跑一种形态，这一行会把实际跑过的那一种写出来。腿清单、每条腿**该交回的断言条数**、
以及"该有几条设计里的红"都钉死在 `tools/verify.sh` 里 —— 腿还在但断言少了一半，
是这一族最静默的一种坏法，所以条数不对就是红。

## 目录

```
js/engine/   counter.js generate.js grid.js partition.js rng.js solver.js   ← 纯 ESM，零运行时依赖
js/          main.js（页面装配 + window.norinori 那张闸用的脸）store.js（一个 localStorage 键）
             theme.js（几何与颜色的唯一数字源）gen-worker.js（出题在另一条线程，主线程只收进度）
js/ui/       game.js（局面：落子/撤销/判定，判定交回引擎）
js/render/   board.js（一块画布、一份几何：draw 算出的 geo 就是 hitCell/centerOf/pixelAt 用的那一份）
css/game.css index.html     server.cjs（本地静态服务，root 与 Pages 前缀两种形态都由它服务）
tools/       check.mjs（总门）rule-test counter-test solver-test generate-test
             fixtures.js（夹具）generator-probe.mjs（观测）balance.mjs（难度实测）
             verify.sh（浏览器闸）playtest.cjs（裸 CDP 驱动）scenarios.js（页内场景）
tests/       r1-equiv.test.mjs counter-agree.test.mjs shipping.test.mjs     ← 三张证人
```

引擎不许 `import` `tools/` 下的任何东西，也不许出现 `Math.random`、`Date`、`performance.now`、
`process.env`、`require(`、`node:` ——`tools/check.mjs` 用三道静态门在读源码的那一层打死它们。
理由都在 `DESIGN.md` 第二、八节。

界面层用 `performance.now()` 计"这一局想了多久"、用 `Date.now()` 给存档打写入时刻 ——
禁词门只扫 `js/engine/`，因为这两个读数都不进判定路径：`js/store.js` 不 import 引擎、
自己不发第二套"合法"的定义，页面上的判定全部交回 `js/engine/grid.js`（这一层的分工与
两条真落盘 bug 记在 `DESIGN.md` 第十节）。

## 这个仓**不承诺**什么

- **不承诺白格连通**。经典 No-Nothing/Nurikabe 那条"所有白格必须连成一块"不是のりのり的规则，
  我们不加：`tests/r1-equiv.test.mjs` 里有一张四块孤白但完全合法的证人盘，`checkSolution` 判 ok。
- **不承诺 8×8 以上**。唯一性证明靠穷举，≤6×6 付得起（6x6 数穿一棵树 17ms），更大尺寸上
  按号序的树会撞预算。见 `DESIGN.md` 第九节。
- **不承诺"看起来难"**。难度只用链条轮数、落子步数、证明结点三个量说话，
  而且实测发现链深这一维在五档上有三档并列（p50 都是 9），所以梯子必须三维一起判。
- **不承诺出货很快**。硬骨档（6×6）实测出货率 4.7~4.0%，一次 attempt 的墙钟 p95 是 0.6~0.8 秒、
  最慢一次 2.3 秒。界面把它当成事实处理（`js/gen-worker.js` 异步生成 + 进度读数，`reproof` 腿里
  hard 那张实测 ~1 秒），不是把线抬上去的理由。

## 端口

5279（root 形态：仓库自己就是文档根）/ 5280（Pages 形态：仓库挂在 `/z-biz-game-norinori-cos/`
这一段下，用的还是产品自己那份 `server.cjs`）/ 9379（CDP），与同族其它仓不撞。
跑 `bash tools/verify.sh` 的时候这三个口真的在听；口被占就往后挪并打印"谁在听这一口"，
**绝不借别人已经绑上的 socket** —— 借来的端口会发出另一个应用的 `index.html`，
而"页面加载成功了"分不清这件事，所以预检按字节比对磁盘上的 13 个模块。
