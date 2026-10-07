# 音乐工作室 · Pattern 编排

在独立音乐界面打开 `#/music/studio-score`。六个通道（Keys / Pad / Bass / Kick / Snare / Hat）、两个 16 拍 Pattern、四个关联实例、120 BPM 和空间总线组成 33.5 秒原创配乐。每个 Pattern 的修改同时更新重复实例，主视频序列已引用整曲音乐素材。

```powershell
npm run build
node dist/cli/index.mjs serve --project examples/music-studio-lab --port 4330
# 浏览器：http://127.0.0.1:4330/#/music/studio-score
npx tsx scripts/create-music-studio-lab.ts --render-only
```

WAV 输出到 `exports/studio-score.wav`，不进入 Git。只有显式 `--rebuild` 才允许生成脚本重新写入工程；有自己的编辑时使用 `--render-only`。
