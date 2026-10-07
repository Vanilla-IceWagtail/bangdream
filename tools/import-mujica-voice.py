"""把桌面 mujica 文件夹里的语音按子文件夹名导入到对应玩偶。

用法：python tools/import-mujica-voice.py [源目录] [目标目录]

做三件事：
  1. 子文件夹名 → 玩偶 id（三角初音/丰川祥子/八幡海铃/祐天寺若麦/若叶睦 → avemujica-01..05）
  2. 每个角色挑 10 条（时长适中、分布均匀），前 5 条做「释放」drop-1..5，后 5 条做「合成」merge-1..5
  3. 转成 16kHz 单声道 WAV（源是 44.1kHz 单声道 wav，重采样后体积约为 1/3），
     裁掉超过 2.2 秒的尾巴，并做峰值归一化

为什么用 WAV：本机没有 mp3 编码器（ffmpeg/lameenc 都没有），
而 16kHz 单声道 WAV 对语音足够，浏览器也能直接解码（CFG.AUDIO.formats 里已加 wav 兜底）。
"""
import os
import sys
import wave
import math

import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\极光\Desktop\mujica"
DST = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "voice"
)

# 子文件夹名 → 玩偶 id（常服版走 CFG.audioIdOf 的别名规则，不用单独存一份）
NAME_TO_ID = {
    "三角初音": "avemujica-01",
    "丰川祥子": "avemujica-02",
    "八幡海铃": "avemujica-03",
    "祐天寺若麦": "avemujica-04",
    "若叶睦": "avemujica-05",
}

TARGET_SR = 16000
MAX_SECONDS = 2.2
MIN_SECONDS = 0.6
PICK = 10  # 5 释放 + 5 合成


def read_wav(path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError("只支持 16bit wav：" + path)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def resample(data, src_sr, dst_sr):
    if src_sr == dst_sr:
        return data
    n_out = int(round(len(data) * dst_sr / src_sr))
    # 线性插值足够：语音不追求高保真，避免引入 scipy 依赖
    x_old = np.linspace(0.0, 1.0, len(data), endpoint=False)
    x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
    return np.interp(x_new, x_old, data).astype(np.float32)


def write_wav(path, data, sr):
    clipped = np.clip(data, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def main():
    if not os.path.isdir(SRC):
        print("找不到源目录：" + SRC)
        return 1
    total_files = 0
    total_bytes = 0
    for folder, doll_id in NAME_TO_ID.items():
        src_dir = os.path.join(SRC, folder)
        if not os.path.isdir(src_dir):
            print("  ⚠ 缺少子目录：" + folder)
            continue
        candidates = []
        for root, _dirs, files in os.walk(src_dir):
            for f in files:
                if f.lower().endswith(".wav"):
                    p = os.path.join(root, f)
                    try:
                        data, sr = read_wav(p)
                    except Exception as e:
                        continue
                    dur = len(data) / sr
                    if MIN_SECONDS <= dur <= MAX_SECONDS:
                        candidates.append((dur, p))
        # 长度合适的按文件名排序，均匀取样，保证多样性
        candidates.sort(key=lambda x: os.path.basename(x[1]))
        if len(candidates) < PICK:
            # 候选不够就放宽时长范围（仍裁到 MAX_SECONDS）
            candidates = []
            for root, _dirs, files in os.walk(src_dir):
                for f in files:
                    if f.lower().endswith(".wav"):
                        p = os.path.join(root, f)
                        try:
                            data, sr = read_wav(p)
                        except Exception:
                            continue
                        candidates.append((len(data) / sr, p))
            candidates.sort(key=lambda x: os.path.basename(x[1]))
        if not candidates:
            print("  ⚠ %s 没有可用音频" % folder)
            continue
        step = max(1, len(candidates) // PICK)
        picked = candidates[::step][:PICK]
        if len(picked) < PICK:
            picked = candidates[:PICK]

        out_dir = os.path.join(DST, doll_id)
        os.makedirs(out_dir, exist_ok=True)
        # 先清掉这个 id 下旧的同名文件（重复导入时不残留）
        for old in os.listdir(out_dir):
            if old.startswith("drop-") or old.startswith("merge-"):
                os.remove(os.path.join(out_dir, old))

        written = 0
        for idx, (dur, path) in enumerate(picked):
            key = "drop" if idx < PICK // 2 else "merge"
            n = (idx % (PICK // 2)) + 1
            data, sr = read_wav(path)
            data = data[: int(MAX_SECONDS * sr)]  # 裁尾
            data = resample(data, sr, TARGET_SR)
            peak = float(np.max(np.abs(data))) or 1.0
            if peak > 0.01:
                data = data / peak * 0.92  # 峰值归一化，避免忽大忽小
            out = os.path.join(out_dir, "%s-%d.wav" % (key, n))
            write_wav(out, data, TARGET_SR)
            size = os.path.getsize(out)
            total_files += 1
            total_bytes += size
            written += 1
            print(
                "  %-14s %-10s ← %-52s %.2fs → %d KB"
                % (folder, os.path.basename(out), os.path.basename(path)[:50], dur, size // 1024)
            )
        print("  → %s：写入 %d 个（%s）" % (doll_id, written, folder))
    print()
    print("合计 %d 个文件，%.2f MB" % (total_files, total_bytes / 1024 / 1024))
    print("常服版（avemujica-casual-0x）通过 CFG.audioIdOf 复用同一份语音，不用重复存")
    return 0


if __name__ == "__main__":
    sys.exit(main())
