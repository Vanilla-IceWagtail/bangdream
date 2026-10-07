"""把「白底黑图标」的图转成透明底 PNG（保留抗锯齿）。

原理：黑图标在白底上 → 用亮度当透明度（alpha = 255 - 亮度），颜色取黑。
这样边缘的抗锯齿也能保留，不会出现白边。

用法：python tools/make-icon.py <输入图> <输出png> [裁剪]
"""
import sys
from PIL import Image

src = sys.argv[1]
out = sys.argv[2]
crop = "--crop" in sys.argv

im = Image.open(src).convert("RGB")
w, h = im.size

# 亮度当 alpha：白 → 全透明，黑 → 不透明
gray = im.convert("L")
# 阈值：把「几乎是白」的像素彻底抹掉（清掉外面那圈淡色胶囊），保留图标与抗锯齿边缘
alpha = gray.point(lambda v: 0 if v > 235 else 255 - v)

icon = Image.new("RGBA", (w, h), (0, 0, 0, 0))
# 图标本体取黑色，透明度来自亮度
icon.putalpha(alpha)
black = Image.new("RGBA", (w, h), (0, 0, 0, 255))
black.putalpha(alpha)
icon = black

if crop:
    bbox = icon.getbbox()
    if bbox:
        print(f"裁剪：{bbox}")
        icon = icon.crop(bbox)

icon.save(out, optimize=True)
import os

print(f"输出：{out}  {icon.size[0]}x{icon.size[1]}  {os.path.getsize(out) / 1024:.1f} KB")
