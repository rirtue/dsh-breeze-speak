# dsh-breeze-speak

一个最小可用的 DeepSeek Harness 插件示例：**读取本轮回复内容，用 BreezeBlue（Breeze TTS 2）念出来**。

功能：

- 挂住宿主 `llm/stream` 洋葱钩子，把模型吐出的文字攒起来；
- **第一句一凑齐就立刻发起合成**，不等整条回复写完 —— 那 0.6~1.3 秒的合成时间被藏进后续文字生成里；
- 默认只念**回复开头第一句**（可在配置里关掉），省 Breeze 积分；
- 送给 Breeze 前剥掉代码块 / 花括号 / 方括号标记，免得被逐字念成「左花括号…」；
- 跳过插件自己发起的模型调用（如心情判定 JSON），不会串音；
- 走 Breeze 的 **`/stream` 端点拿 PCM 裸流**，边收边推给网页半边，用 Web Audio 排时间轴连续播（不是等整段 mp3 编完再播）；
- **设置页里能直接填 Breeze API Key**（填完立即生效、不用重启）；
- **拉取在线音色**并按名字/语言/性别/来源筛选、分页，**选一个保存为默认音色**，并可试听：
  - 「▶ 官方试听」播放 Breeze 自带的预览片段（免费、不花积分）；
  - 「念一句」用该音色现合成一句（消耗少量积分），都不改变已保存的选择。

## 组成（DSH 插件 = npm 包 + 宿主半边 + 网页半边）

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明 `dsh.bundle.patch`、`dsh.client`、入口 |
| `cordis.patch.yml` | 把自己插进 profile 配置树（`id: breeze-speak`） |
| `index.js` | 宿主半边：`apply(ctx)`、注册路由、挂 `llm/stream` |
| `client.js` | 网页半边：`window.__ModuleLoader__.load` + 设置页 slot + 播放 |

## 前置

1. Node >= 22（DSH 自带）。
2. 一个 BreezeBlue 的 API key（形如 `brz_...`），三种给法任选其一：
   - **设置页**：打开「设置 → Breeze 朗读」，把 key 粘进输入框点保存（最方便，优先级最高）；
   - 环境变量 `BREEZE_API_KEY`；
   - `~/.dsh/.credentials.yaml` 里的 `refs.BREEZE_API_KEY`。
3. 音色默认是 `voc_u3nxkd5578wc`（示例音色）。**建议在设置页「在线音色」里挑一个自己账号里可用的**：
   输入名字（比如「大肥鱼」）→ 点「拉取」→ 试听 → 点「选为我的音色」即可。

> 优先级：设置页填写 > 环境变量 > `.credentials.yaml`。
> 设置页里点「清空」就会回退到后两者。key 每次合成 / 拉音色时动态解析，所以保存后**不用重启应用**。

## 配置

`~/.dsh/breeze-speak.json`（不存在就用默认；设置页保存 key 或音色时也会写这个文件）：

```json
{
  "enabled": true,
  "firstSentenceOnly": true,
  "maxChars": 120,
  "voiceId": "voc_u3nxkd5578wc",
  "instructions": "用傲娇又有点心虚、软软的语气念，句尾轻轻上扬再收回去。",
  "apiKey": ""
}
```

改字数/语气等要**真正退出桌面应用再重开**（插件主代码不热重载）；但改 key、改音色不用。

## HTTP 路由（都在 `/dsh-breeze-speak/` 下）

- `GET  /stream` —— SSE，推 `pcm` 帧 `{audio(base64), rate, bits, channels}`、收尾 `pcm-end` 帧与 `error` 帧
- `GET  /state`  —— `{ok, enabled, voiceId, maxChars, keyed, keySource, keyMasked}`（key 只回打码尾巴）
- `POST /config` —— `{apiKey}`，保存/清空 Breeze key（写 `breeze-speak.json`，就地生效）
- `GET  /voices` —— `?page=1&page_size=24&search=&language_code=&gender=&origin=`，透传 Breeze 音色库；
  返回精简后的 `voices[]` + `has_more/total/page/page_size/next_page_token`。
  实测：Breeze 的 `page` 从 **1** 开始（0 会 422），`page_size` 上限至少 100；生效的筛选只有
  `search / language_code / gender / origin`（`query / q / name / favorites / mine` 会被忽略）。
- `GET  /preview-url?url=...` —— 把 Breeze 官方预览 mp3 代理回浏览器（只放行 `https://r.breeze.blue/` 的链接，防 SSRF）
- `POST /voice` —— `{voiceId}`，保存选中的音色（就地生效）
- `POST /preview` —— `{text, voiceId?}`，立刻合成并播放一句（带 `voiceId` 时用该候选音色试听，不改已存选择）

写操作带跨站防护（`sec-fetch-site` / `Origin` 校验），明文 key 只在宿主，网页半边只收音频和打码串。

## 为什么用 `/stream`（延迟实测）

改之前是「整条回复流完 → 调普通 TTS 端点（整段 mp3，等 2.1~2.8 秒）→ 网页 `<audio>` 播」，
用户实际要等 **全文生成 + 2 秒多** 才听到第一个字。

现在两处一起改：

1. **提前触发**：`llm/stream` 每来一小段文字就检查一次，首句（第一个 `。！？；…` 或换行）一凑齐立刻发起合成，不再等 `finally`。
2. **改用 `/stream` 端点 + PCM 流播**：首包只要 **0.55~1.3 秒**（普通端点 2.1~2.8 秒），边收边推、Web Audio 排时间轴连续播放。

实测（`breeze-tts-2`、13 字中文）：

| 方式 | 首声到达 |
| --- | --- |
| 整段 mp3 端点（旧） | ~2100–2800 ms |
| `/stream` PCM（新） | **~550–1350 ms** |

PCM 裸流没有 WAV 头，格式是反推出来的：同一句的 MP3 时长 3.648 s、PCM 172800 字节
⇒ 47368 B/s ⇒ **24000 Hz / 16 bit / 单声道**（见 `index.js` 的 `PCM_RATE/PCM_BITS/PCM_CHANNELS`）。

注意：`/stream` 端点返回 `content-type: audio/pcm`，别加 `stream`/`speed`/`output_format`/`optimize_latency`
这些 body 字段（会 422 `Extra inputs are not permitted`）；`guidance_scale` 越大首包越快（4.0 约 570 ms，
1.0 约 1270 ms），所以维持 4.0。

### 帧长必须对齐到 2 字节（白噪音的坑）

16 bit PCM 每个样本 2 字节，所以**每一帧的字节数必须是偶数**。上游会按任意大小切块（实测 36 帧里 18 帧是奇数长度），
如果直接把这些块各自 `new Int16Array`，落在奇数字节边界上的帧就会整体错开一个字节（高低字节互换）——
听起来就是一片嘶嘶的白噪音。实测对比：对齐帧帧内最大跳变约 2600，错位帧高达 60000+（23 倍）。

两边都做了防护：

- **宿主**（`index.js` 的 `flush`）：切帧时把尾巴留到下一帧，`const n = pending.length - (pending.length % 2)`，
  保证送出去的每一帧都落在样本边界上。
- **网页半边**（`client.js` 的 `takeFrame`）：维护一个 `carry` 缓冲，每帧先拼上次剩下的半字节再按 2 字节切，
  不管宿主怎么切都不会错位；`stopAll()` 时清空 `carry`。

## 安装

先 `npm pack` 打成 tarball（本地目录直接 add 容易被 pnpm 当软链），再用 DSH 的 CLI 安装：

```bash
cd dsh-breeze-speak
npm pack                              # 生成 dsh-breeze-speak-0.1.0.tgz
dsh plugin --profile <profile> add ./dsh-breeze-speak-0.1.0.tgz
```

`<profile>` 换成你的 profile 名（例如 `desktop`）。Windows 上 CLI 是 `dsh.cmd`，
一般在 DSH 安装目录的 `resources/runtime/cli/bin/` 下；`dsh` 不在 PATH 时就用它的完整路径调用。

CLI 会做两件事：把包名加进 `package.json` 的 `dsh.profile.bundles`、把文件铺到 `node_modules/`。
**不用手改 profile 的 `cordis.patch.yml`** —— bundle 自带的 `cordis.patch.yml`（`- insert:` 那条）
会作为 bundle 层自动叠加注册，profile 层只是用户覆盖层。

实测在 dsh 0.2.2-rc.1 上是**热生效**的：装完路由立刻可访问，不用重启；
但网页半边的「Breeze 朗读」设置页要**刷新一下页面**才会加载新的 client bundle。
改 `index.js` 主代码仍需真正退出应用再重开。

也可以在应用内「插件 → 添加插件」里填本地路径 / tarball，效果一样。

## 设计说明（为什么这么写）

- **不改会话内容**：钩子包一层 async generator，边读边 `yield` 原文，只在 `finally` 里取开头一句去念。
- **不引 schemastery**：profile 的 `node_modules` 里没有那个包，写 `Config` 会让插件加载失败；
  配置全走自己的 `breeze-speak.json`。
- **不碰密钥到前端**：Breeze key 只在宿主读，网页半边只收音频（PCM 帧）和打码串，避免跨站泄露。
- **不把 1.5 万条音色灌给前端**：服务端筛选 + 分页，宿主只回精简字段；官方预览 mp3 走同源代理。
- **串行队列**：一句念完再请求下一句，不并发、不叠音、不烧积分。
