// dsh-breeze-speak · 宿主半边
//
// 干什么：挂住 DSH 的 "llm/stream" 事件，把本轮回复的文字（text-delta）攒起来，
// 等流结束就丢进播放队列 → 调 BreezeBlue 云端 TTS → 通过 SSE 把 mp3 推给网页半边播放。
//
// 为什么这么接：DSH 的 llm/stream 是洋葱式钩子（options, next）——
//   next() 返回一个 async iterable，里面是模型吐出的 chunk（type: "text-delta" / "finish"...）。
//   我们包一层 async generator 边读边 yield，不改动原文、不打断会话，只是"顺手听一耳朵"。
//
// 为什么不直接播放：宿主是 Node 进程，没有声卡上下文；播放交给浏览器里的 <audio> 最稳。
//   → 宿主用 SSE 推 base64 音频，网页半边收到就 new Audio().play()。

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'breeze-speak';

// 声明要哪些宿主服务；缺了会在安装时早炸早发现。
// 注意：logger 是 ctx 自带属性（ctx.logger），不是可注入的服务，
// 写进 inject 反而会因为「找不到服务」加载失败。
// 同理没写 Config（schemastery 不在 profile node_modules），配置走自己的 breeze-speak.json。
export const inject = ['webServer'];

const DEFAULT_VOICE = 'voc_u3nxkd5578wc'; // 示例音色，可在设置页/配置里换
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
    firstSentenceOnly: true, // 只念回复开头第一句，省积分
    maxChars: 120,           // 每条最多念多少字（中文每字约 2 字符计费）
    voiceId: DEFAULT_VOICE,
    instructions: DEFAULT_INSTRUCTIONS,
    apiKey: '',              // 设置页可填；留空则回退到环境变量 / .credentials.yaml
  };
  try {
    if (existsSync(configPath())) {
      return { ...defaults, ...JSON.parse(readFileSync(configPath(), 'utf8')) };
    }
  } catch { /* 坏配置就用默认 */ }
  return defaults;
}
function saveConfig(patch) {
  mkdirSync(DSH_HOME, { recursive: true });
  const next = { ...loadConfig(), ...patch };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// ---------- Breeze API key ----------
// 优先级：设置页填的（breeze-speak.json 的 apiKey）> 环境变量 > ~/.dsh/.credentials.yaml
// 每次合成 / 每次拉音色时动态解析，所以设置页保存后不用重启就能生效。
function credentialsKey() {
  try {
    const f = join(DSH_HOME, '.credentials.yaml');
    if (!existsSync(f)) return '';
    const m = /BREEZE_API_KEY:\s*(\S+)/.exec(readFileSync(f, 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
function keySource(cfg) {
  if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) return 'config';
  if (process.env.BREEZE_API_KEY) return 'env';
  if (credentialsKey()) return 'credentials';
  return '';
}
function resolveKey(cfg) {
  if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) return cfg.apiKey.trim();
  if (process.env.BREEZE_API_KEY) return process.env.BREEZE_API_KEY;
  return credentialsKey();
}
// 只给前端看打码后的尾巴，明文永远不出宿主。
function maskKey(k) {
  if (!k) return '';
  const t = String(k);
  return t.length <= 8 ? '••••' : t.slice(0, 4) + '••••' + t.slice(-4);
}

// ---------- 洗文本 ----------
// 剥掉给模型看的标记（花括号/方括号/【】），否则会被逐字念成"左花括号…"。
function spokenText(raw) {
  const t = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/`[^`]*`/g, ' ')                  // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接保留文字
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
  let chain = Promise.resolve();

  async function synthOne(text, voiceOverride) {
    const key = resolveKey(cfg); // 动态读：设置页改完立即生效
    if (!key) {
      ctx.logger.warn('breeze-speak: 没找到 BREEZE_API_KEY（设置页可填，或 ~/.dsh/.credentials.yaml / 环境变量），跳过朗读');
      bus.send('error', { status: 0, detail: 'BREEZE_API_KEY 未配置' });
      return;
    }
    const voiceId = voiceOverride || cfg.voiceId;
    const r = await fetch(`${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
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
    // voiceOverride 仅用于「试听某个候选音色」，不改变已保存的选择。
    enqueue(text, voiceOverride) {
      const t = spokenText(text);
      if (!t) return;
      chain = chain
        .then(() => synthOne(t.slice(0, cfg.maxChars), voiceOverride))
        .catch((e) => ctx.logger.warn('breeze-speak: ' + String(e && e.message || e)));
    },
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
  // 写操作防跨站：浏览器同源 fetch 会带 sec-fetch-site: same-origin；
  // 没有该头时（curl / 本地工具）看 Origin，再没有就放行。
  const isLocalWrite = (req) => {
    const sfs = String(req.headers['sec-fetch-site'] || '');
    if (sfs) return sfs === 'same-origin' || sfs === 'none';
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    try { return new URL(origin).host === String(req.headers.host || ''); }
    catch { return false; }
  };
  const keyInfo = () => {
    const src = keySource(cfg);
    const k = resolveKey(cfg);
    return { keyed: !!k, keySource: src, keyMasked: maskKey(k) };
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
      voiceId: cfg.voiceId,
      maxChars: cfg.maxChars,
      ...keyInfo(),
    }),
  }));

  // 设置页保存 API key。清空（apiKey: ""）表示回退到环境变量 / .credentials.yaml。
  // 写盘 + 就地更新内存 cfg，所以下一次合成立刻用新 key，不用重启应用。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/config`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      if (!isLocalWrite(req)) return json(res, 403, { ok: false, error: 'cross-site write denied' });
      const body = await readBody(req);
      if (typeof body.apiKey !== 'string') {
        return json(res, 400, { ok: false, error: 'apiKey must be a string' });
      }
      try {
        Object.assign(cfg, saveConfig({ apiKey: body.apiKey.trim() }));
        json(res, 200, { ok: true, ...keyInfo() });
      } catch (e) {
        ctx.logger.warn('breeze-speak: 保存配置失败 ' + String(e && e.message || e));
        json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    },
  }));

  // ---------- 在线音色 ----------
  // GET /voices：透传 Breeze 的 GET /v1/voices（服务端筛选 + 分页），只把必要的字段回给前端。
  // 实测：page 从 1 开始（0 会 422），page_size 上限至少 100；
  // 生效的筛选：search / language_code / gender / origin；query / q / name / favorites / mine 被忽略。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/voices`,
    handler: async (req, res) => {
      const key = resolveKey(cfg);
      if (!key) return json(res, 200, { ok: false, error: 'BREEZE_API_KEY 未配置', voices: [] });
      const u = new URL(req.url, 'http://local');
      const qs = new URLSearchParams();
      const pick = (k, d) => {
        const v = u.searchParams.get(k);
        return v && v.trim() ? v.trim() : d;
      };
      qs.set('page', pick('page', '1'));
      qs.set('page_size', pick('page_size', '30'));
      for (const k of ['search', 'language_code', 'gender', 'origin']) {
        const v = u.searchParams.get(k);
        if (v && v.trim()) qs.set(k, v.trim());
      }
      try {
        const r = await fetch(`${API_BASE}/voices?${qs}`, {
          headers: { 'xi-api-key': key },
          signal: AbortSignal.timeout(30000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json(res, 200, { ok: false, error: `Breeze ${r.status}: ${j.detail || j.error || ''}`, voices: [] });
        // 精简字段，避免把 1.5 万条的完整元数据往前端灌
        const voices = (j.voices || []).map((v) => ({
          voice_id: v.voice_id,
          name: v.name || '',
          language_code: v.language_code || '',
          gender: v.gender || '',
          origin: v.origin || '',
          tone: Array.isArray(v.tone) ? v.tone.join('/') : '',
          description: v.description || '',
          preview_url: v.preview_url || '',
          is_favorited: !!v.is_favorited,
        }));
        json(res, 200, {
          ok: true, voices,
          has_more: !!j.has_more, page: j.page, page_size: j.page_size,
          next_page_token: j.next_page_token, total: j.total,
        });
      } catch (e) {
        json(res, 200, { ok: false, error: String(e && e.message || e), voices: [] });
      }
    },
  }));

  // GET /preview-url?url=... ：把 Breeze 的 preview mp3 代理回浏览器。
  // 为什么不直接让前端 fetch 那个 r.breeze.blue 链接：跨域 + 万一以后要带 key，走同源最稳。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/preview-url`,
    handler: async (req, res) => {
      const u = new URL(req.url, 'http://local');
      const url = u.searchParams.get('url') || '';
      // 只代理 Breeze 官方 CDN 的 https 链接，防止被人拿去当任意 SSRF 跳板
      if (!/^https:\/\/r\.breeze\.blue\//.test(url)) {
        return json(res, 400, { ok: false, error: 'invalid preview url' });
      }
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) return json(res, 502, { ok: false, error: `upstream ${r.status}` });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          'content-type': r.headers.get('content-type') || 'audio/mpeg',
          'content-length': buf.length,
          'cache-control': 'public, max-age=3600',
        });
        res.end(buf);
      } catch (e) {
        json(res, 502, { ok: false, error: String(e && e.message || e) });
      }
    },
  }));

  // POST /voice ：保存选中的音色（voiceId）。就地更新 cfg，下一句朗读立刻用新音色。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/voice`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      if (!isLocalWrite(req)) return json(res, 403, { ok: false, error: 'cross-site write denied' });
      const body = await readBody(req);
      const id = String(body.voiceId || '').trim();
      if (!/^voc_[A-Za-z0-9_-]+$/.test(id)) {
        return json(res, 400, { ok: false, error: 'voiceId 格式不对' });
      }
      try {
        Object.assign(cfg, saveConfig({ voiceId: id }));
        json(res, 200, { ok: true, voiceId: cfg.voiceId });
      } catch (e) {
        json(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    },
  }));

  // POST /preview ：试听。带 voiceId 时用候选音色念一句（不改已保存的选择），
  // 不带 voiceId 则用当前保存的音色念。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `${B}/preview`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false });
      if (!isLocalWrite(req)) return json(res, 403, { ok: false, error: 'cross-site write denied' });
      const body = await readBody(req);
      const override = /^voc_[A-Za-z0-9_-]+$/.test(String(body.voiceId || '').trim())
        ? String(body.voiceId).trim() : null;
      speaker.enqueue(String(body.text || '哼，本鱼在这儿呢。'), override);
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

  ctx.logger.info(`breeze-speak: 已加载（voice=${cfg.voiceId}，keyed=${!!resolveKey(cfg)}，配置=${configPath()}）`);
}
