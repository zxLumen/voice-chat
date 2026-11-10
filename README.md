# 随口 · 手机浏览器语音聊天

> 打开网页就能说话的大模型语音助手。零依赖 Node + 原生前端，手机 Safari / Chrome 直接可用。

线上：https://voice.zxlumen.cn · 状态见 [STATUS.md](./STATUS.md)

## 是什么

一个「豆包式」的语音对话页：

- **点一下说话**：浏览器录音 → 静音 0.7 秒自动停 → 转写 → 大模型 → 朗读。
- **流式回复**：模型边生成边显示，按句合成语音；第一句先出声，后面的句子边播边预取。
- **可打断**：说话中再点一下圆球，立即停播并开始听。
- **两种输入**：语音为主，底部随时可以打字；文字回复默认不朗读（可开）。
- **手机优先**：PWA manifest、安全区适配、锁屏不熄（Wake Lock）、iOS 音频解锁、`audio/mp4` 录音兼容。

## 链路

```
手机浏览器
  MediaRecorder(webm/opus 或 mp4/aac)
    → POST /api/asr（原始音频体，12MB 上限）
      → ffmpeg 16k 单声道 mp3
      → AI 网关 /audio/transcriptions（SiliconFlow SenseVoice）
    → POST /api/chat（SSE）
      → AI 网关 /chat/completions（deepseek-v4.1-flash，reasoning_effort=none）
    → POST /api/tts（每句一次）
      → OpenAI 兼容 /audio/speech（SiliconFlow CosyVoice2）
    → Web Audio 排队播放（可随时 stop）
```

- 真实 key 只在服务端环境变量里，前端拿不到；`/api/config` 不会回显任何密钥。
- 录音转完即删（临时目录），不落盘、不写库；对话只存在浏览器 localStorage。
- 前端未配置服务端 TTS 时自动降级为系统语音（`speechSynthesis`）。

## 实测（2026-11-10，本地容器）

| 环节 | 耗时 |
| --- | --- |
| 转写（TTS→ASR 回环） | 0.48 ~ 1.6s，平均约 1s |
| 首个 token | 1.2 ~ 1.4s（deepseek-v4.1-flash） |
| 首句合成 | 1.0 ~ 2.0s（CosyVoice2，随句长） |
| **松手 → 第一声** | **约 3.5 ~ 4s** |

没做流式 ASR / 流式 TTS，所以还追不上豆包的 1s 级；后续接网关 `/audio/speech` 流式再压。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok,llm,asr,tts,tssMode,model,uptime}` |
| GET | `/api/config` | 能力、音色、限额（不含密钥） |
| POST | `/api/asr` | 原始音频体（`audio/webm` / `audio/mp4`），返回 `{text,seconds,ms}` |
| POST | `/api/chat` | `{messages:[{role,content}]}`，SSE：`data:{"t":"增量"}` … `data:{"done":true}` |
| POST | `/api/tts` | `{text,voice,speed}` → `audio/mpeg` |

限流：对话 40 次/5 分钟/IP、转写 30 次/5 分钟/IP、合成 120 次/5 分钟/IP；TTS 另有每日字数上限（默认 8 万，按北京日）。

## 本地跑

```bash
cp .env.example .env   # 填令牌/密钥
npm test               # 11 个用例，含 SSE/静态/限流
npm start              # :8795
```

需要 `ffmpeg`（转换录音）。本地没有就用容器：

```bash
docker build -t voice-chat:dev .
docker run -d --name voice-test -p 8795:8795 --env-file .env voice-chat:dev
```

麦克风只在 **https 或 localhost** 下可用；手机真机测试必须走域名。

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

- 没有流式 ASR：必须等录音结束才知道说了什么。
- 语音合成按句整段返回，不是边生成边播。
- 实时信息（天气/股价/新闻）没有联网工具，模型会直说不知道。
- 服务端 TTS 目前 **直连** SiliconFlow；主站网关只有 `/audio/transcriptions`，没有 `/audio/speech`。加上之后把 `VOICE_TTS_MODE=gateway` 即可把密钥收回主站。
- 没有服务端会话存储：换设备/清缓存，对话就没了（有意为之）。
