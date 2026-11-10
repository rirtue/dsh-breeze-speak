// dsh-breeze-speak · 网页半边
//
// 只干三件事：连上宿主那条 SSE /dsh-breeze-speak/stream，收到 audio 帧就把 mp3 交给 <audio> 播放；
// 在设置页放一个面板：配置 Breeze API key、拉取在线音色并选一个保存/试听、点一下试听。
//
// 宿主负责合成、排队、鉴权；这里不碰明文 key（只显示打码尾巴）、不碰会话。

window.__ModuleLoader__.load({
  id: 'dsh-breeze-speak',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var B = '/dsh-breeze-speak';

    // ---------- 请求助手 ----------
    // 宿主的旧版本/异常会返回 404 或空 body；直接 r.json() 只会抛
    // "Unexpected end of JSON input"，看不出真因。这里先读文本再解析，
    // 并把状态码翻成人话（404 通常是改了宿主代码但没重启桌面应用）。
    function jget(url, opts) {
      return fetch(url, opts || {}).then(function (r) {
        return r.text().then(function (txt) {
          var data = null;
          if (txt) { try { data = JSON.parse(txt); } catch (e) { data = null; } }
          if (!r.ok) {
            var hint = '';
            if (r.status === 404) hint = '宿主没认出这个接口——多半是改了插件代码但还没真正退出桌面应用重开（新路由要重启才注册）';
            else if (r.status >= 500) hint = '宿主内部报错';
            var why = (data && (data.error || data.message)) || (!txt ? '响应是空的' : String(txt).slice(0, 200));
            var err = new Error('HTTP ' + r.status + '：' + why + (hint ? '（' + hint + '）' : ''));
            err.status = r.status;
            err.data = data;
            throw err;
          }
          if (!data) {
            var e2 = new Error('宿主返回的不是 JSON（' + (txt ? String(txt).slice(0, 120) : '空响应') + '）');
            e2.status = r.status;
            throw e2;
          }
          return data;
        });
      });
    }

    // POST 走同一套解析；顺带带上本地写入头，宿主用它挡跨站请求。
    function jpost(url, body) {
      return jget(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }

    // ---------- 音频引擎（SSE 朗读） ----------
    // 宿主推的是 PCM 裸流（24000Hz/16bit/单声道），不是 mp3 —— 因为 Breeze 的
    // /stream 端点首包只要 0.6 秒，而整段 mp3 要 2.1 秒。这里把陆续到达的 PCM
    // 喂进 Web Audio 的 AudioBufferSourceNode，排成一条时间轴连续播。
    var actx = null;
    var nextTime = 0;        // 下一段该排到哪个时刻（actx.currentTime 坐标系）
    var queueLen = 0;        // 已排但还没播完的段数

    function ensureCtx() {
      if (!actx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        try { actx = new AC(); } catch (e) { return null; }
      }
      if (actx.state === 'suspended') { try { actx.resume(); } catch (e) {} }
      return actx;
    }

    // 浏览器要求「用户先交互过」才允许出声。用户打字/点页面时顺手把上下文唤醒，
    // 这样后面 SSE 推音频过来就能直接播，不用等下一次点击。
    (function primeOnGesture() {
      var wake = function () {
        try {
          var c = ensureCtx();
          if (c && c.state === 'suspended') c.resume();
        } catch (e) {}
        document.removeEventListener('pointerdown', wake, true);
        document.removeEventListener('keydown', wake, true);
      };
      document.addEventListener('pointerdown', wake, true);
      document.addEventListener('keydown', wake, true);
    })();

    function pcmToFloat(ab, bits) {
      if (bits === 16) {
        // Int16Array 要求字节数是 2 的倍数；宿主按 8KB 切帧可能切出奇数尾巴，
        // 这里丢掉最后半字节（不到 1ms 音频），否则构造函数直接抛 RangeError。
        var usable = ab.byteLength - (ab.byteLength % 2);
        var i16 = new Int16Array(ab, 0, usable / 2);
        var f = new Float32Array(i16.length);
        for (var i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
        return f;
      }
      // 32bit float 兜底（目前 Breeze 没用到）
      return new Float32Array(ab);
    }

    function playPcm(frame) {
      var ctx = ensureCtx();
      if (!ctx) return;
      var bin = atob(frame.audio || '');
      if (!bin.length) return;
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      var rate = frame.rate || 24000;
      var chans = frame.channels || 1;
      var samples = pcmToFloat(bytes.buffer, frame.bits || 16);
      var frames = Math.floor(samples.length / chans);
      if (!frames) return;

      var buf = ctx.createBuffer(chans, frames, rate);
      for (var c = 0; c < chans; c++) {
        var ch = buf.getChannelData(c);
        for (var n = 0; n < frames; n++) ch[n] = samples[n * chans + c] || 0;
      }

      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);

      // 关键：用「比当前时间稍晚」的锚点串起来，片段之间不留空档、也不重叠。
      var now = ctx.currentTime;
      if (nextTime < now + 0.02) nextTime = now + 0.02;
      src.start(nextTime);
      nextTime += buf.duration;

      queueLen++;
      src.onended = function () {
        queueLen--;
        if (queueLen <= 0) { queueLen = 0; nextTime = 0; }
      };
    }

    function stopAll() {
      try { if (actx) actx.close(); } catch (e) {}
      actx = null; nextTime = 0; queueLen = 0;
    }

    // 官方试听片段用独立 <audio>，不跟 SSE 朗读队列抢。
    var previewAudio = new Audio();
    previewAudio.onended = function () {};

    // ---------- SSE ----------
    var es = null;
    function connect() {
      if (es) return;
      es = new EventSource(B + '/stream');
      // 宿主边合成边推 PCM：第一声 0.6 秒就到，不用等整段合成完。
      es.addEventListener('pcm', function (ev) {
        try { playPcm(JSON.parse(ev.data)); } catch (e) {}
      });
      // 兼容老版宿主（推整段 mp3）—— 万一没重启还留着旧进程，也不至于哑掉。
      es.addEventListener('audio', function (ev) {
        try { playMp3(JSON.parse(ev.data)); } catch (e) {}
      });
      es.addEventListener('error', function () {
        // 交给浏览器自动重连，不在这里手动重建
      });
    }

    // 老路径兜底：整段 mp3 走 <audio>。
    var legacyAudio = new Audio();
    var legacyUrl = null;
    function playMp3(f) {
      try {
        var bin = atob(f.audio || '');
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (legacyUrl) URL.revokeObjectURL(legacyUrl);
        legacyUrl = URL.createObjectURL(new Blob([bytes], { type: f.mime || 'audio/mpeg' }));
        legacyAudio.src = legacyUrl;
        legacyAudio.play().catch(function () {});
      } catch (e) {}
    }

    var row = { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' };
    var input = { flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 };
    var sel = { padding: '6px 8px', fontSize: 13 };
    var btn = { padding: '6px 12px' };
    var divider = { marginTop: 14, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 12 };

    // ---------- 在线音色浏览器 ----------
    // 拉宿主 /voices（宿主再透传 Breeze），分页 + 服务端筛选；
    // 每条可 ▶ 放官方预览 mp3（不花积分），也可用选定音色合成一句试听。
    function VoiceBrowser(props) {
      var s = React.useState('');
      var search = s[0], setSearch = s[1];
      var l = React.useState('zh');
      var lang = l[0], setLang = l[1];
      var g = React.useState('');
      var gender = g[0], setGender = g[1];
      var o = React.useState('');
      var origin = o[0], setOrigin = o[1];

      var vs = React.useState([]);
      var voices = vs[0], setVoices = vs[1];
      var pg = React.useState(1);
      var page = pg[0], setPage = pg[1];
      var tm = React.useState(0);
      var total = tm[0], setTotal = tm[1];
      var hm = React.useState(false);
      var hasMore = hm[0], setHasMore = hm[1];
      var ld = React.useState(false);
      var loading = ld[0], setLoading = ld[1];
      var er = React.useState('');
      var err = er[0], setErr = er[1];
      var selv = React.useState('');
      var selected = selv[0], setSelected = selv[1];       // 列表里当前选中的候选音色
      var pv = React.useState('');
      var playing = pv[0], setPlaying = pv[1];             // 正在放官方预览的 voice_id
      var nt = React.useState('');
      var notice = nt[0], setNotice = nt[1];
      var sv = React.useState(false);
      var saving = sv[0], setSaving = sv[1];

      // 拉取。append=true 时把下一页接到列表后面（加载更多）。
      function fetchVoices(p, append) {
        setLoading(true);
        setErr('');
        var q = '?page=' + p + '&page_size=24';
        if (search.trim()) q += '&search=' + encodeURIComponent(search.trim());
        if (lang) q += '&language_code=' + encodeURIComponent(lang);
        if (gender) q += '&gender=' + encodeURIComponent(gender);
        if (origin) q += '&origin=' + encodeURIComponent(origin);
        jget(B + '/voices' + q)
          .then(function (j) {
            if (!j.ok) { setErr(j.error || '拉取失败'); return; }
            setVoices(append ? voices.concat(j.voices) : j.voices);
            setTotal(j.total || 0);
            setHasMore(!!j.has_more);
            setPage(p);
          })
          .catch(function (e) { setErr('拉取失败：' + String(e && e.message || e)); })
          .then(function () { setLoading(false); });
      }

      React.useEffect(function () { fetchVoices(1, false); }, []);

      // 放官方预览 mp3（走同源代理，免费，不消耗积分）
      function playPreview(v) {
        if (!v.preview_url) { setNotice('这条没有官方预览片段'); return; }
        try { previewAudio.pause(); } catch (e) {}
        setPlaying(v.voice_id);
        setNotice('正在放《' + v.name + '》的官方试听片段…');
        previewAudio.src = B + '/preview-url?url=' + encodeURIComponent(v.preview_url);
        previewAudio.onended = function () { setPlaying(''); setNotice(''); };
        previewAudio.onerror = function () { setPlaying(''); setNotice('预览播放失败'); };
        var p = previewAudio.play();
        if (p && p.catch) p.catch(function () { setPlaying(''); setNotice('预览播放失败'); });
      }

      // 用候选音色念一句（合成试听，会消耗一丁点积分；不改已保存的选择）
      function tryVoice(v) {
        setNotice('正在用《' + v.name + '》合成…');
        jpost(B + '/preview', { text: props.text || '哼，本鱼在这儿呢。', voiceId: v.voice_id })
          .then(function (j) {
            if (!j.ok) { setNotice('合成失败：' + (j.error || '未知错误')); return; }
            setNotice('已用《' + v.name + '》念了一句，等音频回来…');
          })
          .catch(function (e) { setNotice('合成失败：' + String(e && e.message || e)); });
      }

      // 保存选中的音色为默认
      function saveVoice(v) {
        setSaving(true);
        setNotice('');
        jpost(B + '/voice', { voiceId: v.voice_id })
          .then(function (j) {
            if (j.ok) {
              setNotice('已把《' + v.name + '》设为我的音色，下句朗读立即生效');
              if (props.onSaved) props.onSaved();
            } else setNotice('保存失败：' + (j.error || '未知错误'));
          })
          .catch(function (e) { setNotice('保存失败：' + String(e && e.message || e)); })
          .then(function () { setSaving(false); });
      }

      var item = { padding: '8px 10px', borderBottom: '1px solid rgba(128,128,128,.18)', fontSize: 12 };
      var badge = { display: 'inline-block', padding: '0 6px', marginRight: 5, borderRadius: 8,
                     background: 'rgba(128,128,128,.18)', fontSize: 11, lineHeight: '18px' };

      return h('div', { style: divider },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '在线音色（选一个存起来 / 试听）'),

        // 筛选栏
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            value: search, placeholder: '搜名字（如 大肥鱼）',
            onChange: function (e) { setSearch(e.target.value); },
            onKeyDown: function (e) { if (e.key === 'Enter') fetchVoices(1, false); },
            style: { flex: '1 1 140px', minWidth: 100, padding: '6px 8px', fontSize: 13 },
          }),
          h('select', { value: lang, onChange: function (e) { setLang(e.target.value); }, style: sel },
            h('option', { value: '' }, '全部语言'),
            h('option', { value: 'zh' }, '中文'),
            h('option', { value: 'en' }, 'English'),
            h('option', { value: 'ja' }, '日本語')),
          h('select', { value: gender, onChange: function (e) { setGender(e.target.value); }, style: sel },
            h('option', { value: '' }, '全部性别'),
            h('option', { value: 'female' }, '女声'),
            h('option', { value: 'male' }, '男声')),
          h('select', { value: origin, onChange: function (e) { setOrigin(e.target.value); }, style: sel },
            h('option', { value: '' }, '全部来源'),
            h('option', { value: 'designed' }, '设计'),
            h('option', { value: 'cloned' }, '克隆')),
          h('button', {
            type: 'button', disabled: loading,
            onClick: function () { fetchVoices(1, false); }, style: btn,
          }, loading ? '加载中…' : '拉取')),

        // 结果计数
        h('div', { style: { opacity: 0.7, marginTop: 6 } },
          '共 ' + total + ' 条，本页 ' + voices.length + ' 条' +
          (props.currentVoiceId ? ' ｜ 当前音色 ' + props.currentVoiceId : '')),
        err ? h('div', { style: { marginTop: 6, color: '#e66' } }, err) : null,

        // 音色列表
        h('div', { style: { marginTop: 8, maxHeight: 300, overflowY: 'auto', border: '1px solid rgba(128,128,128,.25)', borderRadius: 6 } },
          voices.length === 0 && !loading
            ? h('div', { style: { padding: 12, opacity: 0.6 } }, '没有结果（换个筛选或先配置 key）')
            : voices.map(function (v) {
                var isCur = v.voice_id === props.currentVoiceId;
                var isSel = v.voice_id === selected;
                return h('div', {
                  key: v.voice_id,
                  style: { ...item, background: isSel ? 'rgba(90,150,255,.10)' : 'transparent' },
                },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('input', {
                      type: 'radio', name: 'breeze-voice', checked: isSel,
                      onChange: function () { setSelected(v.voice_id); },
                    }),
                    h('b', { style: { fontSize: 13 } }, v.name || v.voice_id),
                    isCur ? h('span', { style: badge }, '当前') : null,
                    v.language_code ? h('span', { style: badge }, v.language_code) : null,
                    v.gender ? h('span', { style: badge }, v.gender === 'female' ? '女' : v.gender === 'male' ? '男' : v.gender) : null,
                    v.tone ? h('span', { style: badge }, v.tone) : null),
                  v.description ? h('div', { style: { opacity: 0.72, margin: '3px 0 6px 24px' } }, v.description) : null,
                  h('div', { style: { marginLeft: 24, display: 'flex', gap: 6, flexWrap: 'wrap' } },
                    h('button', {
                      type: 'button', disabled: !v.preview_url,
                      onClick: function () { playPreview(v); }, style: { padding: '3px 9px', fontSize: 12 },
                    }, playing === v.voice_id ? '■ 停止' : '▶ 官方试听'),
                    h('button', {
                      type: 'button',
                      onClick: function () { tryVoice(v); }, style: { padding: '3px 9px', fontSize: 12 },
                    }, '念一句'),
                    h('button', {
                      type: 'button', disabled: saving || isCur,
                      onClick: function () { saveVoice(v); }, style: { padding: '3px 9px', fontSize: 12 },
                    }, isCur ? '已设为当前' : '选为我的音色'),
                    h('span', { style: { opacity: 0.4, fontSize: 11, alignSelf: 'center' } }, v.voice_id)));
              })),

        hasMore ? h('div', { style: { marginTop: 8 } },
          h('button', {
            type: 'button', disabled: loading,
            onClick: function () { fetchVoices(page + 1, true); }, style: btn,
          }, '加载更多')) : null,

        notice ? h('div', { style: { marginTop: 8, opacity: 0.9 } }, notice) : null,
        h('div', { style: { opacity: 0.55, marginTop: 8 } },
          '「官方试听」放 Breeze 自带片段（免费、不花积分）；「念一句」用该音色现合成一句试听（消耗少量积分），都不改已存的选择。')
      );
    }

    // ---------- 设置页面板 ----------
    function Settings() {
      var state = React.useState(null);
      var info = state[0], setInfo = state[1];
      var text = React.useState('哼，本鱼在这儿呢，才不是特意念给你听的。');
      var draft = text[0], setDraft = text[1];
      var keyState = React.useState('');
      var keyInput = keyState[0], setKeyInput = keyState[1];
      var msg = React.useState('');
      var notice = msg[0], setNotice = msg[1];
      var saving = React.useState(false);
      var busySaving = saving[0], setBusySaving = saving[1];

      function loadState() {
        jget(B + '/state')
          .then(setInfo)
          .catch(function (e) {
            // 旧宿主可能连 /state 的老字段都没有新值，不打扰用户，但留一条可见提示。
            setInfo(function (prev) {
              return Object.assign({}, prev, { __err: String(e && e.message || e) });
            });
          });
      }

      React.useEffect(function () {
        loadState();
        connect();
      }, []);

      // 保存 / 清空 key。保存后宿主动态解析，不用重启应用。
      function saveKey(clear) {
        setBusySaving(true);
        setNotice('');
        jpost(B + '/config', { apiKey: clear ? '' : keyInput })
          .then(function (j) {
            if (j.ok) {
              setKeyInput('');
              setNotice(clear
                ? '已清空，回退到环境变量 / .credentials.yaml'
                : '已保存，下次朗读立即生效');
              loadState();
            } else {
              setNotice('保存失败：' + (j.error || '未知错误'));
            }
          })
          .catch(function (e) { setNotice('保存失败：' + String(e && e.message || e)); })
          .then(function () { setBusySaving(false); });
      }

      var test = function () {
        jpost(B + '/preview', { text: draft })
          .then(function () {})
          .catch(function (e) { setNotice('试听失败：' + String(e && e.message || e)); });
      };

      var srcLabel = {
        config: '设置页填写',
        env: '环境变量 BREEZE_API_KEY',
        credentials: '~/.dsh/.credentials.yaml',
        '': '未配置',
      };

      var box = { padding: '12px 14px 24px', fontSize: 13, lineHeight: 1.7 };

      return h('div', { style: box },
        h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, 'Breeze 朗读'),
        h('div', { style: { opacity: 0.8 } },
          info
            ? '状态：' + (info.enabled ? '开启' : '关闭') + ' ｜ key ' + (info.keyed ? '已配置' : '未配置') +
              ' ｜ 音色 ' + (info.voiceId || '—')
            : '读取状态中…'),

        // ---- API key 区 ----
        h('div', { style: divider },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Breeze API Key'),
          h('div', { style: { opacity: 0.7, marginBottom: 8 } },
            '当前来源：' + (srcLabel[info ? info.keySource : ''] || '读取中…') +
            (info && info.keyMasked ? '（' + info.keyMasked + '）' : '')),
          h('div', { style: row },
            h('input', {
              type: 'password',
              value: keyInput,
              placeholder: info && info.keyed ? '已配置，留空则不修改' : '粘贴 brz_ 开头的 key',
              onChange: function (e) { setKeyInput(e.target.value); },
              style: input,
            }),
            h('button', {
              type: 'button', disabled: busySaving || !keyInput,
              onClick: function () { saveKey(false); }, style: btn,
            }, busySaving ? '保存中…' : '保存'),
            h('button', {
              type: 'button', disabled: busySaving,
              onClick: function () { saveKey(true); }, style: btn,
            }, '清空')),
          h('div', { style: { opacity: 0.6, marginTop: 6 } },
            '填这里优先级最高；清空则回退到环境变量 / .credentials.yaml。明文只存本机，设置页只显示打码。'),
          notice && notice.indexOf('已把') === -1 && notice.indexOf('官方试听') === -1 && notice.indexOf('念了') === -1
            ? h('div', { style: { marginTop: 6, opacity: 0.9 } }, notice) : null),

        // ---- 在线音色浏览器 ----
        h(VoiceBrowser, {
          text: draft,
          currentVoiceId: info ? info.voiceId : '',
          onSaved: loadState,
        }),

        // ---- 试听区 ----
        h('div', { style: divider },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '试听（用当前保存的音色）'),
          h('div', { style: row },
            h('input', {
              value: draft,
              onChange: function (e) { setDraft(e.target.value); },
              style: input,
            }),
            h('button', { type: 'button', onClick: test, style: btn }, '试听')),
          h('p', { style: { opacity: 0.65, marginTop: 10 } },
            '本插件只念每条回复的开头第一句；想改字数/语气，改 ~/.dsh/breeze-speak.json 后重启应用。'))
      );
    }

    function apply(ctx) {
      var slots = ctx.get && ctx.get('slots');
      if (slots === undefined || slots === null) return;
      // 先连上，保证面板没打开时也能播放
      connect();
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'breeze-speak', order: 61, label: function () { return 'Breeze 朗读'; } },
          Settings
        );
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
