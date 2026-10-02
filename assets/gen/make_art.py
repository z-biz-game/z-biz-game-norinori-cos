#!/usr/bin/env python3
"""乗りのり（Norinori）的美术母图工厂：一条命令重画全部位图资产，产物进仓、脚本也进仓。

为什么自己画而不用组合级图标工厂：`003_辅助能力/polish/script/make_icons.py` 的 MOTIF 表里
没有本仓（`z-biz-game-norinori-cos` 不在键里），拿它跑只会落到一个与玩法无关的随机母题。
のりのり 的视觉身份就是判定本身：**粗线围出的一块区域里恰好两颗黑格，它们成一副骨牌**，
所以母图必须一眼读出"一块区域、两颗一副、第三格是白点"，而不是一个抽象符号。

构图（3×3，从底到顶）：
  1) 和纸底：两色棋格 `(r+c)` 奇偶换色，取 theme.js 的 cellBg / cellBgAlt；
  2) 区域：L 形三格 `(0,0)(0,1)(1,0)`，外沿画 `regionWidth=0.16` 的粗线（`#20242b`），
     区域内部相邻处画 1px 细线（`gridLine`）——题面就是靠这两级线读的；
  3) 骨牌：区域上两格各涂一颗 `#191a1c`，中间留 `blackInset=0.05` 的缝。
     **那条缝就是"两颗"而不是"一条"的证据**，也是本仓画布上同一条数；
  4) 白点与金环：`dotRadius=0.17` 的 `#8b6f3a` 点落在区域第三格（被 `hintRing=0.09`
     的强调金 `#f2c14e` 环住 = "这一格必然是白"），另一颗点在右下角。
     这两样只在 ≥64px 上画：16/32px 上它们只是噪声。

尺寸口径（006_商业化就绪度标准.md §3）：favicon 16/32/48/64、apple-touch-icon 180、
PWA 192/512 + maskable-512、母图 1024、社交卡 1200×630。
另有两张**真的会被画进像素**的纹理：
  textures/paper-256.png  棋盘纸纹（近白、摆幅 0..2/255，画布上用 multiply 叠，
                          亮度最多动 0.8% ⇒ 浏览器闸"每格中心色差 ≤12"照旧成立）
  textures/washi-512.png  页面和纸底纹（CSS body 背景）

随机数走仓内自己实现的 LCG（seed 固定 20260929）而不是 random 的默认播种：
换一台机器、换一个 Python 版本，噪声图必须逐字节可复现，否则"重画一次"就是改资产。

用法：python3 assets/gen/make_art.py [--out <仓根>]
依赖：Pillow（组合级图标工厂用的同一件；本仓**运行时**零依赖不受影响）。
"""
import argparse
import os
import struct

try:
    from PIL import Image, ImageDraw
except ImportError as e:  # pragma: no cover
    raise SystemExit('需要 Pillow（make_icons.py 同一条依赖）：pip install pillow') from e

SEED = 20260929

# 与 js/theme.js 的 Palette 同源：改色要同时改两处，两边的注释互相指着对方。
CELL_BG = (233, 229, 218)      # Palette.cellBg
CELL_BG_ALT = (222, 216, 201)  # Palette.cellBgAlt
PAGE_BG = (20, 22, 26)         # Palette.pageBg
BOARD_BG = (42, 47, 56)        # Palette.boardBg
BLACK = (25, 26, 28)           # Palette.black
DOT = (139, 111, 58)           # Palette.dot
GRID = (185, 178, 162)         # Palette.gridLine
REGION = (32, 36, 43)          # Palette.regionLine
ACCENT = (242, 193, 78)        # Palette.accent
INK = (232, 230, 223)          # Palette.ink
QUIET = (154, 160, 173)        # Palette.inkQuiet

ICON_SIZES = [16, 32, 48, 64, 180, 192, 512, 1024]

FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


class Lcg:
    """Numerical Recipes 的 32 位 LCG：跨机器可复现，与 js/engine/rng.js 同一族做法。"""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s >> 8

    def unit(self):
        return self.next() / 16777216.0

    def span(self, lo, hi):
        return lo + (self.unit() * (hi - lo))


def font(px):
    """找一个能画 CJK 的字体；全都没有就用 PIL 的内置字体，宁可丑也不抛。"""
    from PIL import ImageFont
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
    return ImageFont.load_default()


def noise_field(size, amp, seed):
    """size×size 的均值 128 白噪声，逐像素独立 ⇒ 平铺无接缝。"""
    rng = Lcg(seed)
    out = Image.new('L', (size, size), 128)
    px = out.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = max(0, min(255, 128 + int(rng.span(-amp, amp + 1))))
    return out


def add_noise(img, gray):
    """按像素加一张均值 128 的噪声图（0..255 摆幅由调用方定），返回新的 RGB 图。"""
    base = img.convert('RGB')
    base.putdata([(max(0, min(255, r + n - 128)), max(0, min(255, g + n - 128)),
                   max(0, min(255, b + n - 128)))
                  for (r, g, b), n in zip(base.getdata(), gray.getdata())])
    return base


def domino_master(size, seed=SEED, maskable=False):
    """3×3 的那张母图。maskable=True 时图形缩到 80% 安全区、四周铺纯色（系统遮罩裁圆切不到骨牌）。"""
    s = size
    img = Image.new('RGBA', (s, s), CELL_BG + (255,))
    draw = ImageDraw.Draw(img)
    g = s / 3.0
    # 图标上把 theme.js 的 blackInset 放大一倍（0.05→0.10）：192px 里那条 3px 的缝读不出"两颗"，
    # 会糊成一条黑带。画布上仍然是 0.05，这里只是位图小尺寸的可见性补偿。
    inset = g * 0.10
    lw = g * 0.16 if s >= 64 else 1.0  # theme.js 的 regionWidth；小图上 2px 粗线会吃掉半块盘

    scale = 0.80 if maskable else 1.0
    ox = (s - s * scale) / 2.0
    X = lambda v: ox + v * scale  # noqa: E731  局部坐标→画布坐标，整段构图只用它

    for r in range(3):
        for c in range(3):
            col = CELL_BG if (r + c) % 2 == 0 else CELL_BG_ALT
            draw.rectangle([X(c * g), X(r * g), X((c + 1) * g), X((r + 1) * g)], fill=col + (255,))

    region = {(0, 0), (0, 1), (1, 0)}
    bw = max(1, int(round(lw * scale)))
    for (r, c) in region:
        x0, y0 = X(c * g), X(r * g)
        x1, y1 = X((c + 1) * g), X((r + 1) * g)
        for (dr, dc), (a, b) in [
            ((-1, 0), ((x0, y0), (x1, y0))),
            ((1, 0), ((x0, y1), (x1, y1))),
            ((0, -1), ((x0, y0), (x0, y1))),
            ((0, 1), ((x1, y0), (x1, y1))),
        ]:
            if (r + dr, c + dc) in region:
                continue
            draw.line([a, b], fill=REGION + (255,), width=bw)
    if s >= 32:  # 区域内的细线：16px 上它只会把粗线糊掉
        draw.line([(X(g), X(0) + bw / 2), (X(g), X(g) - bw / 2)], fill=GRID + (255,), width=1)
        draw.line([(X(0) + bw / 2, X(g)), (X(g) - bw / 2, X(g))], fill=GRID + (255,), width=1)

    for (r, c) in [(0, 0), (0, 1)]:  # 一副水平骨牌：两颗、中间留缝
        draw.rectangle([X(c * g) + inset * scale, X(r * g) + inset * scale,
                        X((c + 1) * g) - inset * scale, X((r + 1) * g) - inset * scale],
                       fill=BLACK + (255,))

    if s >= 64:
        rad = g * 0.17 * scale  # theme.js 的 dotRadius
        for (cr, cc) in [(1, 0), (2, 2)]:
            cx, cy = X(cc * g + g / 2), X(cr * g + g / 2)
            draw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=DOT + (255,))
        ring = g * 0.09 * scale  # theme.js 的 hintRing
        draw.rectangle([X(0) + ring / 2, X(g) + ring / 2, X(g) - ring / 2, X(2 * g) - ring / 2],
                       outline=ACCENT + (255,), width=max(2, int(round(ring))))

    base = add_noise(img, noise_field(s, 2, seed + 11))
    if maskable:
        out = Image.new('RGBA', (s, s), CELL_BG + (255,))
        out.paste(base, (int(ox), int(ox)))
        return out
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], int(s * 0.16), fill=255)
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def mini_board(d, ox, oy, cell, reg, black, dots):
    """社交卡上的那盘 5×4：与画布同一套数（regionWidth / blackInset / dotRadius）。"""
    rows, cols = len(reg), len(reg[0])
    for r in range(rows):
        for c in range(cols):
            x0, y0 = ox + c * cell, oy + r * cell
            d.rectangle([x0, y0, x0 + cell, y0 + cell],
                        fill=(CELL_BG if (r + c) % 2 == 0 else CELL_BG_ALT))
    bw = max(3, int(cell * 0.16))
    for r in range(rows):
        for c in range(cols):
            x0, y0 = ox + c * cell, oy + r * cell
            x1, y1 = x0 + cell, y0 + cell
            for (dr, dc), (a, b) in [
                ((-1, 0), ((x0, y0), (x1, y0))), ((1, 0), ((x0, y1), (x1, y1))),
                ((0, -1), ((x0, y0), (x0, y1))), ((0, 1), ((x1, y0), (x1, y1))),
            ]:
                nr, nc = r + dr, c + dc
                if 0 <= nr < rows and 0 <= nc < cols and reg[nr][nc] == reg[r][c]:
                    continue
                d.line([a, b], fill=REGION, width=bw)
    ins = int(cell * 0.05)
    for (r, c) in black:
        d.rectangle([ox + c * cell + ins, oy + r * cell + ins,
                     ox + (c + 1) * cell - ins, oy + (r + 1) * cell - ins], fill=BLACK)
    rad = cell * 0.17
    for (r, c) in dots:
        cx, cy = ox + c * cell + cell / 2, oy + r * cell + cell / 2
        d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=DOT)


def og_card(path):
    """1200×630 社交卡：左边一句话读得出玩法，右边一盘**引擎认账的真解**。

    右边那张盘不是手摆的近似图：它是 node 侧 `generate('easy', 0x1352841)`（种子 20260929）出货的
    5×4 剖分，配上 `solve()` 零猜测推到底的终局——本机 2026-10-02 实测 `complete=true`、
    `checkSolution().ok=true`、黑格 10 颗＝2×5 块区域。抄一张会错的盘上卡面，等于把玩法讲反。
    """
    W, H = 1200, 630
    img = Image.new('RGB', (W, H), PAGE_BG)
    img = add_noise(img, noise_field(256, 3, SEED + 3).resize((W, H), Image.BILINEAR))
    d = ImageDraw.Draw(img)
    flat = [0, 3, 3, 2, 1, 0, 3, 2, 2, 1, 0, 3, 2, 1, 1, 0, 3, 2, 4, 4]
    reg = [flat[r * 5:r * 5 + 5] for r in range(4)]
    marks = '##oo#oo#o#oo#oo##o##'
    black = {(i // 5, i % 5) for i, ch in enumerate(marks) if ch == '#'}
    dots = {(i // 5, i % 5) for i, ch in enumerate(marks) if ch == 'o'}
    # 垫一块 boardBg 底板：黑格 #191a1c 与卡面底 #14161a 只差 5，不垫就是"黑格看着像洞"。
    bx, by, cell = 690, 95, 96
    d.rounded_rectangle([bx - 26, by - 26, bx + cell * 5 + 26, by + cell * 4 + 26], 18,
                        fill=BOARD_BG)
    mini_board(d, bx, by, cell, reg, black, dots)

    d.text((72, 104), '乗りのり', font=font(96), fill=INK)
    d.text((76, 228), 'Norinori', font=font(44), fill=ACCENT)
    d.line([(72, 300), (600, 300)], fill=REGION, width=3)
    y = 330
    for t in ['每块粗线区域恰好两颗黑格；',
              '黑格两两成 1×2／2×1 骨牌，',
              '骨牌可以跨出区域，两块不得共边。',
              '',
              '出货的每一盘都由穷举计数器数到',
              '「恰好一个解」，再零猜测推到底。']:
        if t:
            d.text((72, y), t, font=font(30), fill=QUIET)
        y += 44
    img.save(path, 'PNG', optimize=True)


def check_png(path):
    """自己读 IHDR：交付前"宽高"这件事不该只在 Pillow 在场时才复验得了。"""
    with open(path, 'rb') as fh:
        data = fh.read(33)
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path} 的魔字不是 PNG')
    return struct.unpack('>II', data[16:24]) + (data[24], data[25])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
    args = ap.parse_args()
    root = args.out
    icons = os.path.join(root, 'icons')
    tex = os.path.join(root, 'textures')
    os.makedirs(icons, exist_ok=True)
    os.makedirs(tex, exist_ok=True)

    master = domino_master(1024)
    master.save(os.path.join(icons, 'icon-1024.png'), 'PNG', optimize=True)
    named = {180: 'apple-touch-icon.png', 192: 'icon-192.png', 512: 'icon-512.png',
             16: 'favicon-16.png', 32: 'favicon-32.png', 48: 'favicon-48.png', 64: 'favicon-64.png'}
    for s in ICON_SIZES:
        if s == 1024:
            continue
        img = domino_master(s)
        img.save(os.path.join(icons, named.get(s, f'icon-{s}.png')), 'PNG', optimize=True)
    domino_master(512, maskable=True).save(os.path.join(icons, 'icon-maskable-512.png'), 'PNG',
                                           optimize=True)

    # 棋盘纸纹：摆幅 0..2/255 的近白噪声，画布上 multiply 叠 ⇒ 最暗也只到 252/255
    paper = Image.new('L', (256, 256), 255)
    ppx = paper.load()
    rng = Lcg(SEED + 21)
    for y in range(256):
        for x in range(256):
            ppx[x, y] = 255 - int(rng.span(0, 3))
    paper.convert('RGB').save(os.path.join(tex, 'paper-256.png'), 'PNG', optimize=True)

    # 页面和纸：深色底 + 纤维 + 26 条更亮的纸筋
    washi = noise_field(512, 5, SEED + 31)
    wimg = Image.new('RGB', (512, 512))
    wimg.putdata([(PAGE_BG[0] + (v - 128) // 2, PAGE_BG[1] + (v - 128) // 2,
                   PAGE_BG[2] + (v - 128) // 2) for v in washi.getdata()])
    wd = ImageDraw.Draw(wimg)
    rng = Lcg(SEED + 41)
    for _ in range(26):
        y = int(rng.span(0, 511))
        x0 = int(rng.span(0, 380))
        wd.line([(x0, y), (x0 + int(rng.span(30, 140)), y + int(rng.span(-6, 7)))],
                fill=(30, 33, 39), width=1)
    wimg.save(os.path.join(tex, 'washi-512.png'), 'PNG', optimize=True)

    og_card(os.path.join(icons, 'og-1200x630.png'))

    print('--- IHDR 复核（逐文件读魔字 + 宽高）---')
    for d in (icons, tex):
        for f in sorted(os.listdir(d)):
            fp = os.path.join(d, f)
            w2, h2, dep, ct = check_png(fp)
            print(f'{os.path.relpath(fp, root):30s} {w2}x{h2} depth={dep} colortype={ct} '
                  f'bytes={os.path.getsize(fp)}')


if __name__ == '__main__':
    main()
