/**
 * 注入到原型 iframe 内部的桥接脚本（自执行 IIFE 字符串）。
 * 职责：
 * 1. comment 模式：hover 高亮 + 点击拦截，向宿主上报元素上下文（AI 定向反馈）
 * 2. edit 模式：选中框 + 尺寸、Alt 悬停测量间距、双击就地改字、应用宿主下发的修改
 * 3. ctrl/cmd + 滚轮缩放与快捷键转发给宿主（iframe 会吞掉这些事件）
 * 通信协议：所有消息带 channel: 'design-canvas'。
 * 4. 实时页面：捕获为静态 HTML（dc:snapshot）、SPA 路由变化上报（dc:location）
 * 宿主 → bridge：dc:set-enabled {value, mode}、dc:apply-all {edits}、dc:clear-selection、dc:snapshot {id}
 * bridge → 宿主：dc:ready、dc:hover、dc:select、dc:inspect {meta, refresh}、dc:text {dcId, text}、dc:wheel、dc:key、
 *               dc:snapshot-result {id, html, title, error}、dc:location {path}
 * 注意：本文件是 String.raw 模板，脚本内不能出现反引号与美元符加花括号的组合。
 */
export const BRIDGE_SCRIPT = String.raw`
(function () {
  if (window.__dcBridge) return;
  window.__dcBridge = true;

  var CHANNEL = 'design-canvas';
  var ACCENT = '#b05cf2';
  var RED = '#f24822';
  var MONO = 'ui-monospace,Menlo,Consolas,monospace';
  var INSPECT_PROPS = [
    'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-radius', 'width', 'height',
    'opacity', 'display', 'gap'
  ];

  var enabled = false;
  var mode = 'comment';
  var hoverEl = null;
  var pointerEl = null;
  var selEl = null;
  var editingEl = null;
  var editingOrig = '';
  // dcId → 首次修改前的原值 { style, text }，用于幂等重放与放弃修改
  var touched = {};

  function send(msg) {
    msg.channel = CHANNEL;
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }

  // —— 覆盖层：放进 Shadow DOM，页面自身的 CSS（如 * { transition }）影响不到 ——
  var host = null;
  var root = null;
  var hoverBox, hoverLabel, selBox, selLabel, measure;

  function mk(parentNode, css) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;display:none;' + css;
    parentNode.appendChild(d);
    return d;
  }

  function ensureLayer() {
    if (host && host.isConnected) return;
    host = document.createElement('dc-overlay');
    host.setAttribute('data-dc-overlay', '1');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    hoverBox = mk(root, 'border:1.5px solid ' + ACCENT + ';background:rgba(176,92,242,0.08);border-radius:2px;');
    hoverLabel = mk(root, 'background:' + ACCENT + ';color:#fff;font:500 10px/18px ' + MONO + ';padding:0 6px;border-radius:3px;white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis;');
    selBox = mk(root, 'border:2px solid ' + ACCENT + ';');
    selLabel = mk(root, 'background:' + ACCENT + ';color:#fff;font:600 10px/18px ' + MONO + ';padding:0 6px;border-radius:3px;white-space:nowrap;transform:translateX(-50%);');
    measure = document.createElement('div');
    root.appendChild(measure);
    (document.body || document.documentElement).appendChild(host);
  }

  function place(el, r) {
    el.style.display = 'block';
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
  }

  function hide(el) {
    if (el) el.style.display = 'none';
  }

  function nameOf(el) {
    var cls = Array.prototype.slice.call(el.classList || []);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
  }

  function sizeOf(r) {
    return Math.round(r.width) + ' × ' + Math.round(r.height);
  }

  function showHover(el) {
    ensureLayer();
    hoverEl = el;
    var r = el.getBoundingClientRect();
    place(hoverBox, r);
    hoverLabel.textContent = nameOf(el) + (mode === 'edit' ? '  ' + sizeOf(r) : '');
    hoverLabel.style.display = 'block';
    hoverLabel.style.left = Math.max(0, r.left) + 'px';
    hoverLabel.style.top = (r.top >= 20 ? r.top - 20 : Math.max(r.top, 0) + 2) + 'px';
  }

  function hideHover() {
    hoverEl = null;
    hide(hoverBox);
    hide(hoverLabel);
  }

  function drawSelection() {
    if (!selEl || !selEl.isConnected) {
      hide(selBox);
      hide(selLabel);
      return;
    }
    ensureLayer();
    var r = selEl.getBoundingClientRect();
    place(selBox, r);
    selLabel.textContent = sizeOf(r);
    selLabel.style.display = 'block';
    selLabel.style.left = r.left + r.width / 2 + 'px';
    selLabel.style.top = Math.min(r.bottom + 4, window.innerHeight - 22) + 'px';
  }

  function clearSelection() {
    selEl = null;
    drawSelection();
    clearMeasure();
  }

  // —— 测量：选中元素与 Alt 悬停元素之间的间距（包含关系量内边距，分离关系量间隙）——
  function clearMeasure() {
    if (measure) measure.innerHTML = '';
  }

  function measureLine(x1, y1, x2, y2, value) {
    if (value < 0.5) return;
    var horiz = y1 === y2;
    var l = document.createElement('div');
    l.style.cssText = 'position:fixed;background:' + RED + ';' + (horiz
      ? 'height:1px;left:' + Math.min(x1, x2) + 'px;top:' + y1 + 'px;width:' + Math.abs(x2 - x1) + 'px;'
      : 'width:1px;left:' + x1 + 'px;top:' + Math.min(y1, y2) + 'px;height:' + Math.abs(y2 - y1) + 'px;');
    measure.appendChild(l);
    var t = document.createElement('div');
    t.textContent = String(Math.round(value));
    t.style.cssText = 'position:fixed;background:' + RED + ';color:#fff;font:600 10px/16px ' + MONO +
      ';padding:0 4px;border-radius:3px;transform:translate(-50%,-50%);left:' + (x1 + x2) / 2 +
      'px;top:' + (y1 + y2) / 2 + 'px;';
    measure.appendChild(t);
  }

  function contains(o, i) {
    return i.left >= o.left && i.right <= o.right && i.top >= o.top && i.bottom <= o.bottom;
  }

  function drawMeasure(a, b) {
    ensureLayer();
    clearMeasure();
    var A = a.getBoundingClientRect();
    var B = b.getBoundingClientRect();
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:1px solid ' + RED + ';left:' + B.left + 'px;top:' + B.top +
      'px;width:' + B.width + 'px;height:' + B.height + 'px;';
    measure.appendChild(box);
    if (contains(B, A) || contains(A, B)) {
      var o = contains(B, A) ? B : A;
      var i = o === B ? A : B;
      var cx = i.left + i.width / 2;
      var cy = i.top + i.height / 2;
      measureLine(cx, o.top, cx, i.top, i.top - o.top);
      measureLine(cx, i.bottom, cx, o.bottom, o.bottom - i.bottom);
      measureLine(o.left, cy, i.left, cy, i.left - o.left);
      measureLine(i.right, cy, o.right, cy, o.right - i.right);
      return;
    }
    var oy1 = Math.max(A.top, B.top);
    var oy2 = Math.min(A.bottom, B.bottom);
    var y = oy2 > oy1 ? (oy1 + oy2) / 2 : A.top + A.height / 2;
    if (B.left >= A.right) measureLine(A.right, y, B.left, y, B.left - A.right);
    else if (A.left >= B.right) measureLine(B.right, y, A.left, y, A.left - B.right);
    var ox1 = Math.max(A.left, B.left);
    var ox2 = Math.min(A.right, B.right);
    var x = ox2 > ox1 ? (ox1 + ox2) / 2 : A.left + A.width / 2;
    if (B.top >= A.bottom) measureLine(x, A.bottom, x, B.top, B.top - A.bottom);
    else if (A.top >= B.bottom) measureLine(x, B.bottom, x, A.top, A.top - B.bottom);
  }

  // —— 元素描述 ——
  function buildSelector(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      var parentEl = node.parentElement;
      if (parentEl) {
        var tag = node.tagName;
        var siblings = Array.prototype.filter.call(parentEl.children, function (c) { return c.tagName === tag; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parentEl;
      depth++;
    }
    return parts.join(' > ');
  }

  function metaFor(el) {
    var rect = el.getBoundingClientRect();
    var text = el.children.length === 0 ? (el.textContent || '').trim().slice(0, 80) : '';
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList || []),
      text: text,
      outerHTML: el.outerHTML.length > 500 ? el.outerHTML.slice(0, 500) + '…' : el.outerHTML,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }

  function isTextLeaf(el) {
    if (el.children.length || el.tagName === 'TEXTAREA') return false;
    return (el.textContent || '').trim().length > 0;
  }

  function inspectMeta(el) {
    var cs = getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < INSPECT_PROPS.length; i++) styles[INSPECT_PROPS[i]] = cs.getPropertyValue(INSPECT_PROPS[i]);
    var r = el.getBoundingClientRect();
    return {
      dcId: el.getAttribute('data-dc-id'),
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList || []),
      text: isTextLeaf(el) ? el.textContent : null,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      styles: styles,
    };
  }

  function selectForEdit(el) {
    selEl = el;
    clearMeasure();
    drawSelection();
    send({ type: 'dc:inspect', meta: inspectMeta(el), refresh: false });
  }

  // —— 修改的幂等重放：先还原所有改过的元素，再按宿主下发的全量修改重新应用 ——
  function byId(id) {
    return document.querySelector('[data-dc-id="' + id + '"]');
  }

  function remember(el) {
    var id = el.getAttribute('data-dc-id');
    if (!id || touched[id]) return;
    touched[id] = { style: el.getAttribute('style'), text: isTextLeaf(el) ? el.textContent : null };
  }

  function applyAll(edits) {
    var id, el;
    for (id in touched) {
      el = byId(id);
      if (el) {
        if (touched[id].style === null) el.removeAttribute('style');
        else el.setAttribute('style', touched[id].style);
        if (touched[id].text !== null && el !== editingEl) el.textContent = touched[id].text;
      }
      if (!edits[id]) delete touched[id];
    }
    for (id in edits) {
      el = byId(id);
      if (!el) continue;
      remember(el);
      var e = edits[id];
      for (var p in e.styles) {
        if (e.styles[p]) el.style.setProperty(p, e.styles[p]);
        else el.style.removeProperty(p);
      }
      if (e.text !== undefined && e.text !== null && el !== editingEl) el.textContent = e.text;
    }
    drawSelection();
    if (selEl && selEl.isConnected) send({ type: 'dc:inspect', meta: inspectMeta(selEl), refresh: true });
  }

  // —— 双击就地改字（仅纯文本叶子、且属于源 HTML 的元素）——
  function startTextEdit(el) {
    remember(el);
    editingEl = el;
    editingOrig = el.textContent;
    hideHover();
    clearMeasure();
    el.setAttribute('contenteditable', 'plaintext-only');
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    el.addEventListener('blur', finishTextEdit);
    el.addEventListener('keydown', onEditKey);
  }

  function onEditKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      editingEl.textContent = editingOrig;
      editingEl.blur();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      editingEl.blur();
    }
  }

  function finishTextEdit() {
    var el = editingEl;
    if (!el) return;
    editingEl = null;
    el.removeEventListener('blur', finishTextEdit);
    el.removeEventListener('keydown', onEditKey);
    el.removeAttribute('contenteditable');
    if (el.textContent !== editingOrig) {
      send({ type: 'dc:text', dcId: el.getAttribute('data-dc-id'), text: el.textContent });
    }
    drawSelection();
  }

  // —— 捕获：把当前页面序列化为自包含的静态 HTML ——
  // 脚本移除；可读样式表按层叠顺序内联为 <style>（含 CSSOM 动态插入的规则），跨源不可读的保留 <link>；
  // 资源地址绝对化；表单值与 canvas 画面固化。地址基于当前（代理）源，宿主再替换成真实源。
  function absUrl(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function absCss(text, base) {
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      if (/^(data:|blob:|#|about:)/i.test(u)) return m;
      return 'url("' + absUrl(u, base) + '")';
    });
  }

  // 冻结配色方案：设计稿渲染环境的明暗偏好可能与实时页面不同，按捕获时的结果固化，所见即所得
  var prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function freezeScheme(text) {
    return text.replace(/prefers-color-scheme\s*:\s*(dark|light)/g, function (m, v) {
      return (v === 'dark') === prefersDark ? 'min-width: 0px' : 'max-width: 0px';
    });
  }

  function sheetItems() {
    var sheets = Array.prototype.slice.call(document.styleSheets);
    if (document.adoptedStyleSheets) sheets = sheets.concat(Array.prototype.slice.call(document.adoptedStyleSheets));
    var items = [];
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      if (s.disabled) continue;
      try {
        var parts = [];
        for (var j = 0; j < s.cssRules.length; j++) parts.push(s.cssRules[j].cssText);
        var text = freezeScheme(absCss(parts.join('\n'), s.href || location.href));
        var media = s.media && freezeScheme(s.media.mediaText);
        items.push({ css: media && media !== 'all' ? '@media ' + media + '{' + text + '}' : text });
      } catch (e) {
        if (s.href) items.push({ href: s.href });
      }
    }
    return items;
  }

  function freezeFields(root) {
    var live = document.querySelectorAll('input, textarea, select');
    var copy = root.querySelectorAll('input, textarea, select');
    for (var i = 0; i < live.length && i < copy.length; i++) {
      var l = live[i];
      var c = copy[i];
      if (l.tagName === 'TEXTAREA') {
        c.textContent = l.value;
      } else if (l.tagName === 'SELECT') {
        for (var o = 0; o < c.options.length; o++) {
          if (l.options[o] && l.options[o].selected) c.options[o].setAttribute('selected', '');
          else c.options[o].removeAttribute('selected');
        }
      } else if (l.type === 'checkbox' || l.type === 'radio') {
        if (l.checked) c.setAttribute('checked', '');
        else c.removeAttribute('checked');
      } else if (l.type !== 'file' && l.type !== 'password') {
        c.setAttribute('value', l.value);
      }
    }
    var liveCanvas = document.querySelectorAll('canvas');
    var copyCanvas = root.querySelectorAll('canvas');
    for (var k = 0; k < liveCanvas.length && k < copyCanvas.length; k++) {
      try {
        var img = document.createElement('img');
        img.setAttribute('src', liveCanvas[k].toDataURL());
        var r = liveCanvas[k].getBoundingClientRect();
        img.setAttribute('style', (copyCanvas[k].getAttribute('style') || '') + ';width:' + r.width + 'px;height:' + r.height + 'px;');
        if (copyCanvas[k].className) img.setAttribute('class', copyCanvas[k].getAttribute('class'));
        copyCanvas[k].parentNode.replaceChild(img, copyCanvas[k]);
      } catch (e) {}
    }
  }

  function absolutizeAttrs(root) {
    var els = root.querySelectorAll('[src], [href], [poster], [srcset], [style]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var names = ['src', 'href', 'poster'];
      for (var n = 0; n < names.length; n++) {
        var v = el.getAttribute(names[n]);
        if (v && !/^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(v)) el.setAttribute(names[n], absUrl(v, location.href));
      }
      var srcset = el.getAttribute('srcset');
      if (srcset) {
        el.setAttribute('srcset', srcset.split(',').map(function (part) {
          var p = part.trim().split(/\s+/);
          p[0] = absUrl(p[0], location.href);
          return p.join(' ');
        }).join(', '));
      }
      var st = el.getAttribute('style');
      if (st && st.indexOf('url(') >= 0) el.setAttribute('style', absCss(st, location.href));
    }
  }

  function snapshot() {
    var root = document.documentElement.cloneNode(true);
    freezeFields(root);
    absolutizeAttrs(root);
    var drop = root.querySelectorAll(
      'script, noscript, template, base, dc-overlay, [data-dc-overlay], style, link[rel~="stylesheet"], ' +
      'link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]'
    );
    for (var i = 0; i < drop.length; i++) {
      if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    }
    var editing = root.querySelectorAll('[contenteditable]');
    for (var e = 0; e < editing.length; e++) editing[e].removeAttribute('contenteditable');
    root.style.removeProperty('cursor');
    if (!root.getAttribute('style')) root.removeAttribute('style');
    var head = root.querySelector('head');
    if (!head) {
      head = document.createElement('head');
      root.insertBefore(head, root.firstChild);
    }
    if (!head.querySelector('meta[charset]')) {
      var meta = document.createElement('meta');
      meta.setAttribute('charset', 'utf-8');
      head.insertBefore(meta, head.firstChild);
    }
    var withMedia = root.querySelectorAll('[media]');
    for (var q = 0; q < withMedia.length; q++) withMedia[q].setAttribute('media', freezeScheme(withMedia[q].getAttribute('media')));
    // 页面同时支持明暗时（color-scheme: light dark），light-dark() 跟随偏好解析：固化为捕获时的方案
    var declared = getComputedStyle(document.documentElement).colorScheme || '';
    var scheme = /dark/.test(declared) && prefersDark ? 'dark' : /light/.test(declared) ? 'light' : '';
    var items = sheetItems();
    // 根文字色同时固化（零优先级，页面或后续 AI 对 html 的规则仍会覆盖）：系统色 CanvasText 在缩略图等渲染环境里不跟随配色方案
    if (scheme) {
      var rootColor = getComputedStyle(document.documentElement).color;
      items.push({ css: ':root { color-scheme: ' + scheme + ' !important; }\n:where(:root) { color: ' + rootColor + '; }' });
    }
    for (var m = 0; m < items.length; m++) {
      var node;
      if (items[m].css !== undefined) {
        node = document.createElement('style');
        node.textContent = items[m].css;
      } else {
        node = document.createElement('link');
        node.setAttribute('rel', 'stylesheet');
        node.setAttribute('href', items[m].href);
      }
      head.appendChild(node);
    }
    return '<!DOCTYPE html>\n' + root.outerHTML;
  }

  // —— 路由上报：实时页面（SPA）内导航时同步宿主的地址栏 ——
  function reportLocation() {
    send({ type: 'dc:location', path: location.pathname + location.search + location.hash });
  }
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    if (typeof orig !== 'function') return;
    history[k] = function () {
      var r = orig.apply(this, arguments);
      reportLocation();
      return r;
    };
  });
  window.addEventListener('popstate', reportLocation);
  window.addEventListener('hashchange', reportLocation);

  // —— 事件 ——
  function pickable(t) {
    if (!(t instanceof Element) || t.closest('[data-dc-overlay]')) return false;
    if (t === document.documentElement) return false;
    // comment 模式不选 body；edit 模式允许选 body（改页面背景）
    return mode === 'edit' || t !== document.body;
  }

  document.addEventListener('mousemove', function (e) {
    if (!enabled || editingEl) return;
    var t = e.target;
    pointerEl = t instanceof Element ? t : null;
    if (!pickable(t)) {
      hideHover();
      clearMeasure();
      if (mode === 'comment') send({ type: 'dc:hover', meta: null });
      return;
    }
    if (mode === 'edit' && selEl && e.altKey && t !== selEl) {
      hideHover();
      drawMeasure(selEl, t);
      return;
    }
    clearMeasure();
    if (t !== hoverEl) showHover(t);
  }, true);

  // 捕获阶段会收到每个元素的 mouseleave，只处理指针离开整个文档（relatedTarget 为空）
  document.addEventListener('mouseleave', function (e) {
    if (!enabled || e.relatedTarget) return;
    pointerEl = null;
    hideHover();
    clearMeasure();
    if (mode === 'comment') send({ type: 'dc:hover', meta: null });
  }, true);

  document.addEventListener('click', function (e) {
    if (!enabled) return;
    if (editingEl && editingEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    var t = e.target;
    if (!pickable(t)) return;
    if (mode === 'edit') selectForEdit(t);
    else send({ type: 'dc:select', meta: metaFor(t) });
  }, true);

  document.addEventListener('dblclick', function (e) {
    if (!enabled || mode !== 'edit') return;
    var t = e.target;
    if (!(t instanceof Element) || !t.getAttribute('data-dc-id') || !isTextLeaf(t)) return;
    e.preventDefault();
    e.stopPropagation();
    startTextEdit(t);
  }, true);

  window.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    send({
      type: 'dc:wheel',
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      localX: e.clientX,
      localY: e.clientY,
    });
  }, { passive: false, capture: true });

  // 键盘转发：让宿主支持全局快捷键（画板获得焦点时宿主收不到 keydown）。
  // 焦点在可编辑元素内时不转发，避免干扰原型自身的输入。
  function inEditable(t) {
    if (!(t instanceof Element)) return false;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
    return t.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (inEditable(e.target)) return;
    if (e.key === 'Alt' && enabled && mode === 'edit' && selEl && pointerEl && pointerEl !== selEl && pickable(pointerEl)) {
      e.preventDefault();
      hideHover();
      drawMeasure(selEl, pointerEl);
      return;
    }
    var key = e.key;
    // 编辑模式下选中了元素时，Delete/Backspace 不转发（避免误触删除整块画板）
    var deleting = key === 'Delete' || key === 'Backspace';
    if (deleting && enabled && mode === 'edit' && selEl) return;
    var interesting =
      key === 'Escape' ||
      deleting ||
      key === '0' ||
      key === '1' ||
      ((e.ctrlKey || e.metaKey) && (key === 'd' || key === 'D'));
    if (!interesting) return;
    if (key !== 'Escape') e.preventDefault();
    send({ type: 'dc:key', key: key, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
  }, true);

  document.addEventListener('keyup', function (e) {
    if (e.key === 'Alt') clearMeasure();
  }, true);

  window.addEventListener('scroll', function () {
    hideHover();
    clearMeasure();
    drawSelection();
  }, true);
  window.addEventListener('resize', function () {
    hideHover();
    drawSelection();
  });

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.channel !== CHANNEL) return;
    if (d.type === 'dc:set-enabled') {
      var nextMode = d.mode === 'edit' ? 'edit' : 'comment';
      if (!d.value || nextMode !== mode) {
        if (editingEl) editingEl.blur();
        clearSelection();
      }
      enabled = !!d.value;
      mode = nextMode;
      hideHover();
      document.documentElement.style.cursor = enabled ? (mode === 'edit' ? 'default' : 'crosshair') : '';
      if (enabled && mode === 'comment') send({ type: 'dc:hover', meta: null });
    } else if (d.type === 'dc:apply-all') {
      applyAll(d.edits || {});
    } else if (d.type === 'dc:clear-selection') {
      if (editingEl) editingEl.blur();
      clearSelection();
    } else if (d.type === 'dc:snapshot') {
      var html = '';
      var error = '';
      try { html = snapshot(); } catch (err) { error = String((err && err.message) || err); }
      send({ type: 'dc:snapshot-result', id: d.id, html: html, title: document.title, error: error });
    }
  });

  send({ type: 'dc:ready' });
  reportLocation();
})();
`
