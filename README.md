© 2026 刘子祥 · 原创作品，转载请注明出处

> **定位**：随口 · 手机浏览器里的语音聊天助手：录音 → 转写 → 大模型 → 按句朗读，零依赖 Node + 原生前端。 使用许可见 [LICENSE](./LICENSE)。

# 随口 · 手机浏览器语音聊天

> 打开网页就能说话的大模型语音助手。零依赖 Node + 原生前端，手机 Safari / Chrome 直接可用。

线上：https://voice.zxlumen.cn · 状态见 [STATUS.md](./STATUS.md)

## 是什么

一个「豆包式」的语音对话页：

- **免提连续对话**：点一次圆球进通话，麦克风常开、按人声自动切句；AI 说完自动继续听，不用每轮点一次。
- **开口即打断**：AI 说话/思考时你开口（持续 300ms）立即停播并中断回复，转听。
- **流式回复 + 句子流水线**：模型边生成边切句，TTS 最多 3 路并发预取，WebAudio 时间轴顺序排播（句间 0 gap）；每轮前两句做双路对冲，压住上游 1.3~8.1s 的抖动。
- **数字/单位口语化**：37.5% → 百分之三十七点五，2026-11-10 → 二零二六年十一月十日，Markdown/链接/表情不念。
- **两种输入**：语音为主，底部随时可以打字；文字回复默认不朗读（可开）。
- **8 个音色**：anna / bella / claire / diana / benjamin / charles / david / alex。
- **手机优先**：装到桌面就是 App（PWA，无地址栏）、安全区适配、锁屏不熄（Wake Lock）、iOS 音频解锁、`audio/mp4` 录音兼容。

## 链路

```
手机浏览器
  MediaRecorder(webm/opus 或 mp4/aac)
    → POST /api/asr（原始音频体，12MB 上限；最近 6 轮对话放 x-suikou-ctx 供纠错）
      → ffmpeg 16k 单声道 mp3
      → AI 网关 /audio/transcriptions（SiliconFlow Qwen3-ASR-1.7B，之后过一遍上下文润色）
      → 可选：中英混说/长句走一次 LLM 润色（≤2s，失败回退原文）
    → POST /api/chat（SSE）
      → AI 网关 /chat/completions（deepseek-v4.1-flash，reasoning_effort=none）
    → POST /api/tts（每个短句一次，客户端最多 3 路并发）
      → AI 网关 /audio/speech（provider audio = SiliconFlow CosyVoice2，密钥只在主站）
    → Web Audio 时间轴排播（可随时 stop，打断即全部停）
```

- 真实 key 只在服务端环境变量里，前端拿不到；`/api/config` 不会回显任何密钥。
- 录音转完即删（临时目录），不落盘、不写库；对话只存在浏览器 localStorage。
- 前端未配置服务端 TTS 时自动降级为系统语音（`speechSynthesis`）。

## 实测（2026-11-10，本地容器）

| 环节 | 耗时 |
| --- | --- |
| 转写（Qwen3-ASR，9s 语音） | 0.74 ~ 0.92s（短句不润色；43 字句 + 润色 582ms） |
| 润色（仅中英混说 / ≥24 字） | 1.2 ~ 1.6s，超 2s 回退原文 |
| 首个 token | 1.2 ~ 1.5s（deepseek-v4.1-flash） |
| 首句合成 | 1.2 ~ 2.5s（CosyVoice2，首句 ≤12 字、按逗号断） |
| **说完 → 第一声** | **约 3.0 ~ 4.4s**（ask 起算；含 ASR 全程约 4~5s） |

没做流式 ASR / 流式 TTS，追不上豆包的 1s 级：SiliconFlow `/audio/speech` 是生成完再整段吐，
首包 1.2s 起。当前优化的是「不冷启动、句间不断、能打断」。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok,llm,asr,tts,ttsMode,ttsStats,asrPolish,model,uptime}` |
| GET | `/api/config` | 能力、音色、限额（不含密钥） |
| POST | `/api/asr` | 原始音频体（`audio/webm` / `audio/mp4`），返回 `{text,raw,polished,seconds,ms,asrMs,polishMs}` |
| POST | `/api/chat` | `{messages:[{role,content}]}`，SSE：`data:{"t":"增量"}` … `data:{"done":true}` |
| POST | `/api/tts` | `{text,voice,speed}` → `audio/mpeg` |

限流：对话 40 次/5 分钟/IP、转写 60 次/5 分钟/IP、合成 300 次/5 分钟/IP（免提会按句请求）；TTS 另有每日字数上限（默认 8 万，按北京日）。

## 本地跑

```bash
cp .env.example .env   # 填令牌/密钥
npm test               # 17 个用例：SSE/静态/限流/PWA/数字归一化/切句/TTS 归一化
npm start              # :8795
```

需要 `ffmpeg`（转换录音）。本地没有就用容器：

```bash
docker build -t voice-chat:dev .
docker run -d --name voice-test -p 8795:8795 --env-file .env voice-chat:dev
```

麦克风只在 **https 或 localhost** 下可用；手机真机测试必须走域名。

## 装到桌面

iPhone：Safari 打开 → 分享 → **添加到主屏幕** → 确认「作为 Web App」是开的 → 添加。
装好后从图标进入是 standalone（无地址栏、独立任务切换卡片）。

- `web/manifest.webmanifest`：`id` / `scope: /` / `display: standalone` / 180·192·512 图标（含 maskable）。
  iOS 缺 `scope` 会退回 Safari 打开，这点别删。
- `web/sw.js`：network-first，`/api/*` 不缓存 → 发版立刻生效，断网还能开壳。
- iOS 只在“添加到主屏幕那一刻”读配置：**改过 manifest 后要把旧图标删掉重新添加**。

## 部署

镜像 `ghcr.io/zxlumen/voice-chat`，容器 `voice:8795`，Caddy 子域见 `deploy/voice.caddy`，compose 片段见 `deploy/compose.service.yml`。

```bash
# 主站 docker 目录
cp deploy/voice.caddy caddy/sites/
# 把 deploy/compose.service.yml 的 voice: 段贴进 docker-compose.yml
# .env 追加 VOICE_AI_TOKEN / VOICE_ASR_TOKEN / VOICE_TTS_KEY
docker compose up -d voice && docker compose exec caddy caddy reload -c /etc/caddy/Caddyfile
```

## 已知限制

- 没有流式 ASR：必须等一句说完（静音 0.65s）才知道说了什么。
- 语音合成按句整段返回，不是边生成边播；上游抖动时单句可能 3~7s。
- 外放时扬声器回声仍可能误触发打断（AEC 只能压一部分）；建议戴耳机，或在设置里关掉「开口即打断」。
- 实时信息（天气/股价/新闻）没有联网工具，模型会直说不知道；日期/星期/时间由 system prompt 注入北京时间，可以直接回答。
- TTS 走主站网关 `/audio/speech`（`VOICE_TTS_MODE=gateway` + `VOICE_TTS_TOKEN`），
  SiliconFlow 密钥只在主站 `.env`；`direct` 只留给本地调试。
- 没有服务端会话存储：换设备/清缓存，对话就没了（有意为之）。
