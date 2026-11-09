// dsh-breeze-speak · 宿主半边
//
// 干什么：挂住 DSH 的 "llm/stream" 事件，把本轮回复的文字（text-delta）攒起来，
// 等流结束就丢进播放队列 → 调 BreezeBlue 云端 TTS → 通过 SSE 把 mp3 推给网页半边播放。
//
// 为什么这么接：DSH 的 llm/stream 是洋葱式钩子（options, next）——
//   next() 返回一个 async iterable，里面是模型吐出的 chunk（type: "text-delta" / "finish"...）。
//   我们包一层 async generator 边读边 yield，不改动原文、不打断会话，只是"顺手听一耳朵"。
//   这个套路和本机装着的 dsh-tts-flash 完全一致（我们拆过它的源码）。
//
// 为什么不直接播放：宿主是 Node 进程，没有声卡上下文；播放交给浏览器里的 <audio> 最稳。
//   → 宿主用 SSE 推 base64 音频，网页半边收到就 new Audio().play()。

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'breeze-speak';

// 声明要哪些宿主服务；缺了会在安装时早炸早发现。
// 注意：logger 是 ctx 自带属性（ctx.logger），不是可注入的服务，
// 写进 inject 反而会因为「找不到服务」加载失败 —— 本机 tts-flash 也只声明 webServer。
// 同理没写 Config（schemastery 不在 profile node_modules），配置走自己的 config.json。
export const inject = ['webServer'];

const DEFAULT_VOICE = 'voc_u3nxkd5578wc'; // 大肥鱼（机灵版）
const DEFAULT_INSTRUCTIONS = '用傲娇又有点心虚、软软的语气念，句尾轻轻上扬再收回去，像在跟熟人撒娇。';
const MODEL_ID = 'breeze-tts-2';
const API_BASE = 'https://api.breeze.blue/v1';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

// ---------- 配置 ----------
function configPath() {
  return join(DSH_HOME, 'breeze-speak.json');
}
function loadConfig() {
  const defaults = {
    enabled: true,
    firstSentenceOnly: true, // 只念回复开头第一句（ta 的偏好，省积分）
    maxChars: 120,           // 每条最多念多少字，省积分（中文每字约 2 字符计费）
    voiceId: DEFAULT_VOICE,
    instructions: DEFAULT_INSTRUCTIONS,
  };
  try {
    if (existsSync(configPath())) {
      return { ...defaults, ...JSON.parse(readFileSync(configPath(), 'utf8')) };
    }
  } catch { /* 坏配置就用默认 */ }
  return defaults;
}

// ---------- Breeze API key ----------
// 从 ~/.dsh/.credentials.yaml 的 refs.BREEZE_API_KEY 读（不引 yaml 依赖，正则就够）。
function readApiKey() {
  if (process.env.BREEZE_API_KEY) return process.env.BREEZE_API_KEY;
  try {
    const f = join(DSH_HOME, '.credentials.yaml');
    if (!existsSync(f)) return '';
    const m = /BREEZE_API_KEY:\s*(\S+)/.exec(readFileSync(f, 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// ---------- 洗文本 ----------
// 剥掉给模型看的标记（花括号/方括号/【】），否则会被逐字念成"左花括号…"。
// 这条规则是本机 Breeze 中转实测出来的，照搬。
function spokenText(raw) {
  const t = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/`[^`]*`/g, ' ')                  // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接保留文字
    .replace(/\{[^{}]{0,80}\}/g, ' ')
    .replace(/【[^】]{0,40}】/g, ' ')
    .replace(/\[[^\[\]]{0,40}\]/g, ' ')
    .replace(/^[#>*\-\s]+/gm, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return t;
}

// ---------- SSE 广播 ----------
function makeBroadcaster() {
  const clients = new Set();
  return {
    add(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const hb = setInterval(() => { try { res.write(': hb\n'); } catch {} }, 25000);
      const cleanup = () => { clearInterval(hb); clients.delete(res); };
      res.on('close', cleanup);
      clients.add(res);
    },
    send(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) { try { res.write(frame); } catch {} }
    },
  };
}

// ---------- 合成 + 排队播放 ----------
// 串行队列：上一句没念完不并发请求，既省积分也避免声音叠在一起。
function makeSpeaker(ctx, cfg) {
  const bus = makeBroadcaster();
  const key = readApiKey();
  let chain = Promise.resolve();
  let playing = false;

  async function synthOne(text) {
    if (!key) {
      ctx.logger.warn('breeze-speak: 没找到 BREEZE_API_KEY（~/.dsh/.credentials.yaml），跳过朗读');
      return;
    }
    const r = await fetch(`${API_BASE}/text-to-speech/${encodeURIComponent(cfg.voiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        instructions: cfg.instructions,
        voice_settings: { guidance_scale: 4.0 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      ctx.logger.warn(`breeze-speak: Breeze ${r.status} ${detail}`);
      bus.send('error', { status: r.status, detail });
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    bus.send('audio', { audio: buf.toString('base64'), mime: 'audio/mpeg', text });
  }

  return {
    bus,
    enqueue(text) {
      const t = spokenText(text);
      if (!t) return;
      chain = chain
        .then(() => synthOne(t.slice(0, cfg.maxChars)))
        .catch((e) => ctx.logger.warn('breeze-speak: ' + String(e && e.message || e)));
    },
    get playing() { return playing; },
  };
}

// ---------- 包装 llm/stream ----------
function tapReply(ctx, speaker, inner, cfg) {
  let buf = '';
  // 按"第一句"截断：只念回复开头，剩的全丢（firstSentenceOnly 可关，改成念整条的前 maxChars 字）。
  const cut = () => {
    if (cfg.firstSentenceOnly) {
      const m = /^([\s\S]*?[。！？!?；;…\n])/.exec(buf);
      return (m ? m[1] : buf).trim();
    }
    return buf.trim();
  };
  return (async function* () {
    try {
      for await (const chunk of inner) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          buf += chunk.text;
        }
        yield chunk;   // 原样透传，绝不改动会话内容
      }
    } finally {
      const text = cut();
      if (text) speaker.enqueue(text);
    }
  })();
}

// ---------- HTTP 路由 ----------
function registerRoutes(ctx, speaker, cfg) {
  const B = '/dsh-breeze-speak';

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readBody = async (req) => {
    let s = '';
    for await (const c of req) s += c;
    try { return JSON.parse(s || '{}'); } catch { return {}; }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/stream`,
    handler: (req, res) => { speaker.bus.add(res); },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/state`,
    handler: (_req, res) => json(res, 200, {
      ok: true,
      enabled: cfg.enabled,
      keyed: !!readApiKey(),
      voiceId: cfg.voiceId,
      maxChars: cfg.maxChars,
    }),
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/preview`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false });
      const body = await readBody(req);
      speaker.enqueue(String(body.text || '哼，本鱼在这儿呢。'));
      json(res, 200, { ok: true });
    },
  }));
}

// ---------- 入口 ----------
export function apply(ctx) {
  const cfg = loadConfig();
  const speaker = makeSpeaker(ctx, cfg);
  registerRoutes(ctx, speaker, cfg);

  // 关键：洋葱钩子。过滤掉插件自己发起的模型调用（只一条消息且 source.kind === 'plugin'），
  // 免得把 dsh-feiyu-mood 的心情判定 JSON 也念出来 —— 这个坑本机踩过。
  ctx.effect(() => {
    const 摘 = ctx.on('llm/stream', (options, next) => {
      const inner = next();
      if (!cfg.enabled || options.sessionId === undefined) return inner;
      const msgs = options.messages;
      if (Array.isArray(msgs) && msgs.length === 1 && msgs[0]?.source?.kind === 'plugin') return inner;
      return tapReply(ctx, speaker, inner, cfg);
    });
    return () => { try { if (typeof 摘 === 'function') 摘(); } catch {} };
  });

  ctx.logger.info(`breeze-speak: 已加载（voice=${cfg.voiceId}，keyed=${!!readApiKey()}，配置=${configPath()}）`);
}
