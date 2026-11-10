# 随口 · STATUS

> v0.2.2 · 2026-11-10 · 手机浏览器语音聊天（豆包式）· 线上 https://voice.zxlumen.cn

## v0.2.2 · 日期/时间可回答（2026-11-10）

- 之前问「今天几号」会答「没联网」：system prompt 里没有任何时间信息。
- 现在每次请求注入北京时间（年月日 + 星期 + 时分），并明确「日期/星期/时间以系统给的为准」；
  天气/股价/新闻仍然没有工具，照旧直说不知道。
- 测试 24/24（新增 `buildSystemPrompt` 用例：固定时间断言年月日、星期三、时分）。

## 这一版解决什么

1. **连续对话（免提）**：点一次圆球进通话，麦克风常开、按人声自动切句上传；AI 说完直接继续听，不用再点。默认开。
2. **开口即打断**：AI 说话/思考时，检测到持续人声 300ms 立即停播 + 中断回复 + 转听；同一段录音继续用，不丢字。默认开。
3. **TTS 大幅改**：
   - 保活：CosyVoice2 空闲后首包实测 13.8s，现在每 3 分钟喂一小句保温，首句不再吃冷启动。
   - 流水线：LLM 边出字边切句（首句 ≤12 字、按逗号断），TTS 最多 3 路并发预取，WebAudio 时间轴按顺序排播 → 句间不再等 JS，实测 0 个 gap。
   - 上游 5xx 自动重试一次（实测偶发 `50507 Unknown error`，不重试就会丢一句）。
   - 前两句对冲：上游同长度抖动 1.3~8.1s（晚高峰实测），每轮前两句同时发两路、先回者用、另一路 abort。实测 median 2.15s → 1.40s、尾延迟 8.1s → 1.55s；代价是每轮多 1~2 次合成（额度按实际 2 倍计）。
   - 朗读前归一化：数字/百分比/日期/时间/单位/电话读成中文，Markdown、链接、表情、括号注释不念；14 个用例覆盖。
   - 音色 4 → 8（anna/bella/claire/diana/benjamin/charles/david/alex）。
4. **转写后处理有闸门**：只有中英混说或 ≥24 字长句才走 LLM 润色（≤2s，失败回退原文）；日常短句 0ms，不再为润色白等 1.5s。
5. **提示词更短**：默认 1~2 句、≤60 字，减少合成段数。

## v0.2.1：转写质量（这一版的重点）

1. **转写模型换 Qwen3-ASR-1.7B**：旧 XingChenASR-V3.2 在 25.4s 录音上只回最后一句（截断），
   同一条音频 Qwen3 全文 3 句；9s 音频 **0.74s**、25s 音频 1.5s（网关实测）。自带标点，中英混说不用再猜。
2. **上下文润色**：转写后把「最近 4 轮对话 + 术语表（zxLumen/StockApp/对位/CosyVoice/望京SOHO…）」
   一起给快模型，补标点、纠同音字（stock cap→StockApp、搜候→SOHO）、去口头重复。
   - 专用网关应用 `voice-polish`（SiliconFlow Qwen2.5-7B，≤200 万 token/日），**585~900ms/次**；
     用对话模型要 2s，实测会顶到超时。
   - 闸门：短于 24 字且无英文的句子跳过；超时 2.5s 回退原文；输出长度/内容异常直接丢弃。
   - 线上实测：43 字句 raw 43→41 字、落库 `asr=917ms polish=582ms`。
3. **朗读归一化补边界**：千分位 `1,234.5`、负百分比 `-12.3%`、区间 `3~5`、`A/B`；
   不再把大写缩写拆成单字母（`SOHO` 以前被念成「S O H O」）。

## 实测数字（2026-11-10，本地容器 + 真实网关）

- 测试 **17/17** 通过（新增数字归一化、切句、TTS 归一化、8 音色）。
- 端到端假麦克风（Chromium）：ASR 0.46~0.98s（短句不润色）→ 首 token 1.2~1.5s → 首声 3.0~4.4s（ask 起算）。
- 打断：假麦克风在 AI 播报中开口，300ms 内停播并转听，日志 `[barge-in]`，无 pageerror。
- 句间 gap：0（旧版每句都要等上一句播完才预取下一句）。
- TTS 单句（8~14 字）1.2~2.5s，工作日高峰期偶发 3~7s（上游抖动，已加 20s 超时 + 失败跳过）。
- 保温请求：每 3 分钟一次、5 字，约 480 次/天，成本可忽略。

## 决策（2026-11-10）

- **不接新的 TTS 供应商**，继续用 SiliconFlow CosyVoice2（22.05kHz）：延迟已压到首声 2.5~3.5s、句间 0 gap，
  音色维持现状。若之后「像不像人」成为硬指标，再评估豆包/火山 TTS（需开通账号 + 按字符计费）。

## 仍追不上豆包的地方

1. 没有流式 ASR / 流式 TTS：SiliconFlow `/audio/speech` 传 `stream:true` 仍返回整段 mp3（实测 34KB 一次性到齐，首字节 1.78s），
   CosyVoice2 单价单句 1.7~2.8s，这是上游下限；要 1s 级得换豆包/火山 TTS（需要另开账号+计费）。
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
