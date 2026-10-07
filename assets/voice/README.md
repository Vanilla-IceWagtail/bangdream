# 语音目录（按玩偶 ID）

游戏里的语音就在这里，**已经接好、开箱可用**。命名规则 = `js/config.js` 的 `AUDIO.sounds`。

```
assets/voice/
├─ afterglow-01/           ← 玩偶 ID（见 js/assets-builtin.js）
│  ├─ drop-1.mp3 … drop-5.mp3    释放这只玩偶时随机播一条
│  └─ merge-1.mp3 … merge-5.mp3  合成出这只玩偶时随机播一条
├─ poppinparty-03/
│  └─ …
├─ ui-warn.mp3            危险线报警（可选）
├─ ui-over.mp3            本局结束（可选）
├─ ui-click.mp3           界面点击（可选）
├─ manifest.json          由 tools/import-voice.cjs 生成
├─ 台词清单.md            每个文件对应哪句台词（想换哪句直接替换同名文件）
└─ README.md              本文件
```

- **语音跟着玩偶走，不跟等级走**：游戏用 `assets.idOf(等级)` 查出「这一级现在是谁」，
  再在那个角色的池子里**随机播一条** —— 所以玩家在选图窗口里换阵容，语音会自动跟着变。
- 没有语音的玩偶（音源里缺的角色）**自动退回 WebAudio 合成音**，不影响玩。
- **同一角色的不同造型共用一份语音**：常服版（如 `avemujica-casual-01` 三角初音·常服）
  没有单独录音，走 `CFG.AUDIO.audioIdOf()` 的别名规则直接复用常规版（`avemujica-01`）的语音。
  规则就是把 `-casual-` 去掉，所以以后别的乐队出常服版也自动受益。
- **格式**：优先 `opus → m4a → mp3`，最后兜底 `wav`。
  Ave Mujica 那 5 位（50 条）是用 `tools/import-mujica-voice.py` 从 44.1kHz 单人声 wav
  转成 **16kHz 单声道 wav**（本机没有 mp3 编码器），合计约 2.6MB。
- 想重新挑词：`node tools/import-voice.cjs <音源目录>`（默认读桌面「全音频」）。
- 想换某一句：直接替换同名文件即可（保持文件名不变）。
- 直接双击 HTML 时（file://）浏览器不允许 fetch 本地文件，所以页面会加载
  `assets/voice-inline.js`（由 `node tools/inline-voice.cjs` 生成，把语音内联成 data URL）。
  走 http（`启动游戏.cmd`）时不加载它。

## 体积参考

| 项目 | 现在 | 建议 |
| --- | --- | --- |
| 单个音效 | 20~50 KB | 0.1~0.6 秒、单声道、64~96kbps |
| 全部语音 | 300 条 ≈ 7 MB | ≤ 10 MB（手机首次加载友好） |
| 并发发声 | 代码限 8 个声部 | 手机混音器实际 8~16 个 |
