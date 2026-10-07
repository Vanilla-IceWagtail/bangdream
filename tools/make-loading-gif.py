"""把桌面的 yeah.gif 压成加载页能用的大小（保留动画）。

用法：python tools/make-loading-gif.py <源gif> <输出gif> [宽度] [隔帧]
"""
import sys
from PIL import Image, ImageSequence

src = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\极光\Desktop\yeah.gif"
out = sys.argv[2] if len(sys.argv) > 2 else r"C:\Users\极光\Desktop\合成大西瓜-玩偶版\assets\loading.gif"
width = int(sys.argv[3]) if len(sys.argv) > 3 else 560
step = int(sys.argv[4]) if len(sys.argv) > 4 else 2
colors = int(sys.argv[5]) if len(sys.argv) > 5 else 128

im = Image.open(src)
frames = []
durations = []
for i, frame in enumerate(ImageSequence.Iterator(im)):
    if i % step:
        continue
    f = frame.convert("RGBA")
    if f.width != width:
        f = f.resize((width, round(f.height * width / f.width)), Image.LANCZOS)
    frames.append(f)
    durations.append(frame.info.get("duration", im.info.get("duration", 80)) * step)

print(f"源：{im.size[0]}x{im.size[1]}，共 {im.n_frames} 帧")
print(f"取：{len(frames)} 帧，缩放宽度 {width}")

# 用所有帧一起算调色板，颜色更稳；GIF 最多 256 色，这里用 128 省体积
pal_frames = [f.convert("RGB").quantize(colors=colors, method=Image.MEDIANCUT) for f in frames]
pal_frames[0].save(
    out,
    save_all=True,
    append_images=pal_frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)
import os

print(f"输出：{out}")
print(f"大小：{os.path.getsize(out) / 1024 / 1024:.2f} MB（源 {os.path.getsize(src) / 1024 / 1024:.2f} MB）")

# 顺手存一张首帧静态图（加载瞬间先显示它，避免白屏）
poster = out.replace(".gif", "-poster.png")
frames[0].convert("RGB").save(poster, optimize=True)
print(f"首帧：{poster}（{os.path.getsize(poster) / 1024:.0f} KB）")
