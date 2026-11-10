# 随口 · STATUS

> v0.2.0 · 2026-11-10 · 手机浏览器语音聊天（豆包式）· 线上 https://voice.zxlumen.cn

## 这一版解决什么

1. **连续对话（免提）**：点一次圆球进通话，麦克风常开、按人声自动切句上传；AI 说完直接继续听，不用再点。默认开。
2. **开口即打断**：AI 说话/思考时，检测到持续人声 300ms 立即停播 + 中断回复 + 转听；同一段录音继续用，不丢字。默认开。
3. **TTS 大幅改**：
   - 保活：CosyVoice2 空闲后首包实测 13.8s，现在每 3 分钟喂一小句保温，首句不再吃冷启动。
   - 流水线：LLM 边出字边切句（首句 ≤12 字、按逗号断），TTS 最多 3 路并发预取，WebAudio 时间轴按顺序排播 → 句间不再等 JS，实测 0 个 gap。
   - 朗读前归一化：数字/百分比/日期/时间/单位/电话读成中文，Markdown、链接、表情、括号注释不念；14 个用例覆盖。
   - 音色 4 → 8（anna/bella/claire/diana/benjamin/charles/david/alex）。
4. **转写后处理有闸门**：只有中英混说或 ≥24 字长句才走 LLM 润色（≤2s，失败回退原文）；日常短句 0ms，不再为润色白等 1.5s。
5. **提示词更短**：默认 1~2 句、≤60 字，减少合成段数。

## 实测数字（2026-11-10，本地容器 + 真实网关）

- 测试 **17/17** 通过（新增数字归一化、切句、TTS 归一化、8 音色）。
- 端到端假麦克风（Chromium）：ASR 0.46~0.98s（短句不润色）→ 首 token 1.2~1.5s → 首声 3.0~4.4s（ask 起算）。
- 打断：假麦克风在 AI 播报中开口，300ms 内停播并转听，日志 `[barge-in]`，无 pageerror。
- 句间 gap：0（旧版每句都要等上一句播完才预取下一句）。
- TTS 单句（8~14 字）1.2~2.5s，工作日高峰期偶发 3~7s（上游抖动，已加 20s 超时 + 失败跳过）。
- 保温请求：每 3 分钟一次、5 字，约 480 次/天，成本可忽略。

## 仍追不上豆包的地方

1. 没有流式 ASR / 流式 TTS：SiliconFlow `/audio/speech` 是「生成完再整段吐」，首包 ~1.2s 起，压不到 1s 级。
2. 30fps 的 VAD 在扬声器外放时仍可能被回声误触发；建议戴耳机，或把「开口即打断」关掉。
3. 实时信息（天气/股价/新闻）没有工具，模型会直说不知道。

## 体检 / 回滚

```bash
curl -s https://voice.zxlumen.cn/api/health   # ttsStats / asrPolish 都在这
docker logs --tail 50 docker-voice-1 | grep -E '\[(tts|asr|barge)'
# 回滚：docker compose 里把 VOICE_TAG 指到 rollback-* / 上个 sha，重启 voice 即可
```

## 线上落点（2026-11-10）

- 容器 `docker-voice-1`，镜像 `ghcr.io/zxlumen/voice-chat:latest`，192MB 上限，无状态无卷。
- Caddy：`docker/caddy/sites/voice.caddy` → `voice:8795`，`import webapp`（应用栏可 iframe）。
- DNS：DNSPod A `voice → 103.205.240.62`（RecordId 2447626899，TTL 600）。
- 网关：应用令牌 `voice`（chat-default / deepseek-v4.1-flash / 50 万 token 日限 / reasoning_effort=none）、
  `voice-asr`（provider-voice-asr = SiliconFlow XingChenASR，900 分钟/日）。
- TTS 走主站网关 `/audio/speech`（主站 `e12f0f7` 新增，2026-11-10 上线）：容器只拿
  `VOICE_TTS_TOKEN`（应用令牌），SiliconFlow 密钥留在主站 `.env`，应用侧不再持有音频 key。
- 应用栏：`apps_config` 含 `voice`（panel），图标 `docker/site-content/apps/voice.png`。
