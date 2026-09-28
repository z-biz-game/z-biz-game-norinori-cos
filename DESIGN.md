# 设计文档 · 乗りのり / Norinori

第一阶段交付的是**引擎与门禁**：`js/engine/` 六个模块、`tools/` 八个文件（总门 + 四套逻辑门 +
夹具自检 + 观测器 + 难度实测）、`tests/` 三张证人。第二阶段在上面叠了**浏览器壳与浏览器闸**
（第十节）。CI workflow 与 Pages 还没写，本文件里凡涉及它们的句子都标成"第三阶段"，不写成既成事实。

本文的每个数字都是本机 2026-09-29 复跑读回来的（Node v26.8.1、darwin arm64、15 核；
浏览器闸那批读数是 Chrome 154.0.8037.57）。复跑方法在最后一节。

---

## 一、规则只有两条，出处逐字抄在这里

Nikoli 官方对のりのり的说法只有两句（立项时抄进 `js/engine/grid.js` 文件头，那是本仓判定的唯一依据）：

> 1. Place blocks in twos in consecutive black squares.
> 2. Each area surrounded by bold lines must contain two black squares.

cross+A 的规则页把它展开成可判定的三句（本轮抓到的中文原文，逐字）：

> 在每个宫格必要黑漫两个方格。黑漫方格必须形成 2×1 或 1×2（骨牌）组，**不分区域限度**。
> 两个黑色的方格别相接触（但是它们的角能相接触）。
> —— https://www.cross-plus-a.com/cn/puzzles.htm

于是本仓的可执行口径是四句，`js/engine/grid.js` 的 `checkSolution` 逐句实现：

1. 每块区域**恰好**两颗黑格（多了、少了都红）。
2. 每颗黑格属于一个 1×2 / 2×1 骨牌，**骨牌可以跨过区域边界**（跨出去时两块区域各出一颗）。
3. 两块骨牌**不得共边**。
4. 可以共角。

**两个源都没有"白格必须连通"这一条**，所以本仓不实现它、不拿它当判据、也不拿它当"隐性规则"。
这条不是偷懒：加一条没来源的规则，穷举器就会去否掉真合法的解，那是一条会说谎的红线。
`tests/r1-equiv.test.mjs` 里钉了一张证人盘（四块孤立白格、两条规则全满足、`checkSolution` 判 ok），
它存在的意义就是"如果哪天有人把连通加进判定，这张盘会立刻红"。

第 2 句和第 1 句打架的地方就是推理的全部来源：跨界的骨牌会让两块区域各出一颗黑格，
而这两颗是同一颗格子的两个身份。

## 二、三套互不信任的代码，界线按"出货要不要它"划

| 层 | 文件 | 干什么 | 不许干什么 |
| --- | --- | --- | --- |
| 判定 | `js/engine/grid.js` | 两条规则的可执行形式、区域/邻格几何、剖分自洽性 | 不许搜索、不许猜 |
| 穷举 | `js/engine/counter.js` | 按区域枚举 C(\|R\|,2) 落法，数出**全部**解；`want`/`not` 两种出口 | 不许讲理（不做推理，只数） |
| 推理 | `js/engine/solver.js` | 五条局部规则，零猜测推到底；给提示通道 `deriveOne` | 不许搜索、不许猜、不许读墙钟 |
| 出题 | `js/engine/partition.js` + `generate.js` | 剖分 → 挖到唯一 → 磨到推得动 → 走求解器 → 量难度 | 不许 import `tools/` |
| 随机 | `js/engine/rng.js` | mulberry32 + FNV-1a + 派生子种子，纯 32 位整数 | 不许 `Math.random`、不许时间 |

两套判定必须互不信任才叫复核：`counter.js` 数出来的每条解都要过 `checkSolution`（`tools/rule-test.mjs`
最后一节），反过来 `solver.js` 推出来的终局必须由穷举器证明它是**唯一**那条
（`tools/solver-test.mjs` ①、`tests/shipping.test.mjs`）。

`tools/check.mjs` 的第三道静态门把这条界线钉成会红的线：引擎文件里出现
`from '…tools/'` 或 `from '../'` 就红 —— 夹具的期望值一旦进了判定路径，
"程序是对的"就变成了"夹具是这么写的"。

## 三、R1 的等价式，以及它为什么不靠自己的推理自证

`grid.js` 里所有关于骨牌的判定都走一条等价式：

> "黑格两两成骨牌、骨牌之间不共边" ⟺ "每颗黑格的 4-邻域里**恰好**有一颗黑格"

文件头写了双向的推导（度数论证）。但推导不算证据，所以 `tests/r1-equiv.test.mjs` 拿**另一套**
实现逐盘对账：一个递归骨牌配对枚举器（不用 `r1Violations`、不用度数、只看能不能把黑格两两配成
共边对且配对之间不共边），在 2×2、3×3、4×4 上做**全盘 2^n 逐盘比较**：

```
2x2：16 个落子全比，度数判 5 个成立，骨牌枚举 5 个配得成
3x3：512 个落子全比，度数判 25 个成立，骨牌枚举 25 个配得成
4x4：65536 个落子全比，度数判 314 个成立，骨牌枚举 314 个配得成
```

同文件还钉了几何（角格度数 2、边格 3、内部 4，邻接表顺序 `[1,6,9,4]`）、
剖分四条拒绝路径（长度、区域号断档、单格区域、孤岛区域）、2×2 田字与拐角三格形的区分，
以及 12 张出货盘上"整颗骨牌落在区域内 / 跨界"两种都出得来（整颗 43 块、跨界 17 块）。

## 四、唯一性是一条**穷举证明**，不是一个统计结论

`countByRegion(reg, w, h, { want, not })` 有两种提前收工，语义在 `tools/counter-test.mjs` 里逐条钉住：

- `want` 凑够就收工：返回 `count=null`、`abort:'want'`、`atLeast≥1` —— 这**不是**"只有这么多解"。
- 走完整棵树没凑够：`exhausted=true` 且 `count` 是实数。
- 出题要的是第三种组合：`{ want: 1, not: B }`（B = 造题时那条落子）。挖完之后它返回
  `exhausted && count === 0`，意思是"**除 B 之外，穷举找不到任何一条解**"。
  加上 B 本身全程挪不掉（`tools/solver-test.mjs` ① 逐张断言 `constructed` 一路活到出货），
  这句话读作**恰好一个解**，而且这条读法就是证明本身：探针走完了整棵树。

所以出货路径不在"最后再数一遍唯一性"——挖到 0 条替代的那一步本身就是证明。

三套穷举器逐盘同数是 `tests/counter-agree.test.mjs` 的活：按区域枚举、整盘位暴力、
以及第三套独立暴力枚举，在 40 张随机合法剖分上比**解的条数**并比**解集内容**（排序后逐条比字符串），
其中 1 张唯一解、28 张无解、最多一张 9 条解；两张人手工点解的盘（4 条 / 1 条）也比内容，
而那批解是**人手列出来的**（`tools/fixtures.js` 的 `HAND` 里带着那段推理文字）。
超过 20 格时位暴力枚举器必须**拒绝**而不是给个数（同文件钉住）。

## 五、五条规则，每条一张"这一轮只推得出这一件事"的夹具

| 规则 | 一句话 | 夹具观测（全盘解数 / 与已落子相容 / 本轮事实） |
| --- | --- | --- |
| `R2-FULL` | 区域已经黑满两颗 ⇒ 其余全白 | R2FULL：15 / 5 / 3 条 |
| `R2-LAST` | 区域只剩 N 格可黑而还差 N 颗 ⇒ 全黑 | R2LAST：4 / 4 / 4 条 |
| `PARTNER` | 黑格的未定邻居只剩一个 ⇒ 它必是同伴 | PARTNER：15 / 5 / 1 条 |
| `CLOSED` | 黑格的同伴已定 ⇒ 它其余邻居全白 | CLOSED：1 / 1 / 1 条 |
| `LONER` | 四邻皆白 ⇒ 这格黑下去也等不到同伴，只能白 | LONER：847 / 188 / 1 条 |
| — | 全沉默（需要猜的盘长这样） | SILENT：15 / 15 / **0** 条 |

`tools/rule-test.mjs` 对每张夹具判的是**事实全集相等**，不是"包含期望的那条"：
`deriveFacts` 出来的每条 `(cell, value, rule)` 与手推列表必须逐条同、条数同（多一条也算红）。
并且每条期望事实都要被独立计数器数出的**每一条相容解**支持（`bad.length === 0`）——
这是"提示只给可证事实"的根据：玩家的中间局面本来就是多解的，
R2FULL 那张相容 5 条解、LONER 那张相容 188 条解，规则仍然只说真话。

规则表本身也被判：`RULES` 必须恰好五条、每条都要有夹具为它发声（`rulesProven`）。
死局四张（区域超限、区域饿死、单格挤进两黑、同一轮两种判法）必须报矛盾，
而且**点名位置**必须等于 `where` 里写的那个区域号或格子号，报矛盾时不许再吐事实。

## 六、出货流水线：顺序是有理由的

```
makeShape → digToUnique → polishSolvable → solve → 量难度
（剖分）    （挖到唯一）   （磨到推得动）   （零猜测门）
```

`generate.js` 文件头写了为什么计数器在前、求解器在后：反过来做，需要猜的盘会被 `solve` 判
`incomplete` 直接丢掉，我们就永远量不到"穷举器认为它唯一、但人推不动"这一类 ——
而这一类恰恰是难度梯子上界的来源。

`polishSolvable` 是第四段：光"唯一"不够，还得"推得动"。实测挖通的盘里，polish 之前
`solve` 能推完的比例是 6x4 的 2/7、5x5 的 0/5（`generate.js` 头注），5×5 以上需要猜是多数而不是例外。
`plateau` 必开：关掉它时 5x5/6x6 有 96~97% 的候选刀卡在"这一刀不涨落子数"上，开了它 6x4 是 7/7 全推完。
每挪一刀都重新证明一次唯一（还是 `want:1, not:B` 那条穷举证明），所以磨完的盘不会因为磨而失去证明。

失败出口是**登记过的词汇表**（`generate.js` 的 `KNOWN_REASONS`：`shape` / `not-promising` /
`move-budget` / `no-legal-move` / `needs-guess` / `solver-contradiction` / `solution-invalid` /
`unknown-tier` / `exhausted-attempts`）。`tools/generate-test.mjs` 与 `tools/balance.mjs` 都会为
"出现没登记的原因"直接红 —— 未登记意味着那条丢弃路径没人证过。

## 七、难度是量出来的，而且梯子必须三维一起判

五个档位是尺寸 + 链条深度区间（`js/engine/generate.js` 的 `TIERS`），`maxSize` 一律 ≤5。
实测两件事要分开写：

- `maxSize` 是**可行性**旋钮，不是难度旋钮：同一尺寸下 ≤5 出货 17~33%、≤6 掉到 3~13%，
  6x6 ≤6 直接 0/12（区域太少 → 替代解数超上限，挖不动；这组数在 `generate.js` 头注里）。装不出来的档（6x6 maxSize=3）
  连剖分都长不出来，出货门的失败出口是 `{"shape":3}`。
- 链深这一维**会并列**：`chain` 区间是量出来的 [p10,p90]，实测 p50 在 easy/standard/tricky
  三档都是 9。只有证明结点把五档真正分开。

每档 150 次 attempt 的实测（基准种子 20260932，出货配置本身 = 预算 400,000 结点）：

| 档 | 尺寸 | 出货 | 墙钟 p95 | 最慢一次 | 结点 p95 | 链深 p10/p50/p90 | 档内命中 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warmup | 4x4 | 50/150 = 33.3% | 1.41ms | 6.55ms | 103 | 5/7/7 | 46/50 = 92.0% |
| easy | 5x4 | 24/150 = 16.0% | 2.94ms | 6.59ms | 347 | 7/9/10 | 23/24 = 95.8% |
| standard | 6x4 | 30/150 = 20.0% | 6.41ms | 16.33ms | 1,056 | 7/9/11 | 28/30 = 93.3% |
| tricky | 5x5 | 13/150 = 8.7% | 42.78ms | 96.78ms | 1,604 | 9/9/11 | 13/13 = 100% |
| hard | 6x6 | 7/150 = 4.7% | 584.08ms | 2,346.52ms | 19,491 | 9/12/18 | 6/7 = 85.7% |

同一批种子抽到每档 300 次 attempt 复跑过一遍（出货 103/45/66/22/12 张），
墙钟 p95 1.18 / 3.19 / 7.42 / 41.53 / 773.17ms、结点 p95 103 / 258 / 950 / 1,249 / 19,491，
五条绝对线全部仍然绿。墙钟那两列**不是可重现的数**（同一张表今天与昨天差几个百分点，机器负载不同），
可重现的是结点与链深 —— 它们是纯整数计数。

因此 `tools/balance.mjs` 的阶梯判三条一起判：`TIERS.chain` 端点沿档位不减（配置，不抽样）、
实测链深 p50 沿档位不减且 warmup < hard 严格、**证明结点 med 沿档位严格递增**
（61 → 167 → 406 → 1,033 → 2,451）。第三条才是"相邻档真的更紧"的唯一支撑。
它红了不是把线调松，是把数报给老板。

## 八、门禁的口径纪律（为什么有的判红、有的不评）

`npm test` = `node tools/check.mjs`，五道：

1. **语法门**：`js`、`tools`、`tests` 下所有 `.js/.mjs/.cjs` 逐个 `node --check`（第二阶段之后是 26 个文件），
   外加点名的 `EXTRA_JS=['server.cjs']` 与点名的 shell 入口 `SHELLS=['tools/verify.sh']`（`bash -n`）；
   点了名却不在磁盘上是**一条红**而不是跳过 —— 清单里不许有空头承诺。
   `_tmp-*` 前缀的临时探针跳过但不许进 commit。
2. **禁词门**：引擎七个禁词 `Math.random`、`Date.now`/`new Date`、`performance.now`、`process.env`、
   `require(`、`from 'node:'`、动态 `import('node:'`，**注释外**命中即红。
   为什么静态判而不是"跑一遍看看"：混进一个随机数或环境读取，逻辑测试当天还是全绿的
   （node 恰好有那个变量、随机数恰好站在正确答案那边），红的是三个月后的部署站点或另一台机器。
   本组织真栽过：`sort` 比较器里抽随机数，node 与 Chrome 因此画两张不同的盘。
   墙钟属于 `tools/balance.mjs` 那一层 —— 它是**读数**，永远不是出题的输入。
3. **分层门**：见第二节。
4. **八套逻辑 RESULT 行**：清单点名的五套 + `tools/*-test.mjs` 自动发现 + `tests/*.test.mjs` 自动发现。
   每套必须存在、真跑起来、打出 RESULT 行、**自报名等于由文件名算出的那一个**、`ok=true`、`fails=0`、
   退出码 0、`checks>0`，且收到的行数等于清单长度、标签两两不同。
   为什么数行数：套件被改名、被漏跑、spawn 失败但退出码没传上来，三种都表现为"绿了但少跑一套"。
5. **难度实测**：以**标定样本量**跑 `tools/balance.mjs --samples=150`，除 `ok/fails` 外还断言
   它自报的 `samples=150`、`withheld=0`、`checks ≥ 277`。最后两条是重点 —— 见下面第 ⑥ 条。

`tools/balance.mjs` 自己的六条口径（它的 `--dose` 往线上注入不可能的假值，6 条必须全咬）：

- ① 墙钟一律判 **p95**，绝不判"中位×2"：出题墙钟是双峰的（一次就出货 ≈0.5ms、烧到几十次 ≈90ms+），
  拿中位定基线会一绿一红。基线公式 `band=[max(1,⌊med×0.4⌋), max(lo+1,⌈p95×1.6⌉)]`、
  `budgetMs=max(10,⌈p95×4⌉→10ms)`，每轮把中位/p95/最慢三个绝对值原样打出来。
- ② 绝对线写死（`WALL_P95_LINE_MS`、`PROOF_NODES_P95_LINE`，注释里带实测值）。
  红了只许改尺寸/maxSize/cap/maxMoves 这些**出题配置**，不许抬线、不许把 p95 换成中位、不许删判据。
- ③ 缺线 = 不判 = 漏网：`TIERS` 里每一档必须在两张表里都有自己的线，否则直接红。
- ④ ANTI-DRIFT：写死的线松到实测公式值 2 倍以上 ⇒ 有人在调松线，红。
- ⑤ 阶梯三维：见第七节。
- ⑥ **尾统计量只在标定样本量上评**。这条是本轮补上的，因为它先咬过我：每档 25 次 attempt 时
  tricky 与 hard 各只出货 1 张盘，nearest-rank 分位数塌成"样本里的最大值"，
  于是拿单张盘的链深读出去判"hard 比 tricky 倒挂"，拿被低估的结点 p95（4,282 vs 标定样本量到的
  19,491）去判 ANTI-DRIFT「写死的线太松」—— 50/100 次都在这一条上假红。
  样本不够时这些判据**不假装评过**：计入 `withheld` 并打条幅，RESULT 行自报 `samples=… withheld=…`，
  `tools/check.mjs` 那一边断言 `withheld=0`。所以"把 `--samples` 调小"不是一条省时间的路，
  而"出货率被改崩"在小样本下依然会红（逐档那条 `shipped>=1` 还在，标定样本下再加每档 ≥5 张）。

三张证人的分工与套数也被判：`tests/` 少于 3 张、`tools/*-test.mjs` 少于 4 套、源文件少于 17 个，
都直接红 —— 漏跑比跑红更危险。那个 17 是**第一阶段的账**（引擎 6 + tools 8 + tests 3），
第二阶段的 9 个界面/闸文件只把实测读数抬到 26，下限不动：它是"少文件"的探测器，不是文件清单。

## 九、已知边界（不是 TODO，是口径）

1. **唯一性证明只在 ≤6×6 付得起**。穷举计数器按区域枚举，6x6 数穿一棵树 17ms；
   8×8 上按号序 3,000,000 结点仍数不完（`js/engine/counter.js` 头注）。梯子上界因此是 6×6，
   这不是待办，是这套方法的边界。
2. **`LONER` 在出货路径上一次都没发过声**。40 张出货盘的 `byRule` 总账是
   `R2-LAST:437 CLOSED:458 PARTNER:43 R2-FULL:30`，LONER 零次 ——
   出货盘的密度让"四邻皆白"的格几乎不出现。它的岗位是**玩家中途的局面**：
   夹具那张 847 条解、相容 188 条的盘上它是唯一开口的那条。
   这条是**观测**，`tools/solver-test.mjs` 把它写成 note 而不是红线：
   "一条规则在某个通道上不发声"不该变成阻塞出货的判据。
3. **喂错的落子必须被抓住**：40 张出货盘上把黑格逐张翻错共 54 次，报矛盾 54、停在未定 0、
   推完但不合法 0、推完且合法 0（最后这项必须为 0）。
4. **手解的多解盘推不完，这是明说的边界**：四条解那张 `AACC/CCCC/CCCC/CCBB` 五条规则推到
   10/16 格停住。零猜测承诺只对**出货盘**成立（唯一 + 磨过），不对任意区域剖分成立。
5. **硬骨档出货 4.7%、一次 attempt 最慢 2.3 秒**。界面的处理是**异步生成**（`js/gen-worker.js`
   跑 attempt 链，主线程只收进度并显示"已检查 N 张候选盘"），而不是把线抬上去。
   这条边界还在：生成慢不是 bug，把生成挪回主线程才是。
6. **白格连通不是规则**（第一节）。
7. **还没做的东西**：Electron 壳。"发布之后拿 `BASE_URL=` 手跑一遍部署站点"那一趟已经跑过了，
   读数在第十一节末（这一跑不进 CI，理由也在那一节）。第二、三阶段的入口都已经写在磁盘上并被总门点名
   （`EXTRA_JS`/`SHELLS`，见第八节第 1 条），清单里依旧不许有空头承诺。

## 十、浏览器壳与浏览器闸（第二阶段）

壳不引入第二套真相，四条纪律写在 `js/main.js` 文件头，每一条都有对应的腿在判：

1. **只有一个判定入口**。页面上的"对不对"来自 `js/ui/game.js` 的 `status()`，而它调的是引擎；
   `main.js` 里不许出现第二套"数黑格 / 看骨牌"的代码。`reproof` 腿判的就是这句话：页面 worker
   生成的盘逐张交回 node 证人比剖分与解，四张全对上。
2. **只有一份几何**。画布尺寸、点击命中、格中心坐标全部问 `js/render/board.js` 的同一个 `view`
   对象，`draw` 算出来的 `geo` 就是 `hitCell`/`centerOf`/`pixelAt` 唯一能用的那一份。
   `sizes` 腿在五档上逐格判"格中心命中自己""每格都在画布内""背板像素 = dpr×CSS"，共 40 条。
3. **页面上没有"闸专用"的输入通道**。期望值由 node 经 `window.__expectRaw` 注进来，页面只拿它
   跟自己比，从不照它摆自己的状态；URL 里只认 `?tier=&seed=`。
4. **墙钟只当读数，绝不当输入**。`elapsedMs` 只进面板与存档，种子里不许有 `Date`/`performance`
   —— 引擎那一侧由第二节的禁词门打死，界面这一侧由这条纪律管住（禁词门只扫 `js/engine/`，
   因为界面层的 `performance.now()` 是秒表、`Date.now()` 是存档写入时刻，都不进判定路径）。

### 腿清单（每形态跑一遍，两种形态）

| 腿 | 判什么 | 条数 |
| --- | --- | --- |
| `boot-default` | 裸 URL 开的是 `js/main.js` 里写死的那张盘（**不是按日期算的**），且新 profile 上无档可续 | 29 |
| `boot-url` | `?tier=&seed=` 真的决定首屏，档与盘都跟 node 证人同一张 | 29 |
| `render` | 像素对账：每格中心是按奇偶对上的底纹色（这条同时钉住 `offX/offY/cell`）、粗线只画在剖分不同的地方、细线不许有粗线的颜色、最外圈粗线没被裁掉且外面还留着内边距、四组颜色两两分得开 | 11 |
| `pointer` | 只认 `Input.dispatchMouseEvent` 派进来的 27 下（含换笔与那一下被卡片挡住的）：越界点击不落子、白点逐格对位、同格连点两下是"落黑→擦掉"且擦掉也记一步、落成的是 node 证人那条解、状态行与累计账对得上、推完之后 `document.elementFromPoint` 落在卡片上、卡片上的"换一局"也是真点出来的 | 27 |
| `keyboard` | 键全部由 `Input.dispatchKeyEvent` 派进来（第 0 回合那一下真点击只为把焦点交给画布，且必须不许落子）：方向键挪焦点格、空格落子、两种笔各算一步、`u` 撤回到的是**上一步的值**（那颗白点）而不是"擦干净"、`h` 提示的格必须与页内 import 的引擎事实集同意 | 10 |
| `sizes` | 五档各自的几何与命中（见纪律 2） | 40 |
| `store` | 一个键 `norinori.save.v1`：形状校验、**交来一份对不上的档就这次写入不发生**、坏档读成没档并当场抹掉、档里那份剖分必须引擎认得、版本号不对就当没档 | 15 |
| `resume` | 裸 URL 真导航之后从存档续回同一张盘（剖分逐格同、落子与步数同、撤销是灰的），再单独判"钉住的 URL 优先于存档" | 22 |
| `resumefrag` | **设计里就红**的自证腿：派一次同文档 `#fragment` 跳转，那两条"换过文档 / 走过存档恢复"的断言必须红。红不了就等于续局腿其实没换文档也能过 | 2（红） |
| `reproof` | worker ↔ node 出货对照 + "生成期间主线程没被钉住" | 13 |

每形态 10/10 腿、198 条断言、0 失败（本机 2026-09-29，Chrome 154.0.8037.57，root 与 prefix 各 10 秒左右）。
两种 URL 形态各跑一遍不是仪式感：根形态是唯一一种能被本地服务器"蒙对"的形态 —— 斜杠开头的说明符
在仓库=文档根时解得开，挂在 `/<repo>/` 下就 404，而抛出来的 dynamic import 会把整段注入脚本一起带沉，
于是部署站点静默地只跑了一小部分断言。前缀形态用的就是产品自己那份 `server.cjs`
（`PREFIX=/z-biz-game-norinori-cos PORT=5280`）：生产怎么服务，闸就怎么服务。
`mod()` 特意按 `document.baseURI` 解析，只有前缀那一跑能看见它到底解没解错。

条数按腿钉死（`want_checks`）：腿还在、断言少了一半，是这一族最静默的一种坏法 ——
场景里一个 import 抛掉、一个回合没走、一条分支没进，tally 都会照常交出一个"0 failed"。

### 这一轮闸咬出来的东西

这一轮咬出来的东西分三类：两条**真产品 bug**（都在 `js/store.js`）、三条**闸自己写错的口径**
（取样单位、导航方式、node 侧的 RESULT 行截断）、一条**界面设计的边界**。
没有一条是靠"把断言改绿"消掉的，记在这里是因为它们会再犯：

1. `js/store.js` 的 `okTotals` 拿 `Object.values` 当键名查（应为 `Object.keys`），于是"账"这一形状
   **从来没有通过过校验**：写进去的每次都被拒，读的时候又因为不过被当场抹掉。浏览器第一条真落子就撞上了它。
2. 同一个文件里 `saveResume` 原先写的是 `okResume(r) ? r : null` —— 调用方哪里算错一个字段，
   玩家已有的存档就被这一次静默抹掉，而调用方还拿到过。这就是文件头说的"半对比没有更坏"，
   现在改成对不上的档**这次写入不发生**。
3. `render` 腿第一次取样取到 `null`：`pixelAt` 收的是 client 坐标，而 `geo.offY` 是 canvas 本地量，
   差一个 `pad`。这是页内 API 的口径，不是断言写错；修的是取样点（`canvasBox().top + geo.offY`）。
4. 赢了之后胜利遮罩接走画布的指针事件。这是设计，所以 `pointer` 腿把"重复点击擦除"判在**中途**，
   把"遮罩接住点击 + `document.elementFromPoint` 是遮罩 + 落子数不动"判在终局，再多一次真点击"换一局"。
5. `resume` 腿原先用带查询串的 URL 导航，于是续的是 URL 而不是档（5 条红：`got url / want store`）。
   产品文档写明"钉住的 URL 优先"，所以修的是腿：`tools/playtest.cjs` 加了 `goto:` 真导航模式（`Page.navigate`），
   续档那一跑用裸 URL，优先级本身交给 round 3 单独判。
6. 闸自己也修过一条 node 侧的：`console.log` 在 stdout 被管道接走时是**异步**的，
   紧跟着 `process.exit()` 会把 RESULT 行截掉（表现为空输出 + 没有 tally）。
   现在两条通道都 await `write()` 回调 —— 这条解释了为什么早期 `resumefrag` 的汇总看起来"什么都没跑"。

### "主线程没被钉住"要读成比例，不是次数

这条断言最早写成 `ticks >= samples.length`，量的其实是定时器对齐。改成比例：
`expected = ⌊elapsedMs/25⌋`，判 `expected < 4 || ticks×2 >= expected`。
样本清单里硬留了一张 hard（实测每张盘的生成毫秒：warmup 9 / easy 14 / tricky 59 / **hard 986**）——
只挑 warmup/easy 的话单张十几毫秒，比例判据结构上到不了 4 次心跳，那条断言就变成白断言。
Chrome 那三个 `--disable-*-throttling` 标志不是为了跑得快：后台标签页的定时器会被对齐到分钟级，
那种读数量的是 Chrome 的策略而不是我们的代码；判据是比例，标志位只让这台机器与 CI 那台读得一样。

### 闸的自证与可重现性

- `SABOTAGE=1 SHAPES=root LEGS="boot-url"`：node 证人里"界面那行尝试次数"改错一位 ⇒
  必须红且 `rc≠0`（实测红在 `boot/第几次尝试出货` 与 `boot/界面上的尝试读数 got 2 / want 3` 两条上）。
- 腿清单的顺序也是判据：`LEGS="resume boot-default"` 会让 `boot-default` 红一片并 `rc=1`，
  因为那一腿的"新 profile 上无档可续"靠的是清单最前那句"先把 tab 停在 404 上、应用页一次都没跑过"。
  改坏了会响，不是假绿。
- 同一条命令连跑三次，RESULT 行逐字节 diff 为空（`render` 腿实测）。做到这件事的办法是：
  一切墙上时钟/环境读数都以 `_` 前缀落进 `.extra.json`，绝不进 stdout；判据一条没放宽，挪走的只是时钟。
- 每形态一份**新 `mktemp` 出来的 Chrome profile**：profile 里带着上一形态的 localStorage 与磁盘缓存，
  复用会把"首屏/续档"的读数变成别人的历史。端口被占就往后挪并打印"谁在听这一口"，
  绝不借别人已经绑上的 socket —— 借来的端口会发出**另一个应用**的 `index.html`，
  而"页面加载成功了"分不清这件事，所以预检按字节比对磁盘上的 13 条真实模块路径。

## 十一、CI 覆盖什么、不覆盖什么（第三阶段）

`.github/workflows/ci.yml` 两个 job，`.github/workflows/pages.yml` 一次文件拷贝 + 一发部署。
写它们的时候每条命令都在本机原样跑过一遍（`_tmp-` 脚本，不提交），绿了才进 workflow ——
"只存在于 workflow 的门"是这个家族红过的第二次：本仓首页**有** canvas，直接把兄弟仓那份
`grep -q 'role="grid"'` 抄过来就是一条永远红的死步骤。

**logic job**（node 22）跑 `npm test` 并数 RESULT 行数必须是 **10**（8 套逻辑 + balance + check 自己），
再补三条总门管不到的：

- `js/` 整棵树都不许 `import`/`import(` 指向 `tools/`。这是分层门的**第二套口径**：
  `check.mjs` 那道只扫 `js/engine/`（判定路径），而 Pages 发的字节是 `index.html + css/ + js/`，
  `tools/` 不发 —— 运行时模块去够 `tools/` 要么是线上 404，要么是拿闸的夹具当产品代码。
  正则写的是 import 形状，注释里提一句 `tools/verify.sh` 不算命中。
- 入口接线 17 条：`<canvas` / `id="board"` / `id="win-veil"` / `css/game.css` / `js/main.js`，
  `main.js` → `render/board.js`、`ui/game.js`、`store.js`、`engine/grid.js`、`engine/counter.js`、
  `js/gen-worker.js`，`gen-worker.js` → `engine/generate.js`，`ui/game.js` → `engine/{solver,grid}.js`，
  存档键 `norinori.save.v1` 在 `js/store.js` 与 `tools/scenarios.js` 里是同一个字符串，
  外加 `[hidden]{display:none!important}` 必须站在 CSS 表首。
- 提交里不许有 `_tmp-` 前缀的探针：`check.mjs` 按前缀跳过它们、`.gitignore` 把它们挡住，
  两条合起来等于"没人看过它们"；真出现在 `git ls-files` 里说明有人 `git add -f` 过。

**browser job** 把 `tools/verify.sh` 跑两趟，一共**三种 URL 形状**：

1. `bash tools/verify.sh` —— root 5279 + Pages 前缀 5280，本仓自己那份 `server.cjs` 服务，
   每形态 10/10 腿、198 条断言（本机 2026-09-29 实测两趟都绿）。
2. 一个只装着 `index.html + css/ + js/` 的临时根，由 `python3 -m http.server` 服务，
   `BASE_URL=` 指过去再跑十腿。名单外的四样（`server.cjs`、`tools/fixtures.js`、`tests/`、`*.md`）
   **必须 404**：`tools/fixtures.js` 里躺着每张夹具盘的手推答案，跟着站点上去就等于把答案当静态内容发布。

本机预跑的第三种形状读数：三样 200 / 四样 404 对上，`shape=custom 汇总: 10/10 legs · 198 checks · 0 failed`
（另有 2 条是 `resumefrag` 设计里的红）。

**CI 不跑的四样**，都是明说的选择不是遗漏：

- `SABOTAGE=1`：阴性自证只在开发时手跑。写进 CI 等于每天把闸的坏样子重演一遍，
  而它的价值恰恰在"改错一位期望值必须红且 `rc≠0`"这一句人工确认。
- `tools/balance.mjs --dose`：往线上注入不可能的假值。它判的是线本身，不是出货的盘。
- `--samples=300` 的重量：那是量天花板用的，不是门；写进 CI 就变成每天重测一次结论。
- `BASE_URL=https://z-biz-game.github.io/z-biz-game-norinori-cos/`：**部署件那一跑不进 CI**。
  CI 里的第三种形状是本地模拟，线上还有 Pages 自己的重定向、缓存头与 base path 的真实行为，
  所以发布之后要手跑一次，读数记在本节末尾。

### 首跑读数（远端，2026-09-29，SHA `347deaf`）

两条 workflow 由同一次 push 触发，都是第一次跑：

| run | workflow / job | 读到的东西 |
| --- | --- | --- |
| 36482952006 | CI · logic | 10 行 RESULT 全 `ok=true fails=0`：`rule-test 147 / counter-test 437 / solver-test 1284 / generate-test 763 / fixtures 112 / counter-agree-test 244 / r1-equiv-test 137 / shipping-test 134 / balance 277 (samples=150 withheld=0) / check 56`；三条补门（分层 grep、入口接线 17 条、`_tmp-` 不在 `git ls-files`）都过 |
| 36482952006 | CI · browser | 三种形状各 `10/10 legs reported · 198 checks · 0 failed`，root/prefix 一趟、Pages 名单模拟根一趟，两趟各自 `=== ALL GREEN ===` |
| 36482952105 | Deploy to GitHub Pages | 部署 success，站点根 200 |

runner 上是 Chrome 153.0.8010.52 + node v22.23.2，本机那一跑是 154.0.8037.57 + v26.8.1 ——
断言条数与结论一致，墙钟不一致（runner 每形态 19~29s），这正是第七节说的"绝对毫秒只当读数"。

发布之后手跑的第四趟（真站点，`BASE_URL=… bash tools/verify.sh`，本机）：
`shape=custom 汇总: 10/10 legs reported · 198 checks · 0 failed`，另有 `resumefrag` 那 2 条设计里的红。
产物边界是对线上逐条 curl 判的，不是照 CI 的临时根推的：`/`、`css/game.css`、`js/main.js`、
`js/engine/grid.js`、`js/gen-worker.js` 五样 200；`server.cjs`、`package.json`、`DESIGN.md`、
`README.md`、`tools/verify.sh`、`tools/fixtures.js`、`tests/shipping.test.mjs`、`tools/scenarios.js`
八样 404 —— 手推答案与闸自己的家伙事都不在站点上。

runner 的墙钟**不能与第七节那张本机表对照**：`balance` 的绝对线照判，但那一列读的是 GitHub
那台机器的负载。可重现的是结点与链深这两个纯整数计数。

## 复跑这些数字

```
npm test                                     # 46s：三道静态门 + 八套 RESULT + balance(150/档)
node tools/balance.mjs --samples=300         # 出货率与尾统计量的重量（hard 档要几分钟）
node tools/balance.mjs --samples=150 --dose  # 线的自证：注入 6 条假值必须全咬
node tools/generator-probe.mjs               # 只打账不判
bash tools/verify.sh                         # 浏览器闸：十腿 × 两形态（root 5279 + prefix 5280，CDP 9379）
SHAPES=root bash tools/verify.sh             # 只跑一种形态，改东西时先这样（每形态约 10s）
SABOTAGE=1 SHAPES=root LEGS="boot-url" bash tools/verify.sh   # 闸的阴性自证：必须红且 rc≠0
BASE_URL=https://z-biz-game.github.io/z-biz-game-norinori-cos/ bash tools/verify.sh   # 部署件那一趟（不起服务）
npm run verify:root                          # 同上那条单形态的 npm 别名
```

浏览器闸那批读数**不比逻辑读数更可重现**：它要本机有 Chrome、要一个没被占的 CDP 口，
而 `reproof` 腿里的生成毫秒跟着机器负载走。所以文档里只写"哪种形态跑了几条腿、几条断言、
几条设计里的红"，耗时一律不进 stdout（见第十节）。

改任何出题配置（尺寸、maxSize、cap、maxMoves、budget）之后，两张绝对线表与 `TIERS.chain` 区间
都必须 `--calibrate` 重量再回填；`tools/check.mjs` 里那个 `BALANCE_MIN_CHECKS = 277`
也要跟着改 —— 它是"判据条数只许增不许失踪"的那条线。
