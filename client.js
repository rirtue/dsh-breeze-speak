// dsh-breeze-speak · 网页半边
//
// 只干两件事：连上宿主那条 SSE /dsh-breeze-speak/stream，收到 audio 帧就把 mp3 交给 <audio> 播放；
// 在设置页放一个最小面板：配置 Breeze API key + 看状态 + 点一下试听。
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

    // ---------- 音频引擎 ----------
    // 用单个 <audio> 串行播；url 用 Blob，播完立刻 revoke，不漏内存。
    var audio = new Audio();
    var currentUrl = null;
    var pending = [];
    var busy = false;

    function playFrame(frame) {
      pending.push(frame);
      if (!busy) pump();
    }
    function pump() {
      if (!pending.length) { busy = false; return; }
      busy = true;
      var f = pending.shift();
      try {
        var bin = atob(f.audio || '');
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = URL.createObjectURL(new Blob([bytes], { type: f.mime || 'audio/mpeg' }));
        audio.src = currentUrl;
        audio.onended = function () { pump(); };
        audio.onerror = function () { pump(); };
        var p = audio.play();
        if (p && p.catch) p.catch(function () { pump(); });
      } catch (e) {
        pump();
      }
    }

    // ---------- SSE ----------
    // EventSource 断线会自己重连；这里只挂一次，不重复注册。
    var es = null;
    function connect() {
      if (es) return;
      es = new EventSource(B + '/stream');
      es.addEventListener('audio', function (ev) {
        try { playFrame(JSON.parse(ev.data)); } catch (e) {}
      });
      es.addEventListener('error', function () {
        // 交给浏览器自动重连，不在这里手动重建
      });
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
        fetch(B + '/state', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(setInfo)
          .catch(function () {});
      }

      React.useEffect(function () {
        loadState();
        connect();
      }, []);

      // 保存 / 清空 key。保存后宿主动态解析，不用重启应用。
      function saveKey(clear) {
        setBusySaving(true);
        setNotice('');
        fetch(B + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: clear ? '' : keyInput }),
        })
          .then(function (r) { return r.json(); })
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
          .catch(function (e) { setNotice('保存失败：' + String(e)); })
          .then(function () { setBusySaving(false); });
      }

      var test = function () {
        fetch(B + '/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: draft }),
        });
      };

      var srcLabel = {
        config: '设置页填写',
        env: '环境变量 BREEZE_API_KEY',
        credentials: '~/.dsh/.credentials.yaml',
        '': '未配置',
      };

      var box = { padding: '12px 14px 24px', fontSize: 13, lineHeight: 1.7 };
      var row = { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' };
      var input = { flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 };
      var btn = { padding: '6px 12px' };

      return h('div', { style: box },
        h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, 'Breeze 朗读'),
        h('div', { style: { opacity: 0.8 } },
          info
            ? '状态：' + (info.enabled ? '开启' : '关闭') + ' ｜ key ' + (info.keyed ? '已配置' : '未配置') + ' ｜ 音色 ' + info.voiceId
            : '读取状态中…'),

        // ---- API key 区 ----
        h('div', { style: { marginTop: 14, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 12 } },
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
          notice ? h('div', { style: { marginTop: 6, opacity: 0.9 } }, notice) : null),

        // ---- 试听区 ----
        h('div', { style: { marginTop: 14, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 12 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '试听'),
          h('div', { style: row },
            h('input', {
              value: draft,
              onChange: function (e) { setDraft(e.target.value); },
              style: input,
            }),
            h('button', { type: 'button', onClick: test, style: btn }, '试听')),
          h('p', { style: { opacity: 0.65, marginTop: 10 } },
            '本插件只念每条回复的开头第一句；想改音色/字数，改 ~/.dsh/breeze-speak.json 后重启应用。'))
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
