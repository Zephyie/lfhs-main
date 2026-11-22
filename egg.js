/* LFHS Hall Runner easter egg loader.
   Drop-in and zero cost: nothing loads until the secret is triggered.
   Triggers: Konami code (desktop), 6 quick taps in the bottom-right corner (mobile), or the link #hallrunner */
(function () {
  'use strict';
  if (window.LFHSEgg) return;
  var CFG = Object.assign({ src: 'hall-runner.html', hash: '#hallrunner', konami: true, corner: 'br', cornerSize: 56, cornerTaps: 6, tapWindow: 2600, hint: true, word: 'runner' }, window.LFHS_EGG || {});
  var KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  var ov = null, pushed = false, ki = 0, taps = [], styled = false, prevOv = '';
  var FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif';

  function css() {
    if (styled) return; styled = true;
    var s = document.createElement('style'); s.id = 'lfhs-egg-css';
    s.textContent = '.lfhs-egg-ov{position:fixed;inset:0;z-index:2147483000;background:#05070d;opacity:0;transition:opacity .35s cubic-bezier(.2,.8,.2,1);overscroll-behavior:contain}' +
      '.lfhs-egg-ov.on{opacity:1}' +
      '.lfhs-egg-ov iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#05070d;opacity:0;transform:scale(.97);transition:opacity .45s .08s,transform .55s cubic-bezier(.2,.8,.2,1)}' +
      '.lfhs-egg-ov.ready iframe{opacity:1;transform:none}' +
      '.lfhs-egg-load{position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:#94a3b8;font:600 12px/1 ' + FONT + ';letter-spacing:.18em;transition:opacity .3s}' +
      '.lfhs-egg-ov.ready .lfhs-egg-load{opacity:0;pointer-events:none}' +
      '.lfhs-egg-ring{width:34px;height:34px;margin:0 auto 14px;border-radius:50%;border:2px solid rgba(148,163,184,.25);border-top-color:#38bdf8;animation:lfhsegg-spin .8s linear infinite}' +
      '.lfhs-egg-toast{position:fixed;left:50%;bottom:calc(28px + env(safe-area-inset-bottom,0px));transform:translate(-50%,16px);opacity:0;z-index:2147482999;padding:10px 18px;border-radius:999px;background:rgba(20,24,36,.72);-webkit-backdrop-filter:blur(18px) saturate(1.6);backdrop-filter:blur(18px) saturate(1.6);border:1px solid rgba(255,255,255,.14);color:#f1f5f9;font:600 13px ' + FONT + ';letter-spacing:.01em;transition:opacity .4s,transform .5s cubic-bezier(.2,.8,.2,1);pointer-events:none}' +
      '.lfhs-egg-toast.on{opacity:1;transform:translate(-50%,0)}' +
      '@keyframes lfhsegg-spin{to{transform:rotate(360deg)}}' +
      '@media (prefers-reduced-motion:reduce){.lfhs-egg-ov,.lfhs-egg-ov iframe,.lfhs-egg-toast{transition:none}.lfhs-egg-ring{animation:none}}';
    document.head.appendChild(s);
  }
  function probe() {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(d); var c = getComputedStyle(d), r = { t: c.paddingTop, r: c.paddingRight, b: c.paddingBottom, l: c.paddingLeft }; d.remove(); return r;
  }
  function lock(on) {
    var h = document.documentElement;
    if (on) { prevOv = h.style.overflow; h.style.overflow = 'hidden'; } else h.style.overflow = prevOv;
  }
  function open() {
    if (ov) return; css();
    var o = document.createElement('div'); o.className = 'lfhs-egg-ov'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', 'Hall Runner');
    o.innerHTML = '<div class="lfhs-egg-load"><div><div class="lfhs-egg-ring"></div>LOADING</div></div>';
    var f = document.createElement('iframe'); f.title = 'Hall Runner'; f.setAttribute('allow', 'fullscreen; autoplay; gamepad'); f.setAttribute('allowfullscreen', '');
    f.addEventListener('load', function () {
      if (f.src.indexOf('about:blank') === 0) return;
      try { var d = f.contentDocument.documentElement.style, p = probe(); d.setProperty('--sat', p.t); d.setProperty('--sar', p.r); d.setProperty('--sab', p.b); d.setProperty('--sal', p.l); } catch (e) {}
      o.classList.add('ready');
      setTimeout(function () { try { f.focus(); f.contentWindow.focus(); } catch (e) {} }, 60);
    });
    f.src = CFG.src; o.insertBefore(f, o.firstChild); document.body.appendChild(o); lock(true);
    requestAnimationFrame(function () { o.classList.add('on'); });
    ov = o; try { history.pushState({ lfhsEgg: 1 }, ''); pushed = true; } catch (e) {}
  }
  function close(fromPop) {
    if (!ov) return; var o = ov; ov = null; o.classList.remove('on', 'ready'); lock(false);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    setTimeout(function () { var f = o.querySelector('iframe'); if (f) f.src = 'about:blank'; o.remove(); }, 340);
    if (pushed && !fromPop) { pushed = false; try { history.back(); } catch (e) {} } else pushed = false;
  }
  function toast(msg) {
    css(); var t = document.createElement('div'); t.className = 'lfhs-egg-toast'; t.textContent = msg; document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('on'); });
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 500); }, 2200);
  }
  function unlock() {
    if (ov) return; var seen = false;
    try { seen = localStorage.getItem('lfhs_egg_seen') === '1'; localStorage.setItem('lfhs_egg_seen', '1'); } catch (e) {}
    try { navigator.vibrate && navigator.vibrate(14); } catch (e) {}
    if (seen) { open(); return; }
    toast('Hall Runner unlocked'); setTimeout(open, 650);
  }
  function fromHash() {
    if (location.hash.toLowerCase() !== CFG.hash) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    open();
  }
  function typing(el) { return el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); }

  var typed = '';
  function onKey(e) {
    if (ov || !e || !e.key || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (CFG.konami) { if (k === KONAMI[ki]) { if (++ki === KONAMI.length) { ki = 0; unlock(); return; } } else ki = (k === KONAMI[0]) ? 1 : 0; }
    if (CFG.word && k.length === 1) { typed = (typed + k).slice(-CFG.word.length); if (typed === CFG.word) { typed = ''; unlock(); } }
  }
  function onPtr(e) {
    if (ov || e.button > 0) return; var win = e.view || window, w = win.innerWidth, h = win.innerHeight, s = CFG.cornerSize, c = CFG.corner;
    var inX = c.charAt(1) === 'r' ? e.clientX > w - s : e.clientX < s, inY = c.charAt(0) === 'b' ? e.clientY > h - s : e.clientY < s;
    if (!(inX && inY)) { taps = []; return; }
    var now = Date.now(); taps = taps.filter(function (t) { return now - t < CFG.tapWindow; }); taps.push(now);
    if (taps.length >= CFG.cornerTaps) { taps = []; unlock(); }
  }
  function hook(w) {
    try { if (w.__lfhsEgg) return; w.__lfhsEgg = 1; w.addEventListener('keydown', onKey, true); w.addEventListener('pointerup', onPtr, { capture: true, passive: true }); } catch (e) {}
  }
  function hookFrames() {
    var fs = document.querySelectorAll('iframe');
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i]; if (f.closest && f.closest('.lfhs-egg-ov')) continue;
      if (!f.__lfhsEggL) { f.__lfhsEggL = 1; f.addEventListener('load', function (ev) { try { hook(ev.target.contentWindow); } catch (e) {} }); }
      try { if (f.contentWindow && f.contentDocument) hook(f.contentWindow); } catch (e) {}
    }
  }
  hook(window);
  window.addEventListener('popstate', function () { if (ov) close(true); });
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin && location.origin !== 'null') return;
    if (e.data && e.data.lfhs === 'hall-runner-exit') close();
  });
  window.LFHSEgg = { open: open, close: function () { close(); }, isOpen: function () { return !!ov; } };
  if (CFG.hint) try { console.log('%cLFHS%c the hallway has a secret. Some say it starts with \u2191 \u2191 \u2193 \u2193 \u2190 \u2192 \u2190 \u2192 B A', 'background:#2563eb;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700', 'color:#64748b'); } catch (e) {}
  function boot() { fromHash(); hookFrames(); try { new MutationObserver(hookFrames).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {} setInterval(hookFrames, 3000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
