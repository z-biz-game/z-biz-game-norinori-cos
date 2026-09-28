# 乗りのり / Norinori

Nikoli 的二格区域涂黑：题面给你一张**已经切好区域的盘面**（粗线围出来的块，不是要求解的东西），
你要选出一些格子涂黑，满足两条：

1. **每块区域恰好两颗黑格**（不多不少）。
2. **黑格两两成对**：每一颗黑格必须恰好与一颗黑格上下左右相邻，这一对就是一块 1×2 / 2×1 的骨牌。
   骨牌**可以跨过区域边界**（跨出去以后两块区域各出一颗），但两块骨牌不许共边（可以共角）。

没有第三条：白格不需要连成一片，不要求对称，没有全局连通约束。
规则原文钉在 `DESIGN.md` 第一节（两条英文出处逐字抄在那里），因为"骨牌可跨区域"和"白格连通"
这两点正是网上大多数转述会写反的地方 —— 写反一条，出货的盘就不是同一个谜题。

**本仓现在只交付第一阶段：引擎与门禁。没有 `index.html`、没有 `server.cjs`、没有 CI workflow、没上线**
——没写的东西不进清单，`package.json` 里也就没有它们的脚本。第二阶段发浏览器壳（端口对 5279/9379），
第三阶段接 `.github/workflows/{ci,pages}.yml`。

---

## 四条承诺，每条都是一条会红的命令

| 承诺 | 谁在判 | 现在的读数 |
| --- | --- | --- |
| 出货的每一盘**零猜测**能推到底 | `tools/solver-test.mjs` ①（每档 8 张出货盘 `solve` 到 `unknown=0`）＋ `tools/generate-test.mjs`（出货门：`run.complete` 是出货前提） | 40 张全推到底 |
| 唯一解**由第二套穷举器复核** | `tools/counter-test.mjs`（按区域枚举 vs 整盘位暴力，80 张 4x4 剖分逐盘同数）＋ `tests/counter-agree.test.mjs`（再拉第三套暴力枚举，40 张随机剖分三套同数） | 逐盘相同；4x4 里唯一解 4 张、随机 40 张里唯一解 1 张 |
| 提示只给**这一步可证的事实** | `tools/rule-test.mjs`：每条事实都必须被**全部相容解**支持（独立计数器数出来的解集），且提示通道 `deriveOne` 只能念本轮事实集里的那一条 | 147 条断言，夹具 6 张 + 死局 4 张 |
| 难度是**量出来的** | `tools/balance.mjs`：墙钟 p95、证明结点 p95、链深 [p10,p90] 命中、阶梯三维单调 | 277 条断言，每档 150 次 attempt |

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
node tools/scenarios.js           # 夹具自检（手写推理自己站不站得住）
```

## 目录

```
js/engine/   counter.js generate.js grid.js partition.js rng.js solver.js   ← 纯 ESM，零运行时依赖
tools/       check.mjs（总门）rule-test counter-test solver-test generate-test
             scenarios.js（夹具）generator-probe.mjs（观测）balance.mjs（难度实测）
tests/       r1-equiv.test.mjs counter-agree.test.mjs shipping.test.mjs     ← 三张证人
```

引擎不许 `import` `tools/` 下的任何东西，也不许出现 `Math.random`、`Date`、`performance.now`、
`process.env`、`require(`、`node:` ——`tools/check.mjs` 用三道静态门在读源码的那一层打死它们。
理由都在 `DESIGN.md` 第二、八节。

## 这个仓**不承诺**什么

- **不承诺白格连通**。经典 No-Nothing/Nurikabe 那条"所有白格必须连成一块"不是のりのり的规则，
  我们不加：`tests/r1-equiv.test.mjs` 里有一张四块孤白但完全合法的证人盘，`checkSolution` 判 ok。
- **不承诺 8×8 以上**。唯一性证明靠穷举，≤6×6 付得起（6x6 数穿一棵树 17ms），更大尺寸上
  按号序的树会撞预算。见 `DESIGN.md` 第九节。
- **不承诺"看起来难"**。难度只用链条轮数、落子步数、证明结点三个量说话，
  而且实测发现链深这一维在五档上有三档并列（p50 都是 9），所以梯子必须三维一起判。
- **不承诺出货很快**。硬骨档（6×6）实测出货率 4.7~4.0%，一次 attempt 的墙钟 p95 是 0.6~0.8 秒、
  最慢一次 2.3 秒。这是第二阶段界面必须异步生成的原因，不是把线抬上去的理由。

## 端口

第二阶段预留 5279（浏览器壳本地服务）/ 9379（CDP），与同族其它仓不撞。现在还没有东西在听这两个口。
