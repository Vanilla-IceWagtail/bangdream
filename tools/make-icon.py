"""把「白底黑图标」的图转成透明底 PNG（保留抗锯齿）。

原理：黑图标在白底上 → 用亮度当透明度（alpha = 255 - 亮度），颜色取黑。
这样边缘的抗锯齿也能保留，不会出现白边。

用法：
  python tools/make-icon.py <输入图> <输出png> [--crop] [--trim-bottom 比例] [--clear-box x0,y0,x1,y1]

为什么要 --trim-bottom / --clear-box：
  AI 生成的图右下角常带一个「AI生成」灰色角标。它的灰度（~160）比背景深，
  光靠亮度阈值清不掉，会留一小块灰斑 —— 升级成图标后就会出现在按钮上。
  这两种方式都能在转透明之前把它切掉：
    · --trim-bottom 0.12  ：直接切掉底部 12%（角标一般在最底下）
    · --clear-box 0.72,0.86,1,1 ：按比例抹掉指定矩形（更精准）
"""
import os
import sys

from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--")]
opts = sys.argv[1:]
src = args[0]
out = args[1]
crop = "--crop" in opts


def opt_value(name):
    if name in opts:
        i = opts.index(name)
        if i + 1 < len(opts):
            return opts[i + 1]
    return None


im = Image.open(src).convert("RGB")
w, h = im.size

trim = opt_value("--trim-bottom")
if trim:
    keep = max(1, int(h * (1.0 - float(trim))))
    im = im.crop((0, 0, w, keep))
    print(f"切掉底部 {float(trim) * 100:.0f}%：{w}x{h} → {im.size[0]}x{im.size[1]}")

box = opt_value("--clear-box")
if box:
    x0, y0, x1, y1 = [float(v) for v in box.split(",")]
    w2, h2 = im.size
    region = (int(w2 * x0), int(h2 * y0), int(w2 * x1), int(h2 * y1))
    im.paste((255, 255, 255), region)
    print(f"抹掉区域（按比例）：{region}")

w, h = im.size

# 亮度当 alpha：白 → 全透明，黑 → 不透明
gray = im.convert("L")
# 阈值：把「几乎是白」的像素彻底抹掉（清掉外面那圈淡色胶囊），保留图标与抗锯齿边缘
alpha = gray.point(lambda v: 0 if v > 235 else 255 - v)

black = Image.new("RGBA", (w, h), (0, 0, 0, 255))
black.putalpha(alpha)
icon = black

if crop:
    bbox = icon.getbbox()
    if bbox:
        print(f"裁剪：{bbox}")
        icon = icon.crop(bbox)

# 留白：小尺寸（按钮里 22px）时图形贴边会显得很挤，加一圈透明边更好看
pad = opt_value("--pad")
if pad:
    ratio = float(pad)
    w2, h2 = icon.size
    side = max(w2, h2)
    canvas_side = int(round(side * (1 + ratio * 2)))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(icon, ((canvas_side - w2) // 2, (canvas_side - h2) // 2), icon)
    icon = canvas
    print(f"加留白 {ratio * 100:.0f}%：{w2}x{h2} → {canvas_side}x{canvas_side}")

icon.save(out, optimize=True)
print(f"输出：{out}  {icon.size[0]}x{icon.size[1]}  {os.path.getsize(out) / 1024:.1f} KB")
