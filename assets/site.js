/* Site loader – runs for every visitor.
   Adds the discreet 🔒 admin door; the editor itself (editor.js) is loaded only on demand. */
(function () {
  'use strict';
  var me = document.currentScript;
  var base = me ? new URL('.', me.src).href : new URL('assets/', location.href).href;
  window.SITE_EDITOR_BASE = base;

  function loadEditor() {
    if (window.__seLoading) { if (window.SiteEditor) window.SiteEditor.open(); return; }
    window.__seLoading = true;
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = base + 'editor.css';
    document.head.appendChild(css);
    var js = document.createElement('script');
    js.src = base + 'editor.js';
    document.body.appendChild(js);
  }

  var door = document.createElement('button');
  door.type = 'button';
  door.setAttribute('data-se-ui', '');
  door.setAttribute('aria-label', 'כניסת מנחה');
  door.title = 'כניסת מנחה';
  door.textContent = '🔒';
  door.style.cssText = 'display:block;margin:8px auto 0;background:none;border:0;cursor:pointer;opacity:.3;font-size:13px;padding:6px';
  door.onclick = loadEditor;
  (document.getElementById('footer') || document.body).appendChild(door);

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) { e.preventDefault(); loadEditor(); }
  }, true);

  /* Shown inside the Mozello page (full-screen iframe)?
     Tell the parent which page is open so its address bar follows,
     and open external links in a new tab (many sites refuse to be framed). */
  if (window.parent !== window) {
    var root = new URL('../', base).href;
    var here = location.href.split('#')[0];
    var path = here.indexOf(root) === 0 ? here.slice(root.length) : '';
    try { window.parent.postMessage({ type: 'sarit-nav', path: path, title: document.title }, '*'); } catch (e) {}
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.target || e.defaultPrevented) return;
      if (a.host && a.host !== location.host) a.target = '_blank';
    });
  }

  var loggedIn = false;
  try { loggedIn = !!sessionStorage.getItem('sarit.admin.session'); } catch (e) {}
  if (loggedIn || location.hash === '#admin') loadEditor();
})();
