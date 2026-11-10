# 随口 · STATUS

> v0.1.1 · 2026-11-10 · 手机浏览器语音聊天（豆包式）· 线上 https://voice.zxlumen.cn

## 现在能做什么

- 点圆球说话，静音 0.7s 自动停；也可打字，两路共用同一段对话。
- 回复流式显示 + 按句合成语音，第一句先出声，后面的句子边播边预取。
- 说话中点一下圆球可打断，立即转听。
- 4 个音色（CosyVoice2）、语速 0.8~1.2、服务端/系统语音/关闭三档。
- **装到桌面就是 App**：manifest `id/scope/display:standalone` + 180 图标 + service worker，iOS/Android 从主屏幕打开无地址栏（见下）。
- iPhone Safari + Android Chrome 都验证过（Playwright WebKit/Chromium，含假麦克风全链路）。
- 设置：说自动发、文字也朗读、说完自动继续听（默认关）、清空本机对话。

## 实测数字（2026-11-10）

- 单元/接口测试 11/11 通过。
- 假麦克风全链路（本地）：听 → 转写 0.5~0.8s → 首 token 1.1~1.4s → 首声 2.3~3.0s（ask 起算）。
- 线上 `voice.zxlumen.cn` 实测：ASR 0.5~0.85s（XingChenASR；先前 SenseVoice 抖动 4.5~16s，已换掉）、首 token 1.7s、首声 3.2s（ask 起算），松手到第一声约 3.5~4s。
- ASR 模型冷启动一次可达 15s（线上遇到过一次 16.2s）；已加启动预热 + 每 4 分钟 0.4s 静音保温。
- TTS 每日字数上限 8 万（北京日、进程内计数）。

## 装到桌面（PWA）

- manifest：`id/scope/start_url=/`、`display: standalone`、180/192/512 + maskable 图标。
  **`scope` 是 iOS 的关键**：缺了它，主屏幕图标会退回 Safari 打开。
- HTML：`apple-mobile-web-app-capable`、`mobile-web-app-capable`、`apple-mobile-web-app-title=随口`、
  `apple-touch-icon 180x180`、`black-translucent` 状态栏（配合 `env(safe-area-inset-top)`）。
- `sw.js`：network-first（发版后不会被旧缓存卡住），`/api/*` 不进缓存，断网可打开壳；
  `index.html / sw.js / manifest.webmanifest` 一律 `no-cache`。
- iPhone 上没装桌面前，页面顶部给一条可关闭提示（`localStorage suikou.installTip.v1`），装好后自动不再出现。

**iOS 26 装法**：Safari 打开 `voice.zxlumen.cn` → 分享 → 添加到主屏幕 → 弹窗里确认
**「作为 Web App」开着** → 添加。iOS 在“添加那一刻”固化安装信息，**旧图标要先删掉再重加**，
否则还会按旧配置在 Safari 里开。

线上验收（2026-11-10 22:46）：`/api/health` v0.1.1；`manifest.webmanifest` 200/808B/no-cache、
`sw.js` 200/1283B/no-cache、`icon-180.png` 200/18KB；Playwright WebKit(iPhone 13)+Chromium(Pixel 7)
SW 激活 scope `/`、manifest `id/scope/display` 全部正确、控制台 0 error；应用栏 iframe 的
`frame-ancestors` 未改，主站 200/0.19s。测试 13/13。

## 已知缺口（按优先级）

1. **没有流式 ASR / 流式 TTS**，延迟追不上豆包（1s 级）。要压到 2s 内，需要网关支持 `/audio/speech` 流式 + 转写流式。
2. ~~TTS 密钥在应用侧~~ 已收回：主站网关新增 `/audio/speech`，应用改 `VOICE_TTS_MODE=gateway`，
   只持有 `zxai_` 令牌，不再存 SiliconFlow key。
3. 实时信息（天气/股价/新闻）没有工具，模型会直说不知道。
4. 无服务端会话存储（有意）：换设备/清缓存对话即丢。
5. 说话中人声外放会被自己的回声干扰；「说完自动继续听」默认关，建议戴耳机再开。

## 体检 / 回滚

```bash
curl -s https://voice.zxlumen.cn/api/health
docker logs --tail 50 voice
# 回滚：compose 停 voice + 删 caddy/sites/voice.caddy + 应用栏移除 + 可选删 DNS
```

## 线上落点（2026-11-10）

- 容器 `docker-voice-1`，镜像 `ghcr.io/zxlumen/voice-chat:latest`，192MB 上限，无状态、无卷。
- Caddy：`docker/caddy/sites/voice.caddy` → `voice:8795`，`import webapp`（应用栏可 iframe）。
- DNS：DNSPod A `voice → 103.205.240.62`（RecordId 2447626899，TTL 600）。
- 网关：应用令牌 `voice`（chat-default / deepseek-v4.1-flash / 50 万 token 日限 /
  reasoning_effort=none）、`voice-asr`（provider-voice-asr = SiliconFlow XingChenASR，900 分钟/日）。
- 密钥：`VOICE_TTS_KEY` 在 `/home/ubuntu/zxLumen-Blog/docker/.env`（0600），仅 TTS 用；
  ASR 已走网关，不再需要应用侧音频密钥。
- 应用栏：`apps_config` 新增 `voice`（panel），图标 `docker/site-content/apps/voice.png`。
