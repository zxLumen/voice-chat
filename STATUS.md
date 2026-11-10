# 随口 · STATUS

> v0.1.0 · 2026-11-10 · 手机浏览器语音聊天（豆包式）· 线上 https://voice.zxlumen.cn

## 现在能做什么

- 点圆球说话，静音 0.7s 自动停；也可打字，两路共用同一段对话。
- 回复流式显示 + 按句合成语音，第一句先出声，后面的句子边播边预取。
- 说话中点一下圆球可打断，立即转听。
- 4 个音色（CosyVoice2）、语速 0.8~1.2、服务端/系统语音/关闭三档。
- iPhone Safari + Android Chrome 都验证过（Playwright WebKit/Chromium，含假麦克风全链路）。
- 设置：说自动发、文字也朗读、说完自动继续听（默认关）、清空本机对话。

## 实测数字（2026-11-10）

- 单元/接口测试 11/11 通过。
- 假麦克风全链路：听 → 转写 0.48~1.6s → 首 token 1.2~1.4s → 首声 3.3s（ask 起算）。
- 松手到第一声合计约 3.5~4s。
- ASR 模型冷启动一次约 4.3s，服务启动时会用 0.4s 静音预热。
- TTS 每日字数上限 8 万（北京日、进程内计数）。

## 已知缺口（按优先级）

1. **没有流式 ASR / 流式 TTS**，延迟追不上豆包（1s 级）。要压到 2s 内，需要网关支持 `/audio/speech` 流式 + 转写流式。
2. **TTS 密钥在应用侧**（`VOICE_TTS_KEY`）：主站网关目前只有 `/audio/transcriptions`，没有 `/audio/speech`。网关补上后改 `VOICE_TTS_MODE=gateway` 即可把 key 收回主站。
3. 实时信息（天气/股价/新闻）没有工具，模型会直说不知道。
4. 无服务端会话存储（有意）：换设备/清缓存对话即丢。
5. 说话中人声外放会被自己的回声干扰；「说完自动继续听」默认关，建议戴耳机再开。

## 体检 / 回滚

```bash
curl -s https://voice.zxlumen.cn/api/health
docker logs --tail 50 voice
# 回滚：compose 停 voice + 删 caddy/sites/voice.caddy + 应用栏移除 + 可选删 DNS
```
