/* LFHS easter egg loader (Hall Runner + VANGUARD).
   Drop-in and zero cost: nothing else loads until a secret is found.
   Hall Runner (a book pops up): Konami code, the word "runner", 6 quick taps in the bottom-right corner, or the link #hallrunner
   VANGUARD (a gun pops up): the word "shooter" or W W S S A D A D Enter on desktop, 5 quick taps on the profile button on phones, or #vanguard */
(function () {
  'use strict';
  if (window.LFHSEgg) return;
  var CFG = Object.assign({
    src: 'hall-runner.html', hash: '#hallrunner', konami: true, corner: 'br', cornerSize: 56, cornerTaps: 6, tapWindow: 2600, word: 'runner',
    shooterSrc: 'vanguard.html', shooterHash: '#vanguard', shooterWord: 'shooter', shooterSeq: true,
    profile: '', profileTaps: 5, profileWindow: 3000, profileAnyDevice: false,
    popMs: 15000, hint: true
  }, window.LFHS_EGG || {});
  var KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  var WASD = ['w', 'w', 's', 's', 'a', 'd', 'a', 'd', 'Enter'];
  var GAMES = {
    runner: { title: 'Hall Runner', src: CFG.src, icon: 'book', sandbox: false },
    vanguard: { title: 'VANGUARD', src: CFG.shooterSrc, icon: 'gun', sandbox: true }   // sandboxed: no access to the hub origin or its storage
  };
  var ICONS = {
    book: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 14c-6-4-15-5-24-3v36c9-2 18-1 24 3 6-4 15-5 24-3V11c-9-2-18-1-24 3z" fill="#fef3c7" stroke="#b45309" stroke-width="2.4" stroke-linejoin="round"/><path d="M32 14v36" stroke="#b45309" stroke-width="2.4"/><path d="M13 20c5-1 10 0 15 2M13 27c5-1 10 0 15 2M13 34c5-1 10 0 15 2M51 20c-5-1-10 0-15 2M51 27c-5-1-10 0-15 2M51 34c-5-1-10 0-15 2" fill="none" stroke="#d97706" stroke-width="1.8" stroke-linecap="round" opacity=".75"/></svg>',
    gun: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M6 20h44l4 3v9H33l-5 21c-.4 1.7-1.700 2.500-3.300 2.500h-4.200c-1.900 0-3.100-1.500-2.700-3.300L22 32h-4l-3 4H6z" fill="#e2e8f0" stroke="#0f172a" stroke-width="2.4" stroke-linejoin="round"/><rect x="10" y="22.5" width="30" height="3" rx="1.2" fill="#0f172a" opacity=".35"/><path d="M26 32c0 5 3 7 8 7" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round"/><circle cx="50" cy="26.500" r="1.700" fill="#f59e0b"/></svg>'
  };
  var ov = null, ovId = '', pushed = false, ki = 0, wi = 0, typed = '', taps = [], ptaps = [], styled = false, prevOv = '', pop = null, popT = 0;
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
      '.lfhs-egg-pop{position:fixed;right:max(22px,env(safe-area-inset-right,0px));bottom:calc(96px + env(safe-area-inset-bottom,0px));z-index:2147482998;width:76px;height:76px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:radial-gradient(circle at 30% 25%,rgba(255,255,255,.3),rgba(15,23,42,.8));-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);box-shadow:0 10px 34px rgba(0,0,0,.45);display:grid;place-items:center;cursor:pointer;opacity:0;transform:translateY(26px) scale(.4) rotate(-14deg);transition:opacity .35s,transform .6s cubic-bezier(.2,1.4,.3,1);-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}' +
      '.lfhs-egg-pop.on{opacity:1;transform:none;animation:lfhsegg-pulse 2.2s .7s infinite}' +
      '.lfhs-egg-pop.on:active{transform:scale(.92)}' +
      '.lfhs-egg-pop:focus-visible{box-shadow:0 0 0 3px #38bdf8,0 10px 34px rgba(0,0,0,.45)}' +
      '.lfhs-egg-pop svg{width:46px;height:46px;filter:drop-shadow(0 2px 5px rgba(0,0,0,.5));animation:lfhsegg-bob 2.4s ease-in-out infinite}' +
      '@keyframes lfhsegg-spin{to{transform:rotate(360deg)}}' +
      '@keyframes lfhsegg-bob{50%{transform:translateY(-3px) rotate(5deg)}}' +
      '@keyframes lfhsegg-pulse{0%{box-shadow:0 10px 34px rgba(0,0,0,.45),0 0 0 0 rgba(56,189,248,.5)}70%{box-shadow:0 10px 34px rgba(0,0,0,.45),0 0 0 20px rgba(56,189,248,0)}100%{box-shadow:0 10px 34px rgba(0,0,0,.45),0 0 0 0 rgba(56,189,248,0)}}' +
      '@media (prefers-reduced-motion:reduce){.lfhs-egg-ov,.lfhs-egg-ov iframe,.lfhs-egg-pop{transition:none}.lfhs-egg-ring,.lfhs-egg-pop.on,.lfhs-egg-pop svg{animation:none}}';
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
  function open(id) {
    id = GAMES[id] ? id : 'runner';
    if (ov) return; hidePop(true); css();
    var g = GAMES[id];
    var o = document.createElement('div'); o.className = 'lfhs-egg-ov'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', g.title);
    o.innerHTML = '<div class="lfhs-egg-load"><div><div class="lfhs-egg-ring"></div>LOADING</div></div>';
    var f = document.createElement('iframe'); f.title = g.title; f.setAttribute('allow', 'fullscreen; autoplay; gamepad'); f.setAttribute('allowfullscreen', '');
    if (g.sandbox) f.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    f.addEventListener('load', function () {
      if (f.src.indexOf('about:blank') === 0) return;
      var p = probe();
      try { var d = f.contentDocument.documentElement.style; d.setProperty('--sat', p.t); d.setProperty('--sar', p.r); d.setProperty('--sab', p.b); d.setProperty('--sal', p.l); } catch (e) {}
      try { f.contentWindow.postMessage({ lfhs: 'safe-area', t: p.t, r: p.r, b: p.b, l: p.l }, '*'); } catch (e) {}
      o.classList.add('ready');
      setTimeout(function () { try { f.focus(); f.contentWindow.focus(); } catch (e) {} }, 60);
    });
    f.src = g.src; o.insertBefore(f, o.firstChild); document.body.appendChild(o); lock(true);
    requestAnimationFrame(function () { o.classList.add('on'); });
    ov = o; ovId = id; try { history.pushState({ lfhsEgg: 1 }, ''); pushed = true; } catch (e) {}
  }
  function close(fromPop) {
    if (!ov) return; var o = ov; ov = null; ovId = ''; o.classList.remove('on', 'ready'); lock(false);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    setTimeout(function () { var f = o.querySelector('iframe'); if (f) f.src = 'about:blank'; o.remove(); }, 340);
    if (pushed && !fromPop) { pushed = false; try { history.back(); } catch (e) {} } else pushed = false;
  }
  function hidePop(now) {
    clearTimeout(popT); if (!pop) return;
    var p = pop; pop = null; p.classList.remove('on');
    if (now) p.remove(); else setTimeout(function () { p.remove(); }, 420);
  }
  function showPop(id) {                       // the secret was found: a book (runner) or a gun (shooter) pops up; click it to open
    id = GAMES[id] ? id : 'runner';
    if (ov) return; css(); hidePop(true);
    var g = GAMES[id], b = document.createElement('button');
    b.type = 'button'; b.className = 'lfhs-egg-pop'; b.setAttribute('aria-label', 'Open ' + g.title); b.innerHTML = ICONS[g.icon];
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hidePop(true); open(id); });
    document.body.appendChild(b); pop = b;
    requestAnimationFrame(function () { requestAnimationFrame(function () { b.classList.add('on'); }); });
    try { navigator.vibrate && navigator.vibrate([12, 40, 12]); } catch (e) {}
    popT = setTimeout(function () { hidePop(false); }, CFG.popMs);
  }
  function unlock(id) { if (!ov) showPop(id); }
  function fromHash() {
    var h = location.hash.toLowerCase(), id = h === CFG.hash ? 'runner' : (h === CFG.shooterHash ? 'vanguard' : '');
    if (!id) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    open(id);
  }
  function typing(el) { return el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); }

  function onKey(e) {
    if (ov || !e || !e.key || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.key === 'Escape' && pop) { hidePop(false); return; }
    if (CFG.konami) { if (k === KONAMI[ki]) { if (++ki === KONAMI.length) { ki = 0; unlock('runner'); return; } } else ki = (k === KONAMI[0]) ? 1 : 0; }
    if (CFG.shooterSeq) { if (k === WASD[wi]) { if (++wi === WASD.length) { wi = 0; unlock('vanguard'); return; } } else wi = (k === WASD[0]) ? 1 : 0; }
    if (k.length === 1) {
      typed = (typed + k).slice(-16);
      if (CFG.word && typed.slice(-CFG.word.length) === CFG.word) { typed = ''; unlock('runner'); }
      else if (CFG.shooterWord && typed.slice(-CFG.shooterWord.length) === CFG.shooterWord) { typed = ''; unlock('vanguard'); }
    }
  }
  function onPtr(e) {
    if (ov || e.button > 0) return; var win = e.view || window, w = win.innerWidth, h = win.innerHeight, s = CFG.cornerSize, c = CFG.corner;
    if (e.target && e.target.closest && e.target.closest('.lfhs-egg-pop')) return;
    var inX = c.charAt(1) === 'r' ? e.clientX > w - s : e.clientX < s, inY = c.charAt(0) === 'b' ? e.clientY > h - s : e.clientY < s;
    if (!(inX && inY)) { taps = []; return; }
    var now = Date.now(); taps = taps.filter(function (t) { return now - t < CFG.tapWindow; }); taps.push(now);
    if (taps.length >= CFG.cornerTaps) { taps = []; unlock('runner'); }
  }
  var PSEL = '[data-profile],#profile,#profile-btn,#profileBtn,#btn-profile,.profile-btn,.profile-button,[aria-label*="rofile" i],[title*="rofile" i],[id*="rofile" i],[class*="rofile" i],[href*="rofile" i]';
  function coarse() { try { return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; } catch (e) { return false; } }
  function profileEl(t) {
    if (!t || !t.closest) return null; var el = null;
    try { el = t.closest(CFG.profile || PSEL); } catch (e) { return null; }
    if (!el || CFG.profile) return el;
    return (el.matches('button,a,[role="button"],img,svg') || el.getBoundingClientRect().width <= 120) ? el : null;   // the button itself, not a big container
  }
  function onClick(e) {                        // phones: 5 quick taps on the profile button
    if (ov || (e.target && e.target.closest && e.target.closest('.lfhs-egg-pop'))) return;
    if (!CFG.profileAnyDevice && !coarse()) return;
    if (!profileEl(e.target)) { ptaps = []; return; }
    var now = Date.now(); ptaps = ptaps.filter(function (t) { return now - t < CFG.profileWindow; }); ptaps.push(now);
    if (ptaps.length >= CFG.profileTaps) { ptaps = []; unlock('vanguard'); }
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
  window.addEventListener('click', onClick, true);
  window.addEventListener('popstate', function () { if (ov) close(true); });
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('message', function (e) {   // games ask to close: accepted only from the open overlay's own iframe
    var d = e.data, f = ov && ov.querySelector('iframe');
    if (!d || typeof d !== 'object' || !f || e.source !== f.contentWindow) return;
    if (d.lfhs === 'hall-runner-exit' || d.lfhs === 'vanguard-exit') close();
  });
  window.LFHSEgg = { open: function (id) { hidePop(true); open(id); }, show: showPop, close: function () { close(); }, isOpen: function () { return !!ov; } };
  if (CFG.hint) try { console.log('%cLFHS%c the hallway has two secrets. One starts with \u2191 \u2191 \u2193 \u2193 \u2190 \u2192 \u2190 \u2192 B A. The other is for shooters.', 'background:#2563eb;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700', 'color:#64748b'); } catch (e) {}
  function boot() { fromHash(); hookFrames(); try { new MutationObserver(hookFrames).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {} setInterval(hookFrames, 3000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
