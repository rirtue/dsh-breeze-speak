// dsh-breeze-speak · 网页半边
//
// 只干一件事：连上宿主那条 SSE /dsh-breeze-speak/stream，
// 收到 audio 帧就把 mp3 交给 <audio> 播放。顺便在设置页放一个最小面板（开关 + 试听）。
//
// 宿主负责合成、排队、鉴权；这里不碰 Breeze、不碰 key、不碰会话。

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

      React.useEffect(function () {
        fetch(B + '/state', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(setInfo)
          .catch(function () {});
        connect();
      }, []);

      var test = function () {
        fetch(B + '/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: draft }),
        });
      };

      return h('div', { style: { padding: '12px 14px 24px', fontSize: 13, lineHeight: 1.7 } },
        h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, 'Breeze 朗读'),
        h('div', { style: { opacity: 0.8 } },
          info
            ? '状态：' + (info.enabled ? '开启' : '关闭') + ' ｜ key ' + (info.keyed ? '已配置' : '未配置') + ' ｜ 音色 ' + info.voiceId
            : '读取状态中…'),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            value: draft,
            onChange: function (e) { setDraft(e.target.value); },
            style: { flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 },
          }),
          h('button', { type: 'button', onClick: test, style: { padding: '6px 12px' } }, '试听')),
        h('p', { style: { opacity: 0.65, marginTop: 10 } },
          '本插件只念每条回复的开头第一句；想改音色/字数，改 ~/.dsh/breeze-speak.json 后重启应用。')
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
