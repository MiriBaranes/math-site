/* =====================================================================
   Site editor – live visual editing for the admin (SARIT).
   Loaded on demand by assets/site.js. Visitors never download this file.

   How saving works:
   The page's ORIGINAL source is fetched and parsed (scripts inert). Only the
   content areas (.moze-wysiwyg-editor) the admin actually changed are copied
   back into that source, so Mozello's shell, scripts and anything a script
   generated at runtime (calendar days, countdown digits...) are never baked in.
   ===================================================================== */
(function () {
'use strict';
if (window.SiteEditor) return;

var BASE = window.SITE_EDITOR_BASE || new URL('assets/', location.href).href;
var ROOT = new URL('../', BASE).href;
var ADMIN_USER = 'SARIT';
var SORTABLE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.2/Sortable.min.js';
var KEYS = {
  session: 'sarit.admin.session',
  github: 'sarit.site.github',
  requests: 'sarit.claude.requests',          // shared with feedback.html
  tplDraft: 'sarit.site.templates.draft',
  draft: function (p) { return 'sarit.site.draft:' + p; }
};
var PAGE = pagePath();
var PAGE_NAME = (document.title.split(' - ').pop() || PAGE).trim();
var CARD_NAMES = { cyan: 'תכלת', blue: 'כחול', purple: 'סגול', gold: 'זהב', orange: 'כתום', yellow: 'צהוב', green: 'ירוק', gray: 'אפור', grey: 'אפור', rose: 'ורוד', red: 'אדום', pink: 'ורוד', teal: 'טורקיז' };
var INLINE = /^(SPAN|B|I|U|S|STRONG|EM|SMALL|FONT|BR|SUP|SUB|MARK|CODE)$/;

/* ---------------- state ---------------- */
var src = null;            // parsed original source (Document)
var regions = [];          // live content areas
var dyn = {};              // id -> original innerHTML of script-generated parts
var initial = [];          // saveHtml(region) at load = "published" baseline
var templates = [], tplPublished = '[]';
var editing = false, noting = false, ready = false;
var sel = null, textEl = null, textSnap = null;
var undoStack = [], redoStack = [], lastMut = { key: null, t: 0 };
var sortables = [];
var ui = {};

/* =====================================================================
   Small helpers
   ===================================================================== */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function el(tag, attrs) {
  var n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
  return n;
}
function add(n, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(n, x); }); return; }
  n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
}
function ui_(n) { n.setAttribute('data-se-ui', ''); return n; }
function store(area) {
  return {
    get: function (k, fb) { try { var v = area.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
    set: function (k, v) { try { area.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('הדפדפן לא מאפשר לשמור טיוטה (אין מקום?)', 'err'); return false; } },
    del: function (k) { try { area.removeItem(k); } catch (e) {} }
  };
}
var local = store(window.localStorage), session = store(window.sessionStorage);
function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function isUi(n) { return n && n.nodeType === 1 && (n.hasAttribute('data-se-ui') || !!n.closest('[data-se-ui]')); }
function regionOf(n) { if (!n || n.nodeType !== 1) n = n && n.parentElement; return n ? regions.filter(function (r) { return r.contains(n); })[0] || null : null; }
function rgbToHex(c) {
  var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c || '');
  if (!m || (m[4] !== undefined && +m[4] === 0)) return null;
  return '#' + [m[1], m[2], m[3]].map(function (x) { return (+x).toString(16).padStart(2, '0'); }).join('');
}
function shortText(n, len) { return (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, len || 40); }
function pagePath() {
  var u = location.origin + location.pathname, rel;
  rel = u.indexOf(ROOT) === 0 ? u.slice(ROOT.length) : location.pathname.replace(/^\/+/, '');
  if (!rel || /\/$/.test(rel)) rel += 'index.html';
  try { return decodeURIComponent(rel); } catch (e) { return rel; }
}
function liveRegionsOf(doc) {
  return $$('main .moze-wysiwyg-editor', doc).concat($$('#foottext .moze-wysiwyg-editor', doc));
}

/* ---------- modal / confirm / toast / menu ---------- */
function modal(title, body, buttons, opts) {
  opts = opts || {};
  var prev = document.activeElement, closed = false;
  var foot = el('div', { class: 'se-mfoot' });
  var box = el('div', { class: 'se-modal' + (opts.wide ? ' se-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'se-mhead' }, el('h3', { text: title }), el('button', { type: 'button', class: 'se-x', 'aria-label': 'סגירה', text: '×', onclick: close })),
    el('div', { class: 'se-mbody' }, body), foot);
  var ov = ui_(el('div', { class: 'se-overlay' }, box));
  (buttons || []).filter(Boolean).forEach(function (b) {
    foot.appendChild(el('button', { type: 'button', class: 'se-btn' + (b.primary ? ' se-primary' : '') + (b.danger ? ' se-danger' : ''), text: b.label, onclick: function () {
      if (b.onClick && b.onClick() === false) return;
      close();
    } }));
  });
  ov.addEventListener('mousedown', function (e) { if (e.target === ov && !opts.sticky) close(); });
  ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  document.body.appendChild(ov);
  var first = $('input, textarea, select', box); if (first) setTimeout(function () { first.focus(); }, 30);
  function close() { if (closed) return; closed = true; ov.remove(); if (opts.onClose) opts.onClose(); if (prev && prev.focus) try { prev.focus(); } catch (e) {} }
  return { close: close, box: box };
}
function confirmBox(title, text, okLabel, onOk, opts) {
  opts = opts || {};
  return modal(title, el('p', { style: 'margin:0;line-height:1.6', text: text }), [
    { label: okLabel, primary: !opts.danger, danger: opts.danger, onClick: onOk },
    { label: opts.cancelLabel || 'ביטול', onClick: opts.onCancel }
  ], { onClose: opts.onClose });
}
var toastTimer;
function toast(msg, kind) {
  $$('.se-toast').forEach(function (n) { n.remove(); });
  var t = ui_(el('div', { class: 'se-toast' + (kind ? ' se-' + kind : ''), role: 'status', text: msg }));
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.remove(); }, kind === 'err' ? 7000 : 3200);
}
function popMenu(anchor, items) {
  closeMenus();
  var m = ui_(el('div', { class: 'se-menu', role: 'menu' }));
  items.forEach(function (it) {
    if (it === '-') m.appendChild(el('hr'));
    else if (it.header) m.appendChild(el('div', { class: 'se-mh', text: it.header }));
    else m.appendChild(el('button', { type: 'button', role: 'menuitem', onclick: function () { closeMenus(); it.run(); } },
      it.color ? el('span', { class: 'se-sw', style: 'background:' + it.color }) : null, it.label));
  });
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect();
  var top = r.bottom + 6, left = Math.min(Math.max(8, r.right - m.offsetWidth), innerWidth - m.offsetWidth - 8);
  if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, innerHeight - m.offsetHeight - 8);
  m.style.top = top + 'px'; m.style.left = left + 'px';
  setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
  function outside(e) { if (!m.contains(e.target)) { closeMenus(); } }
  m._off = function () { document.removeEventListener('mousedown', outside, true); };
}
function closeMenus() { $$('.se-menu').forEach(function (m) { if (m._off) m._off(); m.remove(); }); }

/* =====================================================================
   Boot & login
   ===================================================================== */
window.SiteEditor = {
  open: function () { if (!session.get(KEYS.session)) login(); },
  // used by automated tests
  _test: { html: function () { return buildPageHtml(); }, dirty: function () { return dirtyIdx(); }, ready: function () { return ready; }, dyn: function () { return Object.keys(dyn).length; }, select: function (n) { select(n); } }
};
if (session.get(KEYS.session)) start(); else login();

function login() {
  var input = el('input', { class: 'se-input', type: 'text', autocomplete: 'username', placeholder: 'שם משתמש', dir: 'ltr' });
  var err = el('div', { style: 'color:#dc2626;font-size:13px;min-height:18px' });
  var m = modal('כניסת מנחה', el('div', {},
    el('div', { class: 'se-field' }, el('label', { text: 'שם משתמש' }), input), err,
    el('div', { class: 'se-hint', text: 'מצב העריכה מיועד למנחה בלבד. הגולשים רואים רק את התוצאה המפורסמת.' })),
    [{ label: 'כניסה', primary: true, onClick: tryIt }, { label: 'ביטול' }]);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (tryIt() !== false) m.close(); } });
  function tryIt() {
    if (input.value.trim().toUpperCase() !== ADMIN_USER) { err.textContent = 'שם המשתמש אינו תקין.'; input.select(); return false; }
    session.set(KEYS.session, { user: ADMIN_USER, at: Date.now() });
    setTimeout(start, 0);
  }
}

function start() {
  document.body.classList.add('se-admin');
  buildBar();
  setStatus('טוען את קוד הדף...');
  Promise.all([loadSource(), loadTemplates(), loadScript(SORTABLE_URL).catch(function () {})]).then(function () {
    regions = liveRegionsOf(document);
    var srcRegions = liveRegionsOf(src);
    if (regions.length !== srcRegions.length) throw new Error('regions');
    regions.forEach(function (r, i) { markDyn(r, srcRegions[i]); });
    initial = regions.map(saveHtml);
    ready = true;
    restoreDraft(function () {
      setEditing(true);
      updateStatus();
      checkTemplateInstances();
      renderPins();
    });
  }).catch(function (e) {
    console.error(e);
    setStatus('⚠ העריכה לא זמינה');
    modal('לא ניתן לערוך את הדף כאן', el('div', {},
      el('p', { text: 'העורך צריך לקרוא את קוד המקור של הדף, והדפדפן לא מאפשר את זה כשהקובץ נפתח ישירות מהמחשב (file://).' }),
      el('p', { html: 'פתרונות: לעבוד על האתר ב-GitHub Pages, או להריץ שרת מקומי בתיקיית האתר: <code dir="ltr">python3 -m http.server</code> ולפתוח <code dir="ltr">http://localhost:8000</code>.' }),
      el('p', { text: 'מצב "💬 הערות ל-Claude" עובד גם כך.' })), [{ label: 'הבנתי', primary: true }]);
  });
}
function loadScript(url) {
  return new Promise(function (res, rej) { if (window.Sortable) return res(); var s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
function parse(html) { return new DOMParser().parseFromString(html, 'text/html'); }

/* The original HTML: GitHub API when a token is configured (always fresh),
   otherwise the page URL itself. */
function loadSource() {
  var here = location.href.split('#')[0];
  var viaUrl = fetch(here, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw r; return r.text(); });
  if (!ghCfg().token) return viaUrl.then(function (t) { src = parse(t); });
  return Promise.all([ghGet(PAGE).catch(function () { return null; }), viaUrl.catch(function () { return null; })]).then(function (res) {
    var api = res[0] && res[0].content != null ? fromB64(res[0].content) : null, live = res[1];
    if (!api && !live) throw new Error('no source');
    src = parse(api || live);
    if (api && live && api !== live) {
      // GitHub Pages is still serving the previous version (cache) – show the fresh one
      var fresh = liveRegionsOf(src), old = liveRegionsOf(parse(live));
      liveRegionsOf(document).forEach(function (r, i) { if (fresh[i] && old[i] && fresh[i].innerHTML !== old[i].innerHTML) r.innerHTML = fresh[i].innerHTML; });
      toast('מוצגת הגרסה האחרונה שפרסמת – האתר הציבורי יתעדכן תוך כמה דקות');
    }
  });
}

/* Parts of the live DOM that differ from the source were generated by a
   script at runtime. They are locked, and saved back from the source. */
function markDyn(live, orig) {
  var lc = Array.prototype.filter.call(live.children, function (c) { return !c.hasAttribute('data-se-ui'); });
  var oc = orig.children;
  var same = lc.length === oc.length && lc.every(function (c, i) { return c.tagName === oc[i].tagName; });
  if (!same || ownText(live) !== ownText(orig) || (!lc.length && norm(live.textContent) !== norm(orig.textContent))) {
    var id = 'd' + Object.keys(dyn).length;
    dyn[id] = orig.innerHTML;
    live.setAttribute('data-se-dyn', id);
    return;
  }
  lc.forEach(function (c, i) { if (!/^(SCRIPT|STYLE|IFRAME|SVG|svg|TEMPLATE)$/.test(c.tagName)) markDyn(c, oc[i]); });
}
function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function ownText(n) { var t = ''; n.childNodes.forEach(function (c) { if (c.nodeType === 3) t += c.nodeValue; }); return norm(t); }

/* Clean copy of a live node: no editor UI, classes or attributes.
   forSave: also put back script-generated parts from the source. */
function cleanClone(node, forSave) {
  var c = node.cloneNode(true);
  $$('[data-se-ui]', c).forEach(function (n) { n.remove(); });
  [c].concat($$('*', c)).forEach(function (n) {
    if (n.classList && n.classList.length) {
      Array.prototype.slice.call(n.classList).forEach(function (k) { if (/^(se-|sortable-)/.test(k)) n.classList.remove(k); });
      if (!n.classList.length) n.removeAttribute('class');
    }
    n.removeAttribute('contenteditable');
    n.removeAttribute('draggable');
    if (forSave && n.hasAttribute('data-se-dyn')) {
      var id = n.getAttribute('data-se-dyn');
      if (dyn[id] != null) n.innerHTML = dyn[id];
      n.removeAttribute('data-se-dyn');
    }
  });
  if (forSave) $$('[data-se-dyn]', c).forEach(function (n) { n.removeAttribute('data-se-dyn'); });
  return c;
}
function saveHtml(r) { return cleanClone(r, true).innerHTML; }
function snapHtml(r) { return cleanClone(r, false).innerHTML; }

/* =====================================================================
   Toolbar
   ===================================================================== */
function buildBar() {
  if (ui.bar) return;
  function b(id, label, title, cls) { return el('button', { type: 'button', class: 'se-abtn' + (cls ? ' ' + cls : ''), id: id, title: title || label, text: label }); }
  ui.bar = ui_(el('div', { class: 'se-bar', role: 'toolbar', 'aria-label': 'כלי עריכה' },
    el('span', { class: 'se-tag', text: '✏️ SARIT' }),
    el('span', { class: 'se-page', text: PAGE_NAME }),
    el('span', { class: 'se-status', id: 'seStatus' }),
    b('seView', '👁 תצוגת גולש', 'מעבר בין עריכה לבין מה שהגולשים רואים'),
    b('seAdd', '＋ הוספה', 'הוספת כרטיס, קטגוריה, קישור או שבלונה'),
    b('seTpl', '🎨 שבלונות', 'ניהול ועריכת שבלונות'),
    b('seNotes', '💬 הערות ל-Claude', 'לחיצה על כל חלק בדף כדי לכתוב הערה / בקשה'),
    b('seUndo', '↶', 'ביטול (Ctrl+Z)'),
    b('seRedo', '↷', 'ביצוע מחדש (Ctrl+Y)'),
    b('seSettings', '⚙️', 'הגדרות פרסום'),
    el('span', { class: 'se-grow' }),
    b('seExport', '⬇ HTML', 'הורדת קובץ הדף – להעלאה ידנית לגיט'),
    b('sePublish', '🚀 פרסום', 'פרסום ישיר ל-GitHub', 'se-primary'),
    b('seLogout', '🚪', 'יציאה ממצב מנחה')));
  document.body.appendChild(ui.bar);
  $('#seView').onclick = function () { if (ready) setEditing(!editing); };
  $('#seAdd').onclick = function (e) { if (ready) addMenu(e.currentTarget); };
  $('#seTpl').onclick = function () { if (ready) openTemplates(); };
  $('#seNotes').onclick = function () { setNoting(!noting); };
  $('#seUndo').onclick = undo;
  $('#seRedo').onclick = redo;
  $('#seSettings').onclick = openSettings;
  $('#seExport').onclick = function () { if (ready) exportHtml(); };
  $('#sePublish').onclick = function () { if (ready) publish(); };
  $('#seLogout').onclick = logout;
}
function setStatus(text) { var s = $('#seStatus'); if (s) { s.textContent = text; s.classList.remove('se-dirty'); } }
function dirtyIdx() { var out = []; regions.forEach(function (r, i) { if (saveHtml(r) !== initial[i]) out.push(i); }); return out; }
function tplDirty() { return JSON.stringify(templates) !== tplPublished; }
function updateStatus() {
  if (!ready) return;
  var s = $('#seStatus'), d = dirtyIdx().length || tplDirty();
  s.textContent = d ? '● טיוטה – לא פורסם' : '✓ זהה לאתר';
  s.classList.toggle('se-dirty', !!d);
  $('#seUndo').disabled = !undoStack.length;
  $('#seRedo').disabled = !redoStack.length;
}
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('se-editing', on);
  var v = $('#seView'); v.textContent = on ? '👁 תצוגת גולש' : '✏️ חזרה לעריכה'; v.classList.toggle('se-on', !on);
  if (!on) { endText(); select(null); }
  initSortables();
  if (on && !ui.panel) buildPanel();
  if (ui.panel) ui.panel.style.display = on ? '' : 'none';
}
function logout() {
  endText(); select(null); setNoting(false);
  if (ready) saveDraft(true);
  session.del(KEYS.session);
  location.reload();
}

/* =====================================================================
   Undo / redo / change tracking / drafts
   ===================================================================== */
function snapshot() { return regions.map(snapHtml); }
function pushUndo(snap) {
  undoStack.push(snap || snapshot());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
/* mutate(fn, key): one undo step; repeated calls with the same key within
   a second (e.g. dragging a colour picker) are merged into that step. */
function mutate(fn, key) {
  var now = Date.now();
  if (!(key && key === lastMut.key && now - lastMut.t < 1000)) pushUndo();
  lastMut = { key: key, t: now };
  fn();
  changed();
}
function restore(snap) {
  endText();
  regions.forEach(function (r, i) { if (snapHtml(r) !== snap[i]) r.innerHTML = snap[i]; });
  select(null); initSortables(); changed();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); toast('בוטל ↶'); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); toast('בוצע מחדש ↷'); }

var changeTimer;
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(function () { saveDraft(); renderPins(); }, 400);
  updateStatus();
  placeMini();
}
function saveDraft(sync) {
  if (!ready) return;
  var d = dirtyIdx(), map = {};
  d.forEach(function (i) { map[i] = saveHtml(regions[i]); });
  if (d.length) local.set(KEYS.draft(PAGE), { savedAt: Date.now(), regions: map });
  else local.del(KEYS.draft(PAGE));
  if (tplDirty()) local.set(KEYS.tplDraft, templates); else local.del(KEYS.tplDraft);
  updateStatus();
}
function restoreDraft(done) {
  var d = local.get(KEYS.draft(PAGE), null);
  if (!d || !d.regions || !Object.keys(d.regions).length) return done();
  var finished = false;
  function fin() { if (finished) return; finished = true; done(); }
  function apply() {
    Object.keys(d.regions).forEach(function (i) { if (regions[i]) regions[i].innerHTML = d.regions[i]; });
    updateStatus();
  }
  modal('נמצאה טיוטה שלא פורסמה', el('p', { style: 'margin:0;line-height:1.6', text: 'יש לדף הזה טיוטה מ-' + new Date(d.savedAt).toLocaleString('he-IL') + ' עם שינויים שעוד לא פורסמו. לטעון אותה?' }), [
    { label: 'טעינת הטיוטה', primary: true, onClick: function () { apply(); fin(); } },
    { label: 'מחיקת הטיוטה', danger: true, onClick: function () { local.del(KEYS.draft(PAGE)); fin(); } }
  ], { onClose: function () { if (!finished) { apply(); fin(); } } });
}

/* =====================================================================
   Selection, hover, clicks
   ===================================================================== */
function pickTarget(t) {
  if (t.nodeType !== 1) t = t.parentElement;
  var strong = t.closest('[data-tpl], .link-card, .sub-link-card, .back-btn-large, .close-btn');
  if (strong && regionOf(strong)) t = strong;
  while (t && INLINE.test(t.tagName) && t.parentElement && regionOf(t.parentElement) && !regions.includes(t)) t = t.parentElement;
  var d = t.closest('[data-se-dyn]');
  return d && regionOf(d) ? d : t;
}
document.addEventListener('mouseover', function (e) {
  if (!editing || textEl || isUi(e.target)) return;
  $$('.se-hover').forEach(function (n) { n.classList.remove('se-hover'); });
  if (regionOf(e.target)) pickTarget(e.target).classList.add('se-hover');
});
document.addEventListener('click', function (e) {
  if (!editing || noting || isUi(e.target)) return;
  if (!regionOf(e.target)) return;                     // menu, header: normal behaviour
  if (textEl && textEl.contains(e.target)) { e.preventDefault(); return; }  // caret placement only
  if (e.altKey) return;                                // Alt+click = use the page normally
  if (e.target.closest('label.close-btn')) return;     // ✕ still closes popups
  e.preventDefault(); e.stopPropagation();
  if (textEl) endText();
  var t = pickTarget(e.target);
  if (t === sel && canText(t)) startText(t); else select(t);
}, true);
document.addEventListener('dblclick', function (e) {
  if (!editing || noting || isUi(e.target) || !regionOf(e.target)) return;
  var t = pickTarget(e.target);
  if (canText(t)) { e.preventDefault(); select(t); startText(t); }
}, true);
document.addEventListener('mousedown', function (e) {
  if (textEl && !textEl.contains(e.target) && !isUi(e.target)) endText();
}, true);
document.addEventListener('keydown', function (e) {
  if (!ready) return;
  var inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
  var k = (e.key || '').toLowerCase();
  if (textEl) {
    if (k === 'escape') { e.preventDefault(); endText(); }
    else if (k === 'enter' && !e.shiftKey && singleLine(textEl)) { e.preventDefault(); endText(); }
    return;
  }
  if (inField) return;
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (k === 'escape') {
    if (noting) setNoting(false);
    else if ($$('.modal-toggle:checked').length) $$('.modal-toggle:checked').forEach(function (c) { c.checked = false; });
    else select(null);
  }
  else if (editing && sel && (k === 'delete')) { e.preventDefault(); removeSel(); }
}, true);
document.addEventListener('paste', function (e) {
  if (!textEl || !textEl.contains(e.target)) return;
  e.preventDefault();
  var t = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (singleLine(textEl)) t = t.replace(/\s*\n\s*/g, ' ');
  document.execCommand('insertText', false, t);
});
window.addEventListener('resize', function () { placeMini(); renderPins(); });

function select(n) {
  if (sel) sel.classList.remove('se-sel');
  sel = n && regionOf(n) ? n : null;
  if (sel) sel.classList.add('se-sel');
  placeMini();
  renderPanel();
}
function kindOf(n) {
  if (!n) return '';
  if (regions.includes(n)) return 'אזור תוכן';
  if (n.hasAttribute('data-se-dyn')) return 'תוכן אוטומטי (סקריפט)';
  if (n.hasAttribute('data-tpl')) { var t = tplById(n.getAttribute('data-tpl')); return 'שבלונה: ' + (t ? t.name : n.getAttribute('data-tpl')); }
  if (n.classList.contains('link-card')) return n.tagName === 'LABEL' ? 'כרטיס חלון קופץ' : 'כרטיס קישור';
  if (n.classList.contains('sub-link-card')) return 'קישור משני';
  if (n.classList.contains('category-section')) return 'קטגוריה';
  if (n.classList.contains('links-grid') || n.classList.contains('sub-links-grid')) return 'רשת כרטיסים';
  if (n.classList.contains('modal-content')) return 'חלון קופץ';
  if (n.classList.contains('ms-section')) return 'אזור כרטיסים';
  if (/^H[1-6]$/.test(n.tagName) || n.classList.contains('category-title')) return 'כותרת';
  if (n.tagName === 'A') return 'קישור';
  if (n.tagName === 'LABEL') return 'כפתור';
  if (n.tagName === 'IMG') return 'תמונה';
  if (n.tagName === 'IFRAME') return 'מסגרת מוטמעת';
  if (n.tagName === 'P') return 'פסקה';
  return 'רכיב';
}
function canText(n) {
  if (!n || regions.includes(n) || n.closest('[data-se-dyn]')) return false;
  if (/^(IMG|IFRAME|INPUT|HR|SCRIPT|STYLE|SVG|svg|VIDEO)$/.test(n.tagName)) return false;
  if ($('script, iframe, input, .links-grid, .sub-links-grid, .category-section, .modal-overlay', n)) return false;
  return norm(n.textContent).length > 0 || n.children.length === 0;
}
function singleLine(n) { return /^(A|LABEL|H[1-6]|SPAN|BUTTON)$/.test(n.tagName) || n.classList.contains('link-card') || n.classList.contains('sub-link-card'); }

/* ---------- mini toolbar ---------- */
function placeMini() {
  if (!ui.mini) {
    ui.mini = ui_(el('div', { class: 'se-mini' }));
    document.body.appendChild(ui.mini);
  }
  var m = ui.mini;
  if (!sel || !editing || textEl || !document.contains(sel)) { m.style.display = 'none'; return; }
  m.replaceChildren.apply(m, [
    el('span', { class: 'se-kind', text: kindOf(sel) }),
    regions.includes(sel) ? null : el('button', { type: 'button', class: 'se-handle', title: 'גרירה להזזה', text: '⠿', onpointerdown: startDrag }),
    regions.includes(sel) ? null : el('button', { type: 'button', title: 'הזזה אחורה', text: '▲', onclick: function () { moveSel(-1); } }),
    regions.includes(sel) ? null : el('button', { type: 'button', title: 'הזזה קדימה', text: '▼', onclick: function () { moveSel(1); } }),
    canText(sel) ? el('button', { type: 'button', title: 'עריכת טקסט (או לחיצה כפולה)', text: '✏️', onclick: function () { startText(sel); } }) : null,
    regions.includes(sel) ? null : el('button', { type: 'button', title: 'שכפול', text: '⧉', onclick: dupSel }),
    sel.parentElement && regionOf(sel.parentElement) ? el('button', { type: 'button', title: 'בחירת הרכיב העוטף', text: '⬆', onclick: function () { select(sel.parentElement); } }) : null,
    regions.includes(sel) ? null : el('button', { type: 'button', title: 'מחיקה (Delete)', text: '🗑', onclick: removeSel })
  ].filter(Boolean));
  m.style.display = 'flex';
  var r = sel.getBoundingClientRect();
  var top = r.top + scrollY - m.offsetHeight - 8;
  if (top < scrollY + 60) top = r.bottom + scrollY + 8;
  var left = Math.min(Math.max(8, r.right + scrollX - m.offsetWidth), scrollX + document.documentElement.clientWidth - m.offsetWidth - 8);
  m.style.top = top + 'px'; m.style.left = left + 'px';
}
function siblings(n) { return Array.prototype.filter.call(n.parentElement.children, function (c) { return !c.hasAttribute('data-se-ui') && !/^(SCRIPT|STYLE|META|TITLE|LINK)$/.test(c.tagName); }); }
function moveSel(dir) {
  var sib = siblings(sel), i = sib.indexOf(sel), other = sib[i + dir];
  if (!other) { toast(dir < 0 ? 'זה כבר הראשון' : 'זה כבר האחרון'); return; }
  mutate(function () { other.parentElement.insertBefore(sel, dir < 0 ? other : other.nextSibling); });
  flash(sel);
}
function dupSel() {
  var c;
  mutate(function () {
    c = cleanClone(sel, true);
    sel.parentElement.insertBefore(c, sel.nextSibling);
  });
  select(c); flash(c); initSortables();
}
function removeSel() {
  if (!sel || regions.includes(sel)) return;
  var n = sel, label = kindOf(n) + (shortText(n) ? ' "' + shortText(n, 30) + '"' : '');
  var modalId = n.tagName === 'LABEL' && n.classList.contains('link-card') ? n.getAttribute('for') : null;
  var others = modalId ? $$('label[for="' + CSS.escape(modalId) + '"].link-card').filter(function (x) { return x !== n; }).length : 0;
  if (modalId && !others && document.getElementById(modalId)) {
    modal('מחיקת ' + label, el('p', { text: 'הכרטיס פותח חלון קופץ. למחוק גם את החלון ואת כל התוכן שבו?' }), [
      { label: 'מחיקת הכרטיס והחלון', danger: true, onClick: function () { mutate(function () { removeModal(modalId); n.remove(); }); select(null); toast('נמחק – ↶ לביטול'); } },
      { label: 'רק הכרטיס', onClick: function () { mutate(function () { n.remove(); }); select(null); toast('נמחק – ↶ לביטול'); } },
      { label: 'ביטול' }
    ]);
    return;
  }
  mutate(function () { n.remove(); });
  select(null);
  toast('נמחק: ' + label + ' – ↶ לביטול');
}
function flash(n) { if (!n) return; n.classList.remove('se-flash'); void n.offsetWidth; n.classList.add('se-flash'); setTimeout(function () { n.classList.remove('se-flash'); }, 1300); }

/* generic drag of the selected element among its siblings */
function startDrag(e) {
  e.preventDefault();
  var n = sel, parent = n.parentElement, snap = snapshot(), moved = false;
  var rtl = getComputedStyle(parent).direction === 'rtl';
  n.classList.add('sortable-chosen');
  function move(ev) {
    var t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!t || !parent.contains(t) || n.contains(t)) return;
    while (t.parentElement !== parent) t = t.parentElement;
    if (t.hasAttribute('data-se-ui')) return;
    var r = t.getBoundingClientRect(), nr = n.getBoundingClientRect();
    var sameRow = Math.abs(r.top - nr.top) < Math.min(r.height, nr.height) / 2;
    var after = sameRow ? (rtl ? ev.clientX < r.left + r.width / 2 : ev.clientX > r.left + r.width / 2) : ev.clientY > r.top + r.height / 2;
    var ref = after ? t.nextSibling : t;
    if (ref !== n && ref !== n.nextSibling) { parent.insertBefore(n, ref); moved = true; placeMini(); }
  }
  function up() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    n.classList.remove('sortable-chosen');
    if (moved) { pushUndo(snap); changed(); flash(n); }
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/* drag & drop of cards and categories (SortableJS) */
function initSortables() {
  sortables.forEach(function (s) { try { s.destroy(); } catch (e) {} });
  sortables = [];
  if (!editing || !window.Sortable) return;
  var snap = null;
  var common = {
    animation: 160, fallbackOnBody: true, swapThreshold: 0.6,
    filter: '[data-se-ui], .se-text, [data-se-dyn]', preventOnFilter: false,
    onStart: function () { snap = snapshot(); endText(); },
    onEnd: function (ev) { if (snap && (ev.from !== ev.to || ev.oldIndex !== ev.newIndex)) { pushUndo(snap); changed(); flash(ev.item); select(ev.item); } snap = null; }
  };
  regions.forEach(function (r) {
    $$('.links-grid, .sub-links-grid', r).forEach(function (g) {
      if (g.closest('[data-se-dyn]')) return;
      sortables.push(Sortable.create(g, Object.assign({ group: 'se-cards' }, common)));
    });
    var parents = [];
    $$('.category-section', r).forEach(function (c) { if (parents.indexOf(c.parentElement) < 0) parents.push(c.parentElement); });
    parents.forEach(function (p) {
      sortables.push(Sortable.create(p, Object.assign({ group: 'se-cats', draggable: '.category-section', handle: '.category-title' }, common)));
    });
  });
}

/* =====================================================================
   Inline text editing + formatting bar
   ===================================================================== */
function startText(n) {
  if (!n || !canText(n)) return;
  endText();
  textEl = n; textSnap = snapshot();
  n.classList.add('se-text');
  n.setAttribute('contenteditable', 'true');
  n.focus();
  try { var r = document.createRange(); r.selectNodeContents(n); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
  showFmt();
  placeMini();
}
function endText() {
  if (!textEl) return;
  var n = textEl; textEl = null;
  n.removeAttribute('contenteditable');
  n.classList.remove('se-text');
  $$('font', n).forEach(function (f) { if (!f.attributes.length) f.replaceWith.apply(f, Array.prototype.slice.call(f.childNodes)); });
  if (ui.fmt) ui.fmt.remove(), ui.fmt = null;
  var now = snapshot();
  if (JSON.stringify(now) !== JSON.stringify(textSnap)) { pushUndo(textSnap); changed(); }
  textSnap = null;
  placeMini(); renderPanel();
}
function exec(cmd, val) {
  if (!textEl) return;
  textEl.focus();
  try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
  document.execCommand(cmd, false, val);
}
function sizeBy(f) {
  exec('fontSize', '7');
  $$('font[size="7"]', textEl).forEach(function (n) {
    var base = parseFloat(getComputedStyle(n.parentElement).fontSize) || 16;
    var s = el('span', { style: 'font-size:' + Math.round(base * f) + 'px' });
    while (n.firstChild) s.appendChild(n.firstChild);
    n.replaceWith(s);
  });
  $$('span[style*="xxx-large"], span[style*="-webkit-xxx-large"]', textEl).forEach(function (n) {
    var base = parseFloat(getComputedStyle(n.parentElement).fontSize) || 16;
    n.style.fontSize = Math.round(base * f) + 'px';
  });
}
function showFmt() {
  if (ui.fmt) ui.fmt.remove();
  function b(label, title, fn) { return el('button', { type: 'button', title: title, html: label, onmousedown: function (e) { e.preventDefault(); }, onclick: fn }); }
  function color(label, title, cmd) {
    var i = el('input', { type: 'color', value: '#e11d48' });
    i.addEventListener('input', function () { if (!textEl) return; textEl.focus(); restoreRange(); exec(cmd, i.value); saveRange(); });
    return el('label', { title: title, onmousedown: function () { saveRange(); } }, el('span', { html: label }), i);
  }
  ui.fmt = ui_(el('div', { class: 'se-fmt' },
    b('<b>B</b>', 'מודגש', function () { exec('bold'); }),
    b('<i>I</i>', 'נטוי', function () { exec('italic'); }),
    b('<u>U</u>', 'קו תחתון', function () { exec('underline'); }),
    b('<s>S</s>', 'קו חוצה', function () { exec('strikeThrough'); }),
    el('span', { class: 'se-sep' }),
    b('A+', 'הגדלת טקסט', function () { sizeBy(1.2); }),
    b('A−', 'הקטנת טקסט', function () { sizeBy(0.85); }),
    color('<span style="border-bottom:3px solid #e11d48">A</span>', 'צבע טקסט', 'foreColor'),
    color('🖍', 'צבע הדגשה', 'hiliteColor'),
    el('span', { class: 'se-sep' }),
    b('🔗', 'הוספת קישור לטקסט המסומן', linkSelection),
    b('⛓️‍💥', 'הסרת קישור', function () { exec('unlink'); }),
    b('•', 'רשימה', function () { exec('insertUnorderedList'); }),
    b('⌫', 'ניקוי עיצוב', function () { exec('removeFormat'); }),
    el('span', { class: 'se-sep' }),
    el('button', { type: 'button', class: 'se-done', text: '✓ סיום', onmousedown: function (e) { e.preventDefault(); }, onclick: endText })));
  document.body.appendChild(ui.fmt);
}
var savedRange = null;
function saveRange() { var s = getSelection(); if (s.rangeCount) savedRange = s.getRangeAt(0).cloneRange(); }
function restoreRange() { if (!savedRange) return; var s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
function linkSelection() {
  saveRange();
  if (!savedRange || savedRange.collapsed) { toast('קודם מסמנים את הטקסט שיהפוך לקישור'); return; }
  var url = el('input', { class: 'se-input', dir: 'ltr', placeholder: 'https://...' });
  var nt = el('input', { type: 'checkbox', checked: true });
  modal('🔗 הוספת קישור', el('div', {},
    el('div', { class: 'se-field' }, el('label', { text: 'כתובת הקישור' }), url),
    el('label', { class: 'se-check' }, nt, 'פתיחה בלשונית חדשה')), [
    { label: 'הוספה', primary: true, onClick: function () {
      var u = url.value.trim(); if (!u) return false;
      if (!/^(https?:|mailto:|tel:|#|\.|\/)/i.test(u)) u = 'https://' + u;
      textEl.focus(); restoreRange();
      document.execCommand('createLink', false, u);
      $$('a', textEl).forEach(function (a) { if (a.getAttribute('href') === u && nt.checked) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } });
    } },
    { label: 'ביטול' }]);
}

/* =====================================================================
   Inspector panel (properties of the selected element)
   ===================================================================== */
function buildPanel() {
  ui.panel = ui_(el('aside', { class: 'se-panel', 'aria-label': 'מאפייני הרכיב' },
    el('header', {}, el('h3', { id: 'sePanelTitle', text: 'מאפיינים' }),
      el('button', { type: 'button', class: 'se-x', title: 'כיווץ / פתיחה', text: '⇕', onclick: function () { ui.panel.classList.toggle('se-collapsed'); } })),
    el('div', { class: 'se-body', id: 'sePanelBody' })));
  document.body.appendChild(ui.panel);
  renderPanel();
}
function group(title) { var g = el('div', { class: 'se-group' }); if (title) g.appendChild(el('h4', { text: title })); for (var i = 1; i < arguments.length; i++) add(g, arguments[i]); return g; }
function field(label, input, hint) { return el('div', { class: 'se-field' }, el('label', { text: label }), input, hint ? el('div', { class: 'se-hint', text: hint }) : null); }
function btn(label, fn, cls) { return el('button', { type: 'button', class: 'se-btn' + (cls ? ' ' + cls : ''), text: label, onclick: fn }); }

function renderPanel() {
  if (!ui.panel) return;
  var body = $('#sePanelBody'), title = $('#sePanelTitle');
  if (!sel) {
    title.textContent = 'מצב עריכה';
    body.replaceChildren(group('איך עורכים?',
      el('ul', { style: 'margin:0;padding-inline-start:18px;line-height:1.9;font-size:13.5px' },
        el('li', { text: 'לחיצה על רכיב – בחירה והצגת המאפיינים שלו כאן' }),
        el('li', { text: 'לחיצה כפולה (או ✏️) – עריכת הטקסט במקום' }),
        el('li', { text: 'גרירת כרטיסים וקטגוריות – לשינוי סדר, גם בין קבוצות' }),
        el('li', { text: '⠿ בסרגל הקטן – גרירה של כל רכיב שנבחר' }),
        el('li', { text: 'Alt + לחיצה – שימוש רגיל בדף (פתיחת חלון, מעבר לקישור)' }),
        el('li', { text: 'Esc – סגירת חלונות קופצים / ביטול בחירה' }))),
      group('הוספה מהירה', btn('＋ הוספת רכיב / שבלונה', function (e) { addMenu(e.currentTarget); }, 'se-primary se-full')),
      modalsGroup());
    return;
  }
  var n = sel;
  title.textContent = kindOf(n);
  var parts = [];
  if (n.closest('[data-se-dyn]')) {
    parts.push(el('div', { class: 'se-warn', text: '🔒 החלק הזה נוצר אוטומטית ע״י סקריפט בדף (למשל ימי לוח שנה או ספירה לאחור). אפשר לשנות אותו רק דרך "</> עריכת HTML" של הרכיב העוטף, או לבקש מ-Claude.' }));
    parts.push(group('', btn('⬆ בחירת הרכיב העוטף', function () { select(n.parentElement); }, 'se-full')));
    body.replaceChildren.apply(body, parts);
    return;
  }
  if (canText(n)) parts.push(group('טקסט', el('div', { class: 'se-hint', text: shortText(n, 120) || '(ריק)' }), btn('✏️ עריכת הטקסט', function () { startText(n); }, 'se-full')));
  if (n.classList.contains('link-card') || n.classList.contains('sub-link-card') || n.tagName === 'A' || (n.tagName === 'LABEL' && n.getAttribute('for'))) parts.push(linkGroup(n));
  var cards = cardColors();
  if (n.classList.contains('link-card') && cards.length) parts.push(cardGroup(n, cards));
  if (n.classList.contains('category-section')) parts.push(categoryGroup(n));
  if (n.classList.contains('links-grid') || n.classList.contains('sub-links-grid') || n.classList.contains('category-section') || n.classList.contains('ms-section')) parts.push(group('הוספה בתוך הרכיב', contextAdds(n).map(function (it) { return btn(it.label, it.run, 'se-full'); })));
  if (n.tagName === 'IMG') parts.push(imageGroup(n));
  if (n.hasAttribute('data-tpl')) parts.push(tplGroup(n));
  if (!regions.includes(n) && n.tagName !== 'IFRAME') parts.push(styleGroup(n));
  parts.push(group('פעולות',
    el('div', { class: 'se-row' },
      btn('</> עריכת HTML', function () { codeEdit(n); }),
      regions.includes(n) ? null : btn('💾 שמירה כשבלונה', function () { saveAsTemplate(n); }),
      btn('💬 הערה ל-Claude', function () { noteDialog(n); }))));
  body.replaceChildren.apply(body, parts);
}

function modalsGroup() {
  var ids = modalList();
  if (!ids.length) return null;
  return group('חלונות קופצים בדף (' + ids.length + ')',
    el('div', { class: 'se-hint', text: 'פתיחת חלון לעריכת התוכן שבתוכו:' }),
    ids.map(function (m) { return btn('📂 ' + m.title, function () { openModal(m.id); }, 'se-full se-small'); }));
}
function modalList() {
  var out = [];
  regions.forEach(function (r) {
    $$('input.modal-toggle[id]', r).forEach(function (i) {
      var ov = i.nextElementSibling, h = ov && $('.modal-header-sticky h2, h2, h3', ov);
      out.push({ id: i.id, title: h ? shortText(h, 40) : i.id });
    });
  });
  return out;
}
function openModal(id) {
  $$('.modal-toggle:checked').forEach(function (c) { c.checked = false; });
  var c = document.getElementById(id); if (!c) return;
  c.checked = true;
  var content = c.nextElementSibling && $('.modal-content', c.nextElementSibling);
  select(content || null);
  toast('החלון פתוח לעריכה. סגירה: ✕ בחלון או Esc');
}
function removeModal(id) {
  var c = document.getElementById(id); if (!c) return;
  var ov = c.nextElementSibling;
  if (ov && ov.classList.contains('modal-overlay')) ov.remove();
  c.remove();
}

function linkGroup(n) {
  var isPopup = n.tagName === 'LABEL' && n.getAttribute('for');
  var g = group('קישור');
  if (n.classList.contains('link-card') || n.classList.contains('sub-link-card') || n.tagName === 'A' || n.tagName === 'LABEL') {
    var canPopup = n.classList.contains('link-card');
    if (canPopup) g.appendChild(el('div', { class: 'se-row', style: 'margin-bottom:8px' },
      el('button', { type: 'button', class: 'se-btn se-small', 'aria-pressed': String(!isPopup), text: '🔗 קישור לאתר', onclick: function () { if (isPopup) convertCard(n, 'link'); } }),
      el('button', { type: 'button', class: 'se-btn se-small', 'aria-pressed': String(!!isPopup), text: '📂 פותח חלון קופץ', onclick: function () { if (!isPopup) convertCard(n, 'popup'); } })));
  }
  if (isPopup) {
    var s = el('select', { class: 'se-select' }, modalList().map(function (m) { var o = el('option', { value: m.id, text: m.title }); if (m.id === n.getAttribute('for')) o.selected = true; return o; }));
    s.onchange = function () { mutate(function () { n.setAttribute('for', s.value); }); };
    g.appendChild(field('החלון שנפתח', s));
    g.appendChild(el('div', { class: 'se-row' },
      btn('📂 פתיחת החלון לעריכה', function () { openModal(n.getAttribute('for')); }),
      btn('＋ חלון חדש', function () { var id; mutate(function () { id = createModal(shortText(n, 40) || 'חלון חדש', n); n.setAttribute('for', id); }); renderPanel(); openModal(id); })));
  } else if (n.tagName === 'A') {
    var url = el('input', { class: 'se-input', dir: 'ltr', value: n.getAttribute('href') || '' });
    url.oninput = function () { mutate(function () { n.setAttribute('href', url.value.trim()); }, 'href'); };
    var nt = el('input', { type: 'checkbox', checked: n.target === '_blank' });
    nt.onchange = function () { mutate(function () { if (nt.checked) { n.target = '_blank'; n.rel = 'noopener noreferrer'; } else { n.removeAttribute('target'); n.removeAttribute('rel'); } }); };
    g.appendChild(field('כתובת', url));
    g.appendChild(el('label', { class: 'se-check' }, nt, 'פתיחה בלשונית חדשה'));
    g.appendChild(btn('↗ בדיקת הקישור', function () { window.open(n.href, '_blank', 'noopener'); }, 'se-small'));
  }
  return g;
}
function convertCard(n, to) {
  var id = null;
  if (to === 'popup') {
    var list = modalList();
    var menu = [{ header: 'לאיזה חלון הכרטיס יפתח?' }, { label: '＋ חלון חדש (ריק)', run: function () { go(null); } }].concat(list.length ? ['-'] : [], list.map(function (m) { return { label: '📂 ' + m.title, run: function () { go(m.id); } }; }));
    popMenu($('#sePanelBody'), menu);
    return;
  }
  go(null);
  function go(existing) {
    var c;
    mutate(function () {
      c = document.createElement(to === 'popup' ? 'label' : 'a');
      Array.prototype.forEach.call(n.attributes, function (a) { if (!/^(href|for|target|rel)$/.test(a.name)) c.setAttribute(a.name, a.value); });
      c.innerHTML = n.innerHTML;
      if (to === 'popup') { id = existing || createModal(shortText(n, 40) || 'חלון חדש', n); c.setAttribute('for', id); }
      else { c.setAttribute('href', 'https://'); c.target = '_blank'; c.rel = 'noopener noreferrer'; }
      n.replaceWith(c);
    });
    initSortables(); select(c); flash(c);
    if (to === 'link') { var u = $('#sePanelBody input[dir=ltr]'); if (u) { u.focus(); u.select(); } toast('הדביקי את כתובת הקישור בפאנל'); }
  }
}
function createModal(title, near) {
  var id = 'modal-' + uid('');
  var r = regionOf(near) || regions[0];
  var esc = function (s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var html = '\n<input type="checkbox" id="' + id + '" class="modal-toggle">\n' +
    '<div class="modal-overlay">\n<div class="modal-content">\n' +
    '<div class="modal-header-sticky"><label for="' + id + '" class="back-btn-large">⬅️ חזור לעמוד הבית</label>' +
    '<h2 class="ms-title" style="margin-bottom:0;">' + esc(title) + '</h2><label for="' + id + '" class="close-btn" title="סגור חלון">✕</label></div>\n' +
    '<div class="category-section" style="border-top: 3px solid #0ea5e9;"><h3 class="category-title">קטגוריה חדשה</h3>' +
    '<div class="sub-links-grid"><a href="https://" target="_blank" class="sub-link-card">קישור חדש 🔗</a></div></div>\n' +
    '<div class="modal-footer-sticky" style="margin-top: 25px;"><label for="' + id + '" class="back-btn-large">⬅️ חזור לעמוד הבית</label></div>\n' +
    '</div>\n</div>\n';
  var overlays = $$('.modal-overlay', r);
  var anchor = overlays[overlays.length - 1];
  var tpl = document.createElement('template'); tpl.innerHTML = html;
  if (anchor) anchor.after(tpl.content); else r.appendChild(tpl.content);
  return id;
}

function cardColors() {
  if (cardColors.cache) return cardColors.cache;
  var found = {};
  function walk(rules) {
    Array.prototype.forEach.call(rules || [], function (rule) {
      if (rule.cssRules) walk(rule.cssRules);
      if (!rule.selectorText) return;
      var m, re = /\.card-([a-z0-9]+)/g;
      while ((m = re.exec(rule.selectorText))) {
        var c = rule.style.borderColor || rule.style.borderTopColor || rule.style.color || rule.style.backgroundColor;
        if (!found[m[1]] || (!found[m[1]].color && c)) found[m[1]] = { cls: 'card-' + m[1], name: CARD_NAMES[m[1]] || m[1], color: c || '' };
      }
    });
  }
  Array.prototype.forEach.call(document.styleSheets, function (ss) { try { walk(ss.cssRules); } catch (e) {} });
  return (cardColors.cache = Object.keys(found).map(function (k) { return found[k]; }));
}
function hasRule(sel) {
  var ok = false;
  Array.prototype.forEach.call(document.styleSheets, function (ss) { try { Array.prototype.forEach.call(ss.cssRules, function (r) { if (r.selectorText && r.selectorText.indexOf(sel) >= 0) ok = true; }); } catch (e) {} });
  return ok;
}
function cardGroup(n, cards) {
  var cur = cards.filter(function (c) { return n.classList.contains(c.cls); })[0];
  var chips = el('div', { class: 'se-chips' }, cards.map(function (c) {
    return el('button', { type: 'button', class: 'se-chip', 'aria-pressed': String(cur === c), onclick: function () {
      mutate(function () { cards.forEach(function (x) { n.classList.remove(x.cls); }); n.classList.add(c.cls); });
      renderPanel();
    } }, el('span', { class: 'se-dot', style: 'background:' + (c.color || '#ccc') }), c.name);
  }));
  var g = group('צבע הכרטיס', chips);
  if (hasRule('.glowing-border')) {
    var glow = el('input', { type: 'checkbox', checked: n.classList.contains('glowing-border') });
    glow.onchange = function () { mutate(function () { n.classList.toggle('glowing-border', glow.checked); }); };
    g.appendChild(el('label', { class: 'se-check', style: 'margin-top:8px' }, glow, '✨ מסגרת זוהרת (להבלטה)'));
  }
  if (hasRule('.new-badge')) {
    var badge = $('.new-badge', n);
    var nb = el('input', { type: 'checkbox', checked: !!badge });
    nb.onchange = function () { mutate(function () { var b = $('.new-badge', n); if (nb.checked && !b) n.appendChild(el('span', { class: 'new-badge', text: 'חדש' })); else if (!nb.checked && b) b.remove(); }); };
    g.appendChild(el('label', { class: 'se-check' }, nb, '🆕 תגית "חדש"'));
  }
  return g;
}
function categoryGroup(n) {
  var cur = rgbToHex(getComputedStyle(n).borderTopColor) || '#0ea5e9';
  var i = el('input', { type: 'color', value: cur });
  i.oninput = function () { mutate(function () { n.style.borderTop = '3px solid ' + i.value; }, 'cat-border'); };
  return group('קטגוריה', el('div', { class: 'se-color' }, 'צבע הפס העליון', i),
    el('div', { class: 'se-hint', text: 'את שם הקטגוריה עורכים בלחיצה כפולה עליו. גוררים את הקטגוריה בעזרת הכותרת שלה.' }));
}
function imageGroup(n) {
  var s = el('input', { class: 'se-input', dir: 'ltr', value: n.getAttribute('src') || '' });
  s.oninput = function () { mutate(function () { n.setAttribute('src', s.value.trim()); }, 'img-src'); };
  var a = el('input', { class: 'se-input', value: n.getAttribute('alt') || '' });
  a.oninput = function () { mutate(function () { n.setAttribute('alt', a.value); }, 'img-alt'); };
  var w = el('input', { type: 'range', min: 10, max: 100, value: parseInt(n.style.width, 10) || 100 });
  w.oninput = function () { mutate(function () { n.style.width = w.value + '%'; n.style.maxWidth = '100%'; }, 'img-w'); };
  return group('תמונה', field('כתובת התמונה', s, 'אפשר להעלות תמונה ל-GitHub או ל-Google Drive ולהדביק כאן את הקישור'), field('תיאור (לנגישות)', a), field('רוחב', w));
}
function tplGroup(n) {
  var id = n.getAttribute('data-tpl');
  var s = el('select', { class: 'se-select' }, templates.map(function (t) { var o = el('option', { value: t.id, text: t.name }); if (t.id === id) o.selected = true; return o; }));
  s.onchange = function () { var c; mutate(function () { c = renderInstance(n, tplById(s.value)); }); select(c); };
  return group('שבלונה', field('החלפת שבלונה (התוכן נשמר)', s), btn('🎨 עריכת השבלונה', function () { openTemplates(id); }, 'se-full'));
}
function styleGroup(n) {
  var cs = getComputedStyle(n);
  function colorCtl(label, prop, read) {
    var i = el('input', { type: 'color', value: read() || '#ffffff' });
    i.oninput = function () { mutate(function () { n.style.setProperty(prop, i.value, prop === 'background' ? 'important' : ''); if (prop === 'border-color' && !parseFloat(cs.borderTopWidth)) n.style.border = '2px solid ' + i.value; }, 'style-' + prop); };
    return el('div', { class: 'se-color' }, label, i, el('button', { type: 'button', text: 'איפוס', onclick: function () { mutate(function () { n.style.removeProperty(prop); if (prop === 'border-color') n.style.removeProperty('border'); }); renderPanel(); } }));
  }
  var size = el('input', { type: 'number', class: 'se-input', min: 8, max: 120, value: Math.round(parseFloat(cs.fontSize)) });
  size.oninput = function () { mutate(function () { n.style.fontSize = size.value + 'px'; }, 'fs'); };
  var radius = el('input', { type: 'range', min: 0, max: 40, value: parseInt(cs.borderTopLeftRadius, 10) || 0 });
  radius.oninput = function () { mutate(function () { n.style.borderRadius = radius.value + 'px'; }, 'radius'); };
  var align = el('div', { class: 'se-row' }, [['right', '⇥ ימין'], ['center', '↔ מרכז'], ['left', '⇤ שמאל']].map(function (a) {
    return el('button', { type: 'button', class: 'se-btn se-small', 'aria-pressed': String(cs.textAlign === a[0]), text: a[1], onclick: function () { mutate(function () { n.style.textAlign = a[0]; }); renderPanel(); } });
  }));
  return group('עיצוב',
    el('div', { class: 'se-colors' },
      colorCtl('רקע', 'background', function () { return rgbToHex(cs.backgroundColor); }),
      colorCtl('טקסט', 'color', function () { return rgbToHex(cs.color); }),
      colorCtl('מסגרת', 'border-color', function () { return rgbToHex(cs.borderTopColor); })),
    el('div', { class: 'se-row', style: 'margin-top:10px' }, el('div', { class: 'se-grow' }, field('גודל טקסט (px)', size)), el('div', { class: 'se-grow' }, field('עיגול פינות', radius))),
    field('יישור טקסט', align));
}

function codeEdit(n) {
  var isFrame = n.tagName === 'IFRAME' && n.hasAttribute('srcdoc');
  var isRegion = regions.includes(n);
  var clean = cleanClone(n, true);
  var ta = el('textarea', { class: 'se-input se-code', spellcheck: 'false' });
  ta.value = isFrame ? n.getAttribute('srcdoc') : isRegion ? clean.innerHTML : clean.outerHTML;
  modal('</> עריכת HTML – ' + kindOf(n), el('div', {},
    el('div', { class: 'se-hint', text: isFrame ? 'זה התוכן של המסגרת המוטמעת (srcdoc).' : 'שינוי ישיר של הקוד. סקריפטים חדשים ירוצו רק אחרי פרסום ורענון.' }),
    ta), [
    { label: 'החלה', primary: true, onClick: function () {
      var out = null;
      mutate(function () {
        if (isFrame) { n.setAttribute('srcdoc', ta.value); out = n; return; }
        if (isRegion) { n.innerHTML = ta.value; out = n; return; }
        var t = document.createElement('template'); t.innerHTML = ta.value.trim();
        out = t.content.firstElementChild;
        n.replaceWith(t.content);
      });
      initSortables(); select(out); flash(out);
    } },
    { label: 'ביטול' }], { wide: true, sticky: true });
}

/* =====================================================================
   Adding things
   ===================================================================== */
function curCardColor(n) {
  var cards = cardColors(), c = n && cards.filter(function (x) { return n.classList && n.classList.contains(x.cls); })[0];
  return c ? c.cls : (cards[0] ? cards[0].cls : 'card-cyan');
}
function contextAdds(n) {
  var items = [];
  if (!n) return items;
  var grid = n.closest('.links-grid'), sub = n.closest('.sub-links-grid'), cat = n.closest('.category-section'), ms = n.closest('.ms-section');
  var refCard = n.classList.contains('link-card') ? n : grid && $('.link-card', grid);
  if (grid || n.classList.contains('ms-section')) {
    var g = grid || $('.links-grid', n);
    if (g) {
      items.push({ label: '🔗 כרטיס קישור חדש', run: function () { insert(htmlNode('<a href="https://" target="_blank" class="link-card ' + curCardColor(refCard) + '">קישור חדש 🔗</a>'), g, n.parentElement === g ? n : null); } });
      items.push({ label: '📂 כרטיס שפותח חלון קופץ', run: function () {
        var c;
        mutate(function () { var id = createModal('חלון חדש', g); c = htmlNode('<label for="' + id + '" class="link-card ' + curCardColor(refCard) + '">חלון חדש 📂</label>'); place(c, g, n.parentElement === g ? n : null); }, null);
        afterInsert(c);
      } });
    }
  }
  if (sub || cat) {
    var s = sub || (cat && $('.sub-links-grid', cat));
    if (s) items.push({ label: '🔗 קישור משני חדש', run: function () { insert(htmlNode('<a href="https://" target="_blank" class="sub-link-card">קישור חדש 🔗</a>'), s, n.parentElement === s ? n : null); } });
  }
  if (cat || n.classList.contains('modal-content')) {
    var color = cat ? (rgbToHex(getComputedStyle(cat).borderTopColor) || '#0ea5e9') : '#0ea5e9';
    items.push({ label: '🗂 קטגוריה חדשה', run: function () {
      var c = htmlNode('<div class="category-section" style="border-top: 3px solid ' + color + ';"><h3 class="category-title">קטגוריה חדשה</h3><div class="sub-links-grid"><a href="https://" target="_blank" class="sub-link-card">קישור חדש 🔗</a></div></div>');
      if (cat) insert(c, cat.parentElement, cat);
      else { var footer = $('.modal-footer-sticky', n); if (footer) insert(c, n, footer.previousElementSibling); else insert(c, n, null); }
    } });
  }
  if (!n.closest('.modal-overlay') && (ms || $('.ms-section', regionOf(n) || document))) {
    var refMs = ms || $('.ms-section', regionOf(n));
    items.push({ label: '🧩 אזור כרטיסים חדש (כותרת + כרטיסים)', run: function () {
      insert(htmlNode('<div class="ms-section"><h2 class="ms-title">כותרת האזור החדש</h2><div class="links-grid"><a href="https://" target="_blank" class="link-card ' + curCardColor(null) + '">קישור חדש 🔗</a></div></div>'), refMs.parentElement, refMs);
    } });
  }
  return items;
}
function htmlNode(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function place(node, parent, after) {
  if (after && after.parentElement === parent) after.after(node);
  else parent.appendChild(node);
}
function insert(node, parent, after) {
  mutate(function () { place(node, parent, after); });
  afterInsert(node);
}
function afterInsert(node) {
  initSortables();
  select(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(node);
  setTimeout(placeMini, 400);
}
function insertTemplate(t) {
  var node = instanceFrom(t);
  var target = sel && !regions.includes(sel) ? sel : null;
  if (target) insert(node, target.parentElement, target);
  else insert(node, sel && regions.includes(sel) ? sel : firstContentContainer(), null);
}
function firstContentContainer() {
  var r = regions[0];
  // Mozello pages often wrap everything in one styled container – add inside it
  var kids = siblingsOfRegion(r);
  return kids.length === 1 && kids[0].tagName === 'DIV' ? kids[0] : r;
}
function siblingsOfRegion(r) { return Array.prototype.filter.call(r.children, function (c) { return !/^(SCRIPT|STYLE|META|TITLE|LINK)$/.test(c.tagName) && !c.hasAttribute('data-se-ui'); }); }
function addMenu(anchor) {
  var items = [];
  var ctx = contextAdds(sel);
  if (ctx.length) { items.push({ header: 'לפי המקום שנבחר' }); items = items.concat(ctx); items.push('-'); }
  var groups = {};
  templates.forEach(function (t) { (groups[t.group || 'אחר'] = groups[t.group || 'אחר'] || []).push(t); });
  Object.keys(groups).forEach(function (g) {
    items.push({ header: 'שבלונות · ' + g });
    groups[g].forEach(function (t) { items.push({ label: t.name, color: firstColor(t.html), run: function () { insertTemplate(t); } }); });
  });
  items.push('-', { label: '🎨 ניהול שבלונות...', run: function () { openTemplates(); } });
  if (!sel) items.unshift({ header: 'טיפ: בחרי קודם רכיב בדף – החדש יתווסף אחריו' });
  popMenu(anchor, items);
}

/* =====================================================================
   Templates (שבלונות)
   ===================================================================== */
function loadTemplates() {
  return fetch(BASE + 'templates.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw r; return r.json(); })
    .catch(function () { return { templates: [
      { id: 'paragraph', name: 'פסקת טקסט', group: 'טקסט', html: '<p data-slot="text" style="font-size: 16px; line-height: 1.7;">כתבי כאן טקסט.</p>' },
      { id: 'heading', name: 'כותרת', group: 'טקסט', html: '<h2 data-slot="title" style="text-align: center;">כותרת חדשה</h2>' }] }; })
    .then(function (j) {
      tplPublished = JSON.stringify(j.templates || []);
      templates = local.get(KEYS.tplDraft, null) || JSON.parse(tplPublished);
    });
}
function tplById(id) { return templates.filter(function (t) { return t.id === id; })[0]; }
/* the most saturated colour in a template = its "main" colour */
function firstColor(html) {
  var best = '#94a3b8', bestSat = -1;
  (String(html).match(/#[0-9a-fA-F]{6}\b/g) || []).forEach(function (c) {
    var r = parseInt(c.substr(1, 2), 16), g = parseInt(c.substr(3, 2), 16), b = parseInt(c.substr(5, 2), 16);
    var sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat > bestSat) { bestSat = sat; best = c; }
  });
  return best;
}
function instanceFrom(t) { var n = htmlNode(t.html); n.setAttribute('data-tpl', t.id); return n; }
function hasSlots(t) { return /data-slot=/.test(t.html); }
/* Re-render an instance from its template, keeping what was typed into slots */
function renderInstance(inst, t) {
  var fresh = instanceFrom(t);
  var old = {};
  [inst].concat($$('[data-slot]', inst)).forEach(function (s) { if (s.hasAttribute && s.hasAttribute('data-slot')) old[s.getAttribute('data-slot')] = s; });
  [fresh].concat($$('[data-slot]', fresh)).forEach(function (s) {
    if (!s.hasAttribute('data-slot')) return;
    var o = old[s.getAttribute('data-slot')]; if (!o) return;
    ['href', 'target', 'rel', 'src', 'alt', 'for'].forEach(function (a) { if (o.hasAttribute(a)) s.setAttribute(a, o.getAttribute(a)); });
    if (!$('[data-slot]', s)) s.innerHTML = o.innerHTML;    // leaf slot: keep the content
  });
  inst.replaceWith(fresh);
  return fresh;
}
/* structural fingerprint: attribute order and whitespace don't matter */
function canon(n) {
  if (n.nodeType === 3) return norm(n.nodeValue);
  if (n.nodeType !== 1) return '';
  var attrs = Array.prototype.map.call(n.attributes, function (a) { return a.name + '=' + norm(a.value).replace(/;\s*$/, ''); }).sort().join(' ');
  return '<' + n.tagName + ' ' + attrs + '>' + Array.prototype.map.call(n.childNodes, canon).join('') + '</>';
}
function sameShape(a, b) { return canon(cleanClone(a, true)) === canon(b); }
function outdatedInstances() {
  var out = [];
  regions.forEach(function (r) {
    $$('[data-tpl]', r).forEach(function (n) {
      var t = tplById(n.getAttribute('data-tpl'));
      if (!t || !hasSlots(t)) return;
      var probe = n.cloneNode(true), holder = document.createElement('div'); holder.appendChild(probe);
      if (!sameShape(n, renderInstance(probe, t))) out.push(n);
    });
  });
  return out;
}
function checkTemplateInstances() {
  var list = outdatedInstances();
  if (!list.length) return;
  confirmBox('עדכון שבלונות', list.length + ' רכיבים בדף הזה נוצרו מגרסה קודמת של שבלונה. לעדכן אותם לעיצוב החדש? (התוכן שלהם יישמר)', 'עדכון', function () {
    mutate(function () { list.forEach(function (n) { renderInstance(n, tplById(n.getAttribute('data-tpl'))); }); });
    initSortables(); toast('עודכנו ' + list.length + ' רכיבים ✓', 'ok');
  }, { cancelLabel: 'לא עכשיו' });
}
function propagate(t) {
  if (!hasSlots(t)) return 0;
  var c = 0;
  regions.forEach(function (r) { $$('[data-tpl="' + CSS.escape(t.id) + '"]', r).forEach(function (n) { renderInstance(n, t); c++; }); });
  return c;
}

function saveAsTemplate(n) {
  var name = el('input', { class: 'se-input', value: kindOf(n) + ' – ' + (shortText(n, 20) || 'חדש') });
  var link = el('input', { type: 'checkbox', checked: true });
  modal('💾 שמירה כשבלונה', el('div', {},
    field('שם השבלונה', name),
    el('label', { class: 'se-check' }, link, 'לחבר את הרכיב הזה לשבלונה (שינוי עיצוב בשבלונה יעדכן גם אותו)'),
    el('div', { class: 'se-hint', text: 'הטקסטים ברכיב יסומנו כ"שדות" – בעדכון עיצוב השבלונה התוכן שלהם נשמר.' })), [
    { label: 'שמירה', primary: true, onClick: function () {
      var c = cleanClone(n, true);
      c.removeAttribute('data-tpl');
      $$('[data-tpl]', c).forEach(function (x) { x.removeAttribute('data-tpl'); });
      if (!c.hasAttribute('data-slot') && !$('[data-slot]', c)) autoSlots(c);
      var t = { id: uid('t'), name: name.value.trim() || 'שבלונה חדשה', group: 'השבלונות שלי', html: c.outerHTML };
      templates.push(t);
      if (link.checked) { var inst; mutate(function () { inst = renderInstance(n, t); }); select(inst); } else saveDraft();
      toast('נשמרה שבלונה: ' + t.name, 'ok');
      renderPanel();
    } },
    { label: 'ביטול' }]);
}
function autoSlots(root) {
  var k = 0;
  [root].concat($$('*', root)).forEach(function (n) {
    if (n.children.length === 0 && norm(n.textContent) && !/^(SCRIPT|STYLE)$/.test(n.tagName)) n.setAttribute('data-slot', 's' + (++k));
    else if ((n.tagName === 'A' || n.tagName === 'IMG') && !n.hasAttribute('data-slot')) n.setAttribute('data-slot', 's' + (++k));
  });
}

function openTemplates(selectId) {
  var before = snapshot(), tplBefore = JSON.stringify(templates);
  var cur = selectId || (templates[0] && templates[0].id);
  var list = el('div', { class: 'se-tlist' });
  var editor = el('div');
  var m = modal('🎨 ניהול שבלונות', el('div', { class: 'se-tpl' },
    el('div', {}, list, el('div', { class: 'se-row', style: 'margin-top:8px' },
      btn('＋ חדשה', function () { newTpl(); }, 'se-small'),
      sel && !regions.includes(sel) ? btn('＋ מהרכיב שנבחר', function () { m.close(); saveAsTemplate(sel); }, 'se-small') : null)),
    editor), [{ label: 'סיום', primary: true }], { wide: true, onClose: function () {
      var now = snapshot();
      if (JSON.stringify(now) !== JSON.stringify(before)) { pushUndo(before); }
      if (JSON.stringify(templates) !== tplBefore) { saveDraft(); toast('השבלונות נשמרו בטיוטה – יעלו לאתר בפרסום הבא'); }
      initSortables(); changed();
    } });

  function usage(id) { var c = 0; regions.forEach(function (r) { c += $$('[data-tpl="' + CSS.escape(id) + '"]', r).length; }); return c; }
  function newTpl(from) {
    var t = from ? JSON.parse(JSON.stringify(from)) : { group: 'השבלונות שלי', html: '<div style="background-color: #f0f9ff; border: 2px solid #0284c7; border-radius: 16px; padding: 16px 20px;"><div data-slot="title" style="font-weight: bold; font-size: 18px; color: #0c4a6e;">כותרת</div><div data-slot="text" style="font-size: 15px; color: #334155;">טקסט</div></div>' };
    t.id = uid('t'); t.name = from ? from.name + ' (עותק)' : 'שבלונה חדשה';
    templates.push(t); cur = t.id; draw();
  }
  function draw() {
    list.replaceChildren.apply(list, templates.map(function (t) {
      return el('button', { type: 'button', class: 'se-titem' + (t.id === cur ? ' se-cur' : ''), onclick: function () { cur = t.id; draw(); } },
        el('span', { class: 'se-sw', style: 'width:12px;height:12px;border-radius:4px;background:' + firstColor(t.html) }),
        t.name, el('small', { text: usage(t.id) ? usage(t.id) + ' בדף' : '' }));
    }));
    var t = tplById(cur);
    if (!t) { editor.replaceChildren(el('p', { text: 'אין שבלונות.' })); return; }
    var name = el('input', { class: 'se-input', value: t.name });
    var grp = el('input', { class: 'se-input', value: t.group || '' });
    var code = el('textarea', { class: 'se-input se-code', spellcheck: 'false', style: 'min-height:160px' }); code.value = t.html;
    var knobs = el('div', { class: 'se-knobs' });
    var preview = el('div', { class: 'se-preview' });
    var timer;
    function refresh(propagateNow) {
      preview.replaceChildren();
      try { preview.appendChild(htmlNode(t.html) || el('em', { text: '(ריק)' })); } catch (e) {}
      drawKnobs();
      clearTimeout(timer);
      if (propagateNow) timer = setTimeout(function () { var n = propagate(t); if (n) toast('עודכנו ' + n + ' רכיבים בדף'); }, 350);
    }
    function drawKnobs() {
      var colors = [];
      (t.html.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || []).forEach(function (c) { if (colors.indexOf(c.toLowerCase()) < 0) colors.push(c.toLowerCase()); });
      knobs.replaceChildren.apply(knobs, colors.map(function (c) {
        var full = c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c;
        var i = el('input', { type: 'color', value: full, title: c });
        var from = c;
        i.oninput = function () {
          t.html = t.html.replace(new RegExp(from.replace('#', '#'), 'gi'), i.value);
          from = i.value; code.value = t.html;
          preview.replaceChildren(htmlNode(t.html));
          clearTimeout(timer); timer = setTimeout(function () { propagate(t); }, 300);
        };
        i.onchange = function () { drawKnobs(); };
        return el('label', {}, i, c);
      }));
      if (!colors.length) knobs.appendChild(el('span', { class: 'se-hint', text: 'לא נמצאו צבעים בקוד' }));
    }
    name.oninput = function () { t.name = name.value; draw.pending || (draw.pending = setTimeout(function () { draw.pending = null; var l = $$('.se-titem', list)[templates.indexOf(t)]; if (l) l.childNodes[1].nodeValue = t.name; }, 200)); };
    grp.oninput = function () { t.group = grp.value; };
    code.oninput = function () { t.html = code.value; refresh(true); };
    editor.replaceChildren(
      el('div', { class: 'se-row' }, el('div', { class: 'se-grow' }, field('שם', name)), el('div', { class: 'se-grow' }, field('קבוצה בתפריט', grp))),
      field('צבעים בשבלונה (שינוי כאן מעדכן את כל הרכיבים בדף)', knobs),
      field('קוד HTML', code, 'רכיבים עם data-slot="..." הם שדות תוכן: כשמשנים את העיצוב, התוכן שהוקלד בהם נשמר.'),
      el('div', { class: 'se-lbl', text: 'תצוגה מקדימה:' }), preview,
      el('div', { class: 'se-row', style: 'margin-top:10px' },
        btn('＋ הוספה לדף', function () { m.close(); insertTemplate(t); }, 'se-primary'),
        btn('⧉ שכפול', function () { newTpl(t); }),
        btn('🗑 מחיקה', function () {
          if (!window.confirm('למחוק את השבלונה "' + t.name + '"? רכיבים קיימים בדף יישארו כמו שהם.')) return;
          templates = templates.filter(function (x) { return x !== t; });
          regions.forEach(function (r) { $$('[data-tpl="' + CSS.escape(t.id) + '"]', r).forEach(function (n) { n.removeAttribute('data-tpl'); }); });
          cur = templates[0] && templates[0].id; draw();
        }, 'se-danger')));
    refresh(false);
  }
  draw();
}

/* =====================================================================
   GitHub: settings, export, publish
   ===================================================================== */
function guessRepo() {
  var h = location.hostname;
  if (!/\.github\.io$/i.test(h)) return {};
  var owner = h.split('.')[0];
  var segs = new URL(ROOT).pathname.split('/').filter(Boolean);
  var repo = segs.length ? segs.shift() : owner + '.github.io';
  return { owner: owner, repo: repo, prefix: segs.join('/') };
}
function ghCfg() { return Object.assign({ branch: 'main', prefix: '' }, guessRepo(), local.get(KEYS.github, {})); }
function ghUrl(path) {
  var g = ghCfg(), full = (g.prefix ? g.prefix.replace(/\/+$/, '') + '/' : '') + path;
  return 'https://api.github.com/repos/' + encodeURIComponent(g.owner) + '/' + encodeURIComponent(g.repo) + '/contents/' + full.split('/').map(encodeURIComponent).join('/');
}
function ghHeaders() { return { Authorization: 'Bearer ' + ghCfg().token, Accept: 'application/vnd.github+json' }; }
function ghGet(path) {
  return fetch(ghUrl(path) + '?ref=' + encodeURIComponent(ghCfg().branch), { headers: ghHeaders(), cache: 'no-store' })
    .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw r; return r.json(); });
}
function ghPut(path, text, message) {
  return ghGet(path).then(function (cur) {
    return fetch(ghUrl(path), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: message, content: toB64(text), branch: ghCfg().branch, sha: cur && cur.sha || undefined }) });
  }).then(function (r) { if (!r.ok) throw r; return r.json(); });
}
/* Write-permission probe: a PUT with a deliberately wrong sha is rejected
   with 409/422 when the token may write (nothing is written), 401/403 when not. */
function ghWriteCheck(path) {
  return fetch(ghUrl(path), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: 'permission check', content: '', sha: '0000000000000000000000000000000000000000', branch: ghCfg().branch }) })
    .then(function (r) {
      if (r.status === 409 || r.status === 422) return { ok: true };
      return ghError(r).then(function (e) { return { ok: false, status: e.status, message: e.message }; });
    });
}
function ghError(r) {
  if (!r || typeof r.json !== 'function') return Promise.resolve({ status: 0, message: (r && r.message) || 'אין חיבור' });
  return r.json().then(function (j) { return { status: r.status, message: j.message || '' }; }, function () { return { status: r.status, message: '' }; });
}
function tokenHelp(status, message) {
  var g = ghCfg();
  modal('🔑 לטוקן אין הרשאת כתיבה', el('div', { style: 'line-height:1.7' },
    el('p', { style: 'margin-top:0', text: 'הטוקן מאפשר לקרוא את המאגר אבל לא לשמור בו (' + status + (message ? ': ' + message : '') + ').' }),
    el('b', { text: 'איך מתקנים (פעם אחת):' }),
    el('ol', { style: 'padding-inline-start:20px;margin:6px 0' },
      el('li', {}, 'פותחים את ', el('a', { href: 'https://github.com/settings/personal-access-tokens', target: '_blank', rel: 'noopener', text: 'רשימת הטוקנים ב-GitHub' }), ' ובוחרים את הטוקן (או "Generate new token").'),
      el('li', { html: 'ב-<b>Repository access</b> בוחרים <b>Only select repositories</b> ← <b dir="ltr">' + (g.repo || 'math-site') + '</b>.<br><span style="color:#b91c1c">לא</span> "Public repositories (read-only)" – זה קריאה בלבד.' }),
      el('li', { html: 'ב-<b>Permissions ← Repository permissions</b> מוסיפים <b>Contents</b> ומשנים ל-<b>Read and write</b> (ברירת המחדל היא Read-only).' }),
      el('li', { html: 'שומרים (<b>Update</b> / <b>Generate token</b>). טוקן חדש – מעתיקים ומדביקים ב-⚙️ במקום הישן.' }),
      el('li', { text: 'לוחצים "בדיקת חיבור" – צריך להופיע "הכול תקין ✓ קריאה וכתיבה".' })),
    el('div', { class: 'se-hint', text: 'הטיוטה שלך שמורה בדפדפן – שום שינוי לא אבד.' })),
    [{ label: 'פתיחת הגדרות ⚙️', primary: true, onClick: function () { setTimeout(openSettings, 0); } }, { label: 'סגירה' }]);
}
function toB64(str) {
  var bytes = new TextEncoder().encode(str), bin = '';
  for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromB64(b) { var bin = atob(b.replace(/\s/g, '')); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); }

function openSettings() {
  var g = ghCfg();
  function f(name, label, val, hint, type) { return field(label, el('input', { class: 'se-input', name: name, type: type || 'text', value: val || '', dir: 'ltr', autocomplete: 'off' }), hint); }
  var form = el('div', {},
    el('div', { class: 'se-hint', html: 'כפתור 🚀 שומר את הדף ישירות במאגר ב-GitHub. צריך <b>Fine-grained token</b> עם הרשאת <b>Contents: Read and write</b> למאגר של האתר בלבד (GitHub ← Settings ← Developer settings ← Personal access tokens). הטוקן נשמר רק בדפדפן הזה.' }),
    el('div', { class: 'se-row', style: 'margin-top:10px' }, el('div', { class: 'se-grow' }, f('owner', 'משתמש GitHub', g.owner)), el('div', { class: 'se-grow' }, f('repo', 'שם המאגר', g.repo))),
    el('div', { class: 'se-row' }, el('div', { class: 'se-grow' }, f('branch', 'ענף', g.branch)), el('div', { class: 'se-grow' }, f('prefix', 'תיקייה במאגר (בד״כ ריק)', g.prefix))),
    f('token', 'טוקן', g.token, 'בלי טוקן: "⬇ HTML" מוריד את הקובץ, ומעלים אותו ידנית ל-GitHub.', 'password'),
    el('div', { class: 'se-hint', text: 'הדף הנוכחי נשמר בנתיב: ' + PAGE }));
  modal('⚙️ הגדרות פרסום', form, [
    { label: 'שמירה', primary: true, onClick: function () {
      var cfg = {}; $$('input[name]', form).forEach(function (i) { cfg[i.name] = i.value.trim(); });
      local.set(KEYS.github, cfg); toast('נשמר', 'ok');
    } },
    { label: 'בדיקת חיבור', onClick: function () {
      var cfg = {}; $$('input[name]', form).forEach(function (i) { cfg[i.name] = i.value.trim(); });
      local.set(KEYS.github, cfg);
      toast('בודקת...');
      ghGet(PAGE).then(function (r) {
        if (!r) { toast('החיבור תקין, אבל הקובץ ' + PAGE + ' לא נמצא במאגר – בדקי שם מאגר / תיקייה', 'err'); return; }
        return ghWriteCheck(PAGE).then(function (w) {
          if (w.ok) toast('הכול תקין ✓ קריאה וכתיבה למאגר – אפשר לפרסם', 'ok');
          else tokenHelp(w.status, w.message);
        });
      }).catch(function (r) { ghError(r).then(function (e) { if (e.status === 401 || e.status === 403) tokenHelp(e.status, e.message); else toast('החיבור נכשל (' + (e.status || 'רשת') + ') ' + e.message, 'err'); }); });
      return false;
    } },
    { label: 'ניתוק', danger: true, onClick: function () { local.del(KEYS.github); toast('פרטי GitHub נמחקו מהדפדפן'); } }
  ]);
}

function buildPageHtml() {
  endText();
  var d = src.cloneNode(true), rs = liveRegionsOf(d);
  regions.forEach(function (r, i) { var h = saveHtml(r); if (h !== initial[i]) rs[i].innerHTML = h; });
  var dt = d.doctype ? '<!DOCTYPE ' + d.doctype.name + '>' : '<!doctype html>';
  return dt + '\n' + d.documentElement.outerHTML + '\n';
}
function download(name, text, type) {
  var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
}
function exportHtml() {
  download(PAGE.split('/').pop(), buildPageHtml(), 'text/html;charset=utf-8');
  if (tplDirty()) download('templates.json', JSON.stringify({ version: 1, templates: templates }, null, 1), 'application/json');
  toast('הקובץ ירד. העלי אותו ל-GitHub בנתיב: ' + PAGE + (tplDirty() ? ' (וגם templates.json לתיקיית assets)' : ''), 'ok');
}
function publish() {
  var g = ghCfg();
  if (!g.token || !g.owner || !g.repo) { toast('כדי לפרסם ישירות צריך למלא פרטי GitHub (⚙️)', 'err'); openSettings(); return; }
  var pageDirty = dirtyIdx().length > 0, tDirty = tplDirty();
  if (!pageDirty && !tDirty) { toast('אין שינויים לפרסם – הדף זהה לאתר'); return; }
  confirmBox('🚀 פרסום', 'לפרסם ' + [pageDirty ? 'את הדף "' + PAGE_NAME + '"' : '', tDirty ? 'את השבלונות' : ''].filter(Boolean).join(' ו') + ' ל-' + g.owner + '/' + g.repo + '? הגולשים יראו את השינוי תוך דקה-שתיים.', 'פרסום', go);
  function go() {
    var b = $('#sePublish'); b.disabled = true; b.textContent = '⏳ מפרסם...';
    var html = pageDirty ? buildPageHtml() : null;
    var stamp = new Date().toLocaleString('he-IL');
    var chain = Promise.resolve();
    if (tDirty) chain = chain.then(function () { return ghPut('assets/templates.json', JSON.stringify({ version: 1, templates: templates }, null, 1) + '\n', 'עדכון שבלונות (' + stamp + ')'); })
      .then(function () { tplPublished = JSON.stringify(templates); local.del(KEYS.tplDraft); });
    if (pageDirty) chain = chain.then(function () { return ghPut(PAGE, html, 'עדכון הדף ' + PAGE_NAME + ' (' + stamp + ')'); })
      .then(function () { src = parse(html); initial = regions.map(saveHtml); local.del(KEYS.draft(PAGE)); });
    chain.then(function () { updateStatus(); toast('פורסם בהצלחה! 🎉 האתר יתעדכן תוך דקה-שתיים', 'ok'); })
      .catch(function (r) {
        return ghError(r).then(function (e) {
          var c = e.status, msg = 'הפרסום נכשל';
          if (c === 401 || c === 403) { tokenHelp(c, e.message); return; }
          if (c === 404) msg = 'המאגר / הענף לא נמצאו – בדקי ב-⚙️';
          else if (c === 409 || c === 422) msg = 'התנגשות גרסאות – נסי שוב';
          else if (!c) msg = 'אין חיבור ל-GitHub';
          toast(msg + (c ? ' (' + c + ': ' + e.message + ')' : '') + '. הטיוטה שמורה; אפשר גם "⬇ HTML".', 'err');
        });
      })
      .then(function () { b.disabled = false; b.textContent = '🚀 פרסום'; });
  }
}

/* =====================================================================
   Notes / requests for Claude (shared store with feedback.html)
   ===================================================================== */
function reqs() { return local.get(KEYS.requests, []); }
function saveReqs(l) { local.set(KEYS.requests, l); }
function setNoting(on) {
  noting = on;
  document.body.classList.toggle('se-noting', on);
  var b = $('#seNotes'); if (b) b.classList.toggle('se-on', on);
  if (on) { endText(); select(null); if (!ui.notes) buildNotes(); toast('לחצי על כל חלק בדף כדי לכתוב עליו הערה'); }
  else if (ui.notes) { ui.notes.remove(); ui.notes = null; }
  renderPins();
}
document.addEventListener('click', function (e) {
  if (!noting || isUi(e.target)) return;
  var t = e.target.nodeType === 1 ? e.target : e.target.parentElement;
  e.preventDefault(); e.stopPropagation();
  noteDialog(regionOf(t) ? pickTarget(t) : t);
}, true);
function cssPath(n) {
  var parts = [];
  while (n && n.nodeType === 1 && n !== document.body) {
    var p = n.parentElement; if (!p) break;
    var idx = Array.prototype.indexOf.call(p.children, n) + 1;
    parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + idx + ')');
    n = p;
  }
  return 'body>' + parts.join('>');
}
function noteDialog(target, existing) {
  var label = existing ? existing.target : kindOf(target) + (shortText(target) ? ': ' + shortText(target, 50) : '');
  var ta = el('textarea', { class: 'se-input se-textarea', placeholder: 'מה לשנות? למשל: "להוסיף כאן כרטיס לבגרות חורף" או "לשנות לצבע ירוק"' });
  ta.value = existing ? existing.text : '';
  function sel_(opts, cur) { return el('select', { class: 'se-select' }, opts.map(function (o) { var x = el('option', { value: o, text: o }); if (o === cur) x.selected = true; return x; })); }
  var cat = sel_(['עיצוב', 'תוכן', 'פיצ׳ר חדש', 'באג', 'שבלונה'], existing && existing.category);
  var pr = sel_(['רגיל', 'חשוב', 'דחוף'], existing && existing.priority);
  modal('💬 הערה על: ' + label, el('div', {}, field('ההערה / הבקשה', ta),
    el('div', { class: 'se-row' }, el('div', { class: 'se-grow' }, field('סוג', cat)), el('div', { class: 'se-grow' }, field('דחיפות', pr)))), [
    { label: 'שמירה', primary: true, onClick: function () {
      if (!ta.value.trim()) return false;
      var l = reqs();
      if (existing) l.forEach(function (r) { if (r.id === existing.id) { r.text = ta.value.trim(); r.category = cat.value; r.priority = pr.value; } });
      else l.push({ id: uid('n'), source: 'page', page: PAGE, pageName: PAGE_NAME, path: cssPath(target), target: label,
        snippet: cleanClone(target, true).outerHTML.replace(/\s+/g, ' ').slice(0, 600),
        text: ta.value.trim(), category: cat.value, priority: pr.value, done: false, created: Date.now() });
      saveReqs(l); renderPins(); drawNotes();
    } },
    existing ? { label: 'מחיקה', danger: true, onClick: function () { saveReqs(reqs().filter(function (r) { return r.id !== existing.id; })); renderPins(); drawNotes(); } } : null,
    { label: 'ביטול' }]);
}
function pageNotes() { return reqs().filter(function (r) { return r.source === 'page' && r.page === PAGE && !r.done && r.path; }); }
function renderPins() {
  $$('.se-pin').forEach(function (p) { p.remove(); });
  if (!session.get(KEYS.session)) return;
  pageNotes().forEach(function (n, i) {
    var t; try { t = document.querySelector(n.path); } catch (e) {}
    if (!t) return;
    var r = t.getBoundingClientRect();
    if (!r.width && !r.height) return;
    var pin = ui_(el('span', { class: 'se-pin', title: n.text, text: String(i + 1), onclick: function (e) { e.stopPropagation(); noteDialog(t, n); } }));
    pin.style.top = (r.top + scrollY - 10) + 'px';
    pin.style.left = (r.right + scrollX - 14) + 'px';
    document.body.appendChild(pin);
  });
}
function buildNotes() {
  var general = el('textarea', { class: 'se-input', placeholder: 'בקשה כללית לדף הזה או לכל האתר...', style: 'min-height:56px' });
  ui.notes = ui_(el('aside', { class: 'se-notes', 'aria-label': 'הערות ל-Claude' },
    el('header', {}, el('h3', { text: '💬 הערות ל-Claude' }), el('button', { type: 'button', class: 'se-x', text: '×', 'aria-label': 'סגירה', onclick: function () { setNoting(false); } })),
    el('div', { class: 'se-list', id: 'seNoteList' }),
    el('footer', {},
      el('div', { class: 'se-warn', text: 'לחצי על כל חלק בדף – כרטיס, כותרת, תפריט – וכתבי מה לשנות. בסוף: "העתקה" והדבקה בצ׳אט.' }),
      general,
      btn('＋ בקשה כללית', function () {
        if (!general.value.trim()) return;
        var l = reqs(); l.push({ id: uid('n'), source: 'page', page: PAGE, pageName: PAGE_NAME, target: 'כללי', text: general.value.trim(), category: 'פיצ׳ר חדש', priority: 'רגיל', done: false, created: Date.now() });
        saveReqs(l); general.value = ''; drawNotes();
      }),
      btn('📋 העתקת הודעה ל-Claude', function () { copyText(claudeMessage()); }, 'se-primary'),
      el('a', { href: ROOT + 'feedback.html', target: '_blank', class: 'se-btn', style: 'text-align:center;text-decoration:none' }, '🗂 לוח הבקשות המלא (כל הדפים)'))));
  document.body.appendChild(ui.notes);
  drawNotes();
}
function drawNotes() {
  var box = $('#seNoteList'); if (!box) return;
  var l = reqs().filter(function (r) { return !r.done; });
  if (!l.length) { box.replaceChildren(el('p', { class: 'se-hint', text: 'אין עדיין הערות. לחצי על חלק בדף כדי להתחיל.' })); return; }
  var pinIdx = 0, here = pageNotes().map(function (n) { return n.id; });
  box.replaceChildren.apply(box, l.map(function (r) {
    var num = here.indexOf(r.id) >= 0 ? ++pinIdx : null;
    return el('div', { class: 'se-note' },
      el('div', { class: 'se-meta' }, el('b', { text: (num ? '#' + num + ' · ' : '') + (r.page !== PAGE ? '[' + (r.pageName || r.page) + '] ' : '') + r.target }), el('span', { text: r.category + ' · ' + r.priority })),
      el('div', { class: 'se-txt', text: r.text }),
      el('div', { class: 'se-row', style: 'margin-top:6px' },
        btn('✓ טופל', function () { saveReqs(reqs().map(function (x) { if (x.id === r.id) x.done = true; return x; })); renderPins(); drawNotes(); }, 'se-small'),
        btn('🗑', function () { saveReqs(reqs().filter(function (x) { return x.id !== r.id; })); renderPins(); drawNotes(); }, 'se-small')));
  }));
}
function claudeMessage() {
  var l = reqs().filter(function (r) { return !r.done; });
  var byPage = {};
  l.forEach(function (r) { var k = r.page || 'כללי'; (byPage[k] = byPage[k] || []).push(r); });
  var out = ['שלום Claude, אלו בקשות שינוי לאתר (תיקיית השורש: saritsamuel2016.mozello.co.il):', ''];
  var i = 0;
  Object.keys(byPage).forEach(function (p) {
    out.push('## ' + (byPage[p][0].pageName || p) + ' (' + p + ')');
    byPage[p].forEach(function (r) {
      out.push((++i) + '. [' + r.category + ' · ' + r.priority + '] על: ' + r.target);
      out.push('   ' + r.text.replace(/\n/g, '\n   '));
      if (r.snippet) out.push('   קטע הקוד:', '   ```html', '   ' + r.snippet, '   ```');
    });
    out.push('');
  });
  if (!l.length) out.push('(אין בקשות פתוחות)');
  var drafts = Object.keys(localStorage).filter(function (k) { return k.indexOf('sarit.site.draft:') === 0; }).map(function (k) { return k.slice(17); });
  if (drafts.length) out.push('הערה: יש טיוטות שלא פורסמו בדפים: ' + drafts.join(', ') + ' – כדאי לפרסם לפני שמבצעים את השינויים בקוד.');
  out.push('', 'בבקשה תעדכן את הקבצים ותחזיר לי את ה-HTML המלא של הדפים שהשתנו.');
  return out.join('\n');
}
function copyText(t) {
  var ok = function () { toast('ההודעה הועתקה – הדביקי אותה בצ׳אט עם Claude ✨', 'ok'); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(ok, fallback); else fallback();
  function fallback() {
    var ta = el('textarea', { class: 'se-input se-code', style: 'min-height:300px;direction:rtl;text-align:right;white-space:pre-wrap' }); ta.value = t;
    modal('העתיקי את הטקסט', ta, [{ label: 'סגירה' }]);
    setTimeout(function () { ta.select(); }, 50);
  }
}
window.addEventListener('storage', function (e) { if (e.key === KEYS.requests) { renderPins(); drawNotes(); } });
})();
