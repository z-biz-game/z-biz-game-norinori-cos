#!/usr/bin/env bash
# 第五道闸（浏览器闸）· 乗りのり Norinori：真 headless Chrome、真 DOM、真 localStorage、真指针、真键盘
# —— 两种 URL 形态各跑一遍：
#
#   ① root    http://127.0.0.1:5279/                        (server.cjs：仓库自己就是文档根)
#   ② prefix  http://127.0.0.1:5280/z-biz-game-norinori-cos/ (GitHub Pages 的形状，对应
#                                                             https://z-biz-game.github.io/z-biz-game-norinori-cos/)
#
#   bash tools/verify.sh                    # 两种形态、全部腿
#   SHAPES=root bash tools/verify.sh        # 改东西时先只跑一种
#   LEGS="boot-url store" SHAPES=root bash tools/verify.sh
#   WEB_PORT=5279 CDP_PORT=9379 bash tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-norinori-cos/ bash tools/verify.sh
#                              # 部署件：只跑这一种形态，本脚本不起任何服务（发布后手跑，不进 CI）
#   SABOTAGE=1 SHAPES=root LEGS="boot-url" bash tools/verify.sh
#                              # 闸的阴性自证：把 node 证人里"界面那行尝试次数"改错一位 ⇒ 必须红且 rc≠0
#
# 为什么前缀形态必须单跑一遍而不是写进脚注：根形态是唯一一种能被本地服务器"蒙对"的形态。
# 斜杠开头的说明符在仓库=文档根时解得开，挂在 /<repo>/ 下就 404；而抛出来的 dynamic import 会把整段
# 注入脚本一起带沉，于是部署站点静默地只跑了一小部分断言。tools/scenarios.js 里那个 mod() 特意按
# document.baseURI 解析（import(new URL(rel, baseURI))），只有前缀那一跑能看见它到底解没解错。
#
# 端口是本仓的，不是家族的公共汽车：root web 5279 / 前缀 web 5280 / CDP 9379。
# 被占了就往后挪并打印"谁在听这一口"，绝不借别人已经绑上的 socket —— 借来的端口会发出**另一个应用**
# 的 index.html，而"页面加载成功了"分不清这件事，所以预检按字节比对磁盘上的模块。
#
# 每一条形态都用**自己新 mktemp 出来的 Chrome profile**：profile 里带着上一形态的 localStorage 与
# 磁盘缓存，跨形态复用会把"首屏/续档"的读数变成别人的历史。模板写全，不用 `mktemp -d -t`。
#
# Chrome 那三个 --disable-*-throttling 不是为了跑得快：reproof 腿拿页面心跳当"主线程没被钉住"的证人，
# 后台标签页的定时器会被对齐到分钟级，那种读数量的是 Chrome 的策略而不是我们的代码。
# 判据仍然是一条**比例**（见 scenarios.js 里那条注释），标志位只让这台机器与 CI 那台读得一样。
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader：软件光栅会把每一核
# 占满，而且没有 CDP 客户端时 Chrome 自己不会退出。本闸有一半断言在拿画布像素与 DOM 读数对账，
# 假光栅会让这些读数说谎。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(basename "$HERE")                     # Pages 的路径段，与仓库同名
FEATURE=乗りのり                              # 本仓自己的词：证明在检的字节是我们的
CDP_WANT=${CDP_PORT:-9379}
WEB_WANT=${WEB_PORT:-5279}
PREF_WANT=${PREFIX_PORT:-5280}
CHROME=${CHROME_BIN:-}
SABOTAGE=${SABOTAGE:-0}

# js/main.js 的默认盘（DEFAULT_TIER/DEFAULT_SEED）。**不是按日期算的**：boot-default 那条腿
# 判的就是"换一局不会让首屏跟着今天变"，所以这两个数写死在这里、由 node 证人现算同一张盘。
DEFAULT_TIER=easy; DEFAULT_SEED=20260929
# boot-url 故意换一个**跟默认不同档**的盘：这样"首屏是 URL 决定的"才是正面证据而不是巧合。
URL_TIER=tricky; URL_SEED=20260931
# 指针腿／键盘腿／续局腿共用的那张盘：出货 attempts=5，5×4，走完它要 20 次真点击。
PLAY_TIER=easy; PLAY_SEED=20260929
# 出货对照腿的样本：四档各一张，其中 hard 那张实测 ~1 秒（页面心跳因此有得跳；
# 只挑 warmup/easy 的话单张十几毫秒，"心跳比例"那条证人就退化成量定时器对齐）。
REPROOF_SAMPLES='{"samples":[{"tier":"warmup","seed":20260929},{"tier":"easy","seed":20260930},{"tier":"tricky","seed":20260931},{"tier":"hard","seed":20260931}]}'
# 每条形态的腿清单。少交一回结果就是悄悄少跑，所以条数按腿钉死（见 want_checks）。
LEGS_DONE=${LEGS:-"boot-default boot-url render pointer keyboard sizes store resume resumefrag reproof"}

if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
command -v python3 >/dev/null 2>&1 || { echo "需要 python3（RESULT 行的解析）" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "需要 node（≥22：裸 CDP 驱动用全局 WebSocket/fetch）" >&2; exit 2; }
{ command -v "$CHROME" >/dev/null 2>&1 || [ -x "$CHROME" ]; } || {
  echo "no Chrome found — 试过的路径：" >&2
  echo "  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome" >&2
  echo "  CHROME_BIN=/path/to/chrome bash tools/verify.sh" >&2
  exit 2; }

# 日志与 profile 落点：不写 /tmp 根 —— 这一台机器上有别的 agent 同时在跑 Chrome。
# 默认落在 $TMPDIR（macOS 是每用户私有的 /var/folders/...，Linux runner 上退到 /tmp）。
LOGDIR=${VERIFY_LOG_DIR:-"${TMPDIR:-/tmp}/norinori-verify"}
mkdir -p "$LOGDIR" || { echo "日志目录 $LOGDIR 建不起来" >&2; exit 2; }
rm -f "$LOGDIR"/*.tally "$LOGDIR"/*.extra.json 2>/dev/null

# ---- ports ---------------------------------------------------------------------------------------
occupied() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
squatters() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' '; }
first_free() {
  local base=$1 p
  for p in "$base" $((base + 1)) $((base + 100)) $((base + 200)); do
    if occupied "$p"; then
      echo "  端口 $p 已被别的进程听着（pid: $(squatters "$p")）——不借它的 socket，换下一个" >&2
    else
      echo "$p"; return 0
    fi
  done
  return 1
}

CUSTOM=0
[ -n "${BASE_URL:-}" ] && CUSTOM=1
if [ "$CUSTOM" = 0 ]; then
  CDP=$(first_free "$CDP_WANT") || { echo "no free devtools port near $CDP_WANT" >&2; exit 2; }
  WEB=$(first_free "$WEB_WANT") || { echo "no free http port near $WEB_WANT" >&2; exit 2; }
  PREF=$(first_free "$PREF_WANT") || { echo "no free http port near $PREF_WANT" >&2; exit 2; }
  echo "ports: CDP $CDP (want $CDP_WANT) · root web $WEB (want $WEB_WANT) · prefix web $PREF (want $PREF_WANT)"
  echo "  两种形态各用一个 HTTP 端口：origin 不同 ⇒ localStorage 各一套；Chrome/profile 按形态各一份，该形态的腿共用"
else
  CDP=${CDP_PORT:-$CDP_WANT}
  echo "BASE_URL given → 只跑部署件这一种形态，本脚本不起任何服务（CDP $CDP）"
fi
echo "logs: $LOGDIR"
[ "$SABOTAGE" = 1 ] && echo "SABOTAGE=1 → 只把 boot 腿证人里的尝试次数改错一位：这一跑**必须**在那一条上红，绿了就是闸没咬住"
echo "loadavg（跑之前的读数，本机可能同时坐着别的 agent）：$(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg)"

FAILED=0
WANT_N=$(echo "$LEGS_DONE" | wc -w | tr -d ' ')

# ---- machine-readable RESULT line ----------------------------------------------------------------
# playtest.cjs 把 RESULT 打在 stdout 最后一行、console 噪音留在 stderr。这里不数行数就不叫跑过：
# 一条断言都没发生的场景（页面启动失败、import 404、场景被改名）会以"0 failed"的样子绿过去。
# want_fail 是这条腿**设计里的红**的条数：只有阴性自证那条腿是 2，其余全是 0。
# 下划线前缀的键 = 墙上时钟/环境读数，落 .extra.json 供复验，绝不进 stdout（三连跑逐字节 diff 的判据）。
PARSE=$(cat <<'PARSER'
import sys, json
shape, scn, tally, extra_path, want_fail = sys.argv[1:6]
want_fail = int(want_fail)
raw = sys.stdin.read().strip()
if raw.startswith('RESULT '):
    raw = raw[len('RESULT '):]
if not raw:
    print('  NO RESULT —— playtest.cjs 什么都没回（见同目录的 .console.log）'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
rows = d.get('rows')
if rows is None:
    print('  NO RESULT FIELD —— 回的东西不是闸的口径:', str(d)[:300]); sys.exit(1)
if not rows:
    print('  NO CHECKS RUN —— 一条都不断言的场景没有资格是绿的'); sys.exit(1)
fail = int(d.get('fail', 0))
for r in rows:
    if not r['pass']:
        tag = 'RED-BY-DESIGN' if want_fail else 'FAIL'
        print('  %s %-58s %s' % (tag, r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
stable = {k: v for k, v in extra.items() if not k.startswith('_')}
with open(tally, 'w') as f:
    f.write('%d %d\n' % (len(rows), fail))
with open(extra_path, 'w') as f:
    json.dump(extra, f)
print('  %d checks, %d failed  %s' % (len(rows), fail, json.dumps(stable, ensure_ascii=False)[:400]))
if fail != want_fail:
    if want_fail:
        print('  这条腿是阴性自证：要恰好 %d 条红，实到 %d 条 —— 少了就是闸没咬住，多了就是别的东西坏了' % (want_fail, fail))
    sys.exit(1)
sys.exit(0)
PARSER
)

# ---- pre-flight: 即将被检的那几字节就是本仓 ---------------------------------------------------------
# 端口上坐着*别的*东西是这个闸存在的意义；"页面加载了"不够 —— SPA fallback、目录列表、孤儿 checkout
# 都能让场景跑起来，只是对着更少的文件跑。所以每个模块路径都要求 200 **且**字节数与磁盘一致。
PREFLIGHT_RELS="index.html css/game.css js/main.js js/store.js js/gen-worker.js js/theme.js \
js/ui/game.js js/render/board.js js/engine/rng.js js/engine/grid.js js/engine/counter.js \
js/engine/solver.js js/engine/generate.js"
preflight() {
  local base=$1 rel want got f served
  served=$(curl -fsS -m 8 "$base" 2>/dev/null) || { echo "  首页取不到：$base" >&2; return 1; }
  case "$served" in *js/main.js*) ;; *) echo "  $base 上发的不是本仓的首页（正文里找不到 js/main.js）" >&2; return 1 ;; esac
  case "$served" in *"$FEATURE"*) ;; *) echo "  $base 在发别的应用：首页正文里找不到「$FEATURE」" >&2; return 1 ;; esac
  for rel in $PREFLIGHT_RELS; do
    want=$(wc -c < "$HERE/$rel" | tr -d ' ')
    [ -n "$want" ] || { echo "  $rel 在磁盘上读不到，闸没有可对的基准" >&2; return 1; }
    f="$LOGDIR/preflight-$(echo "$rel" | tr '/' '_')"
    got=$(curl -sS -m 8 -o "$f" -w '%{http_code} %{size_download}' "$base$rel" 2>/dev/null) || {
      echo "  $rel 取不回来：$base$rel" >&2; return 1; }
    case "$got" in "200 $want") ;; *)
      echo "  $rel 不对味：$base$rel 回 $got，磁盘上的这份是 200 $want 字节" >&2
      echo "  前两行到手内容：$(head -c 160 "$f" | tr '\n' ' ')" >&2
      return 1 ;; esac
  done
  echo "  预检：首页含「$FEATURE」与 js/main.js · $(echo $PREFLIGHT_RELS | wc -w | tr -d ' ') 条真实模块路径按字节对上磁盘"
  return 0
}

# 每条腿应当交回的断言条数。钉死它是因为"腿还在、断言少了一半"是这一族最静默的一种坏法：
# 场景里一个 import 抛掉、一个回合没走、一条分支没进 —— tally 都会照常交出一个 0 failed。
want_checks() {
  case "$1" in
    boot)      echo 29 ;;
    render)    echo 11 ;;
    pointer)   echo 27 ;;
    keyboard)  echo 10 ;;
    sizes)     echo 40 ;;
    store)     echo 15 ;;
    resume)    echo 22 ;;
    resumefrag) echo 2 ;;
    reproof)   echo 13 ;;
    *)         echo 0 ;;
  esac
}

start_chrome() {                  # 每一条**形态**一个新 profile、一个新 Chrome（tag 就是形态名）
  # 为什么按形态而不是按腿：这一形态的 localStorage 不许是上一形态写的，而 Chrome 起停是这条闸
  # 最贵的一段（按腿起停 ≈ 多烧 10 次）。代价是同形态各条腿共用一份档，于是"谁写的档谁收尾"成了
  # 纪律：store / resume 两条腿在腿内自己先 clearStore()；boot-default 那条"新 profile 上无档可续"
  # 靠的是下面 run_shape 里那句「先把 tab 停在 404 上、应用页一次都没跑过」+ 它排在清单最前。
  local tag=$1
  UDD=$(mktemp -d "${TMPDIR:-/tmp}/norinori.${tag}.XXXXXXXX") || { echo "profile 建不起来" >&2; return 1; }
  "$CHROME" --headless=new --remote-debugging-port=$CDP --user-data-dir="$UDD" \
    --window-size=1280,1024 --no-first-run --no-default-browser-check \
    --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows about:blank \
    >"$LOGDIR/chrome-$tag.log" 2>&1 &
  CPID=$!
  for i in $(seq 1 120); do
    curl -fsS -m 1 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "devtools never bound on :$CDP (see $LOGDIR/chrome-$tag.log)" >&2
  return 3
}
stop_chrome() {
  [ -n "${CPID:-}" ] && { kill "$CPID" 2>/dev/null; wait "$CPID" 2>/dev/null; }
  [ -n "${UDD:-}" ] && rm -rf "$UDD"
  CPID=""; UDD=""
  return 0
}

# run_leg <shape> <leg> —— 腿名到"场景 / mode / 导航 URL / node 期望"的那张表在这里，只有一处。
run_leg() {
  local shape=$1 leg=$2 base=$3 s expect='' nav='' mode=scenario want_fail=0
  s=$leg
  case "$leg" in
    boot-default)
      # 裸 URL：这一腿判的是"没有查询串的时候，界面凭什么开这一张盘"，见 js/main.js 的 DEFAULT_SEED。
      s=boot
      nav="$base"
      expect=$(node tools/playtest.cjs witness "$DEFAULT_TIER" "$DEFAULT_SEED" \
        | python3 -c 'import sys,json;d=json.load(sys.stdin);d["via"]="default";print(json.dumps(d))') \
        || { echo "  node 证人起不来（$DEFAULT_TIER/$DEFAULT_SEED）" >&2; RUNBAD=1; return; }
      ;;
    boot-url)
      s=boot
      nav="${base}?tier=${URL_TIER}&seed=${URL_SEED}"
      expect=$(node tools/playtest.cjs witness "$URL_TIER" "$URL_SEED") \
        || { echo "  node 证人起不来（$URL_TIER/$URL_SEED）" >&2; RUNBAD=1; return; }
      ;;
    render)
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$(node tools/playtest.cjs witness "$PLAY_TIER" "$PLAY_SEED") \
        || { echo "  node 证人起不来（$PLAY_TIER/$PLAY_SEED）" >&2; RUNBAD=1; return; }
      ;;
    pointer|keyboard|resume)
      mode=interact
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$(node tools/playtest.cjs witness "$PLAY_TIER" "$PLAY_SEED") \
        || { echo "  node 证人起不来（$PLAY_TIER/$PLAY_SEED）" >&2; RUNBAD=1; return; }
      ;;
    resumefrag)
      # 阴性自证：同文档只换 #fragment 的那一跳**不是**导航，所以"换了文档/走了存档路径"两条证人
      # 必须红。这一腿绿了才要担心：那说明闸把片段跳转当成了刷新。
      mode=interact
      want_fail=2
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$(node tools/playtest.cjs witness "$PLAY_TIER" "$PLAY_SEED") \
        || { echo "  node 证人起不来（$PLAY_TIER/$PLAY_SEED）" >&2; RUNBAD=1; return; }
      ;;
    sizes|store)
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$(node tools/playtest.cjs witness "$PLAY_TIER" "$PLAY_SEED") \
        || { echo "  node 证人起不来（$PLAY_TIER/$PLAY_SEED）" >&2; RUNBAD=1; return; }
      ;;
    reproof)
      nav="${base}?tier=${PLAY_TIER}&seed=${PLAY_SEED}"
      expect=$REPROOF_SAMPLES
      ;;
    *) echo "  不认识这条腿：$leg" >&2; RUNBAD=1; return ;;
  esac
  local tally extra clog n m wc_
  tally="$LOGDIR/$shape-$s.tally"; extra="$LOGDIR/$shape-$s.extra.json"; clog="$LOGDIR/$shape-$s.console.log"
  rm -f "$tally" "$extra"
  echo "=== [$shape] $s (mode $mode, nav $nav) ==="
  MAX_ROUNDS=${MAX_ROUNDS:-12} NAV_URL=$nav node tools/playtest.cjs "$mode" "$s" "$expect" 2>"$clog" | tail -1 \
    | python3 -c "$PARSE" "$shape" "$s" "$tally" "$extra" "$want_fail" || RUNBAD=1
  if [ -s "$tally" ]; then
    read -r n m < "$tally"
    wc_=$(want_checks "$s")
    REPORTED=$((REPORTED + 1)); CHECKS=$((CHECKS + n))
    if [ "$wc_" != "0" ] && [ "$n" != "$wc_" ]; then
      echo "  条数不对：$s 交回 $n 条，清单钉的是 $wc_ 条 —— 腿还在但断言少了一截，不能算绿" >&2
      RUNBAD=1
    fi
    if [ "$m" != "$want_fail" ]; then FAILS=$((FAILS + m)); else DESIGN_RED=$((DESIGN_RED + m)); fi
  else
    RUNBAD=1
    echo "  没有 tally：$s 这一跑连条数都没交出来，不能算跑过"
  fi
  if [ -s "$clog" ]; then
    echo "  --- console (tail 6) ---"
    sed 's/^/  /' "$clog" | tail -6
  fi
  return 0
}

# ---- one shape -----------------------------------------------------------------------------------
run_shape() {
  local shape=$1 base s
  local t0 t1
  t0=$SECONDS
  REPORTED=0; CHECKS=0; FAILS=0; DESIGN_RED=0; RUNBAD=0
  SPID=0; PPID2=0
  if [ "$CUSTOM" = 1 ]; then
    base=$BASE_URL
  elif [ "$shape" = root ]; then
    base="http://127.0.0.1:$WEB/"
    PORT=$WEB node "$HERE/server.cjs" >"$LOGDIR/$shape-server.log" 2>&1 &
    SPID=$!
  else
    # Pages 形状：仓库挂在**一个路径段**下。用的就是产品自己那份 server.cjs（PREFIX=/$REPO），
    # 不另起一个 python 服务器 —— 生产怎么服务，闸就怎么服务，裸 / 404 这类形状差异才有意义。
    base="http://127.0.0.1:$PREF/$REPO/"
    PREFIX="/$REPO" PORT=$PREF node "$HERE/server.cjs" >"$LOGDIR/$shape-server.log" 2>&1 &
    PPID2=$!
  fi
  export CDP_PORT=$CDP
  export BASE_URL=$base
  start_chrome "$shape" || return 5
  if [ "$CUSTOM" = 0 ]; then
    for i in $(seq 1 40); do curl -fsS -m 1 "$base" >/dev/null 2>&1 && break; sleep 0.25; done
  fi
  echo
  echo "################ shape=$shape  base=$base  (CDP :$CDP, profile $UDD)"
  preflight "$base" || return 2

  # 先在一个**本 origin 的 404 路径**上把 tab 拉起来：origin 对得上 ⇒ 后面的腿复用这个 tab，
  # 而应用页一次都没跑过 ⇒ norinori.save.v1 还是空的，boot-default 那一段"新 profile 上无档可续"
  # 才是真的（直接 open 首页就会把当前盘写进存档，那段断言就变成在验自己刚写的档）。
  node tools/playtest.cjs open "${base}norinori-probe-404" | head -2

  for s in $LEGS_DONE; do
    run_leg "$shape" "$s" "$base"
  done

  t1=$((SECONDS - t0))
  echo "---- shape=$shape 汇总: $REPORTED/$WANT_N legs reported · $CHECKS checks · $FAILS failed（另有 $DESIGN_RED 条是阴性自证腿设计里的红）----"
  # 墙上时间单独一行：它是**这台机器的读数**，不是闸的读数。混在汇总那一行里，
  # "同一条命令连跑两次逐字节 diff 为空"就永远做不到。
  echo "     本形态墙上耗时 ${t1}s（机器相关读数，不参与逐字节对账）"
  if [ "$REPORTED" != "$WANT_N" ]; then
    echo "  少了一段腿交回结果：清单要 $WANT_N 段，只收到 $REPORTED 段 —— 悄悄少跑不能算绿" >&2
    RUNBAD=1
  fi
  [ "$RUNBAD" = 0 ] || FAILED=1
  stop_chrome
  [ "$SPID" != 0 ] && { kill $SPID 2>/dev/null; wait $SPID 2>/dev/null; }
  [ "$PPID2" != 0 ] && { kill $PPID2 2>/dev/null; wait $PPID2 2>/dev/null; }
  SPID=0; PPID2=0
  return $RUNBAD
}

cleanup() {
  # 只杀自己起的那几个 pid；别的 agent 的 Chrome / 服务器一律不动。
  # 看门狗也要在这里杀掉：脚本中途 die 时若留着它，它会在超时后拿一份早失效的 pid 表再跑一次
  # cleanup —— 那些 pid 号可能已被系统回收给别人。
  [ -n "${WD:-}" ] && kill "$WD" 2>/dev/null
  [ "${SPID:-0}" != 0 ] && kill $SPID 2>/dev/null
  [ "${PPID2:-0}" != 0 ] && kill $PPID2 2>/dev/null
  stop_chrome
  return 0
}
trap cleanup EXIT
# 看门狗自己重定向 fd：后台子 shell 会继承本脚本的 stdout，在管道里它会把写端一直攥着不放。
# 预算是"别替闸作决定"，不是打分：把它调大不会让一条红的闸变绿。
# 十腿 × 两形态：指针腿 6 个回合 27 次真点击（含两次换笔、一次同格擦除、一次被卡片挡住的）、
# 续局腿两次真导航、reproof 腿四张盘（hard 那张 ~1s）。
( sleep ${WD_TIMEOUT:-1800}; echo "watchdog 到点：闸还没跑完" >&2; WD=; cleanup; exit 4 ) </dev/null >/dev/null 2>&1 &
WD=$!

cd "$HERE" || exit 2
SHAPE_LIST="root prefix"
[ "$CUSTOM" = 1 ] && SHAPE_LIST=custom
RAN=""
for shape in ${SHAPES:-$SHAPE_LIST}; do
  RAN="$RAN $shape"
  run_shape "$shape" || FAILED=1
done

kill $WD 2>/dev/null
wait $WD 2>/dev/null      # 不收掉就会在结尾打印一行 "Terminated: 15 ( sleep … )"，绿跑看起来像坏了
WD=                       # 已回收：别让 EXIT trap 去杀一个可能已经属于别人的 pid
echo "loadavg（这一跑结束时）：$(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg)"
echo "chrome: $("$CHROME" --version 2>/dev/null) · node: $(node --version)"
[ "$SABOTAGE" = 1 ] && echo "=== 阴性自证这一跑：期望被故意改错，上面必须有 FAIL 且**退出码非 0** ==="
[ $FAILED -eq 0 ] && echo "=== ALL GREEN（这一跑实际覆盖的 URL 形态：${RAN# }）===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
