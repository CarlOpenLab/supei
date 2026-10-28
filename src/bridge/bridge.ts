/**
 * 注入到原型 iframe 内部的桥接脚本（自执行 IIFE 字符串）。
 * 职责：
 * 1. 点选模式下 hover 高亮 + 点击拦截，向宿主上报元素上下文
 * 2. ctrl/cmd + 滚轮缩放转发给宿主（iframe 会吞掉 wheel 事件）
 * 3. 接收宿主的 enable/disable 指令
 * 通信协议：所有消息带 channel: 'design-canvas'。
 */
export const BRIDGE_SCRIPT = String.raw`
(function () {
  if (window.__dcBridge) return
  window.__dcBridge = true

  var enabled = false
  var overlay = null
  var labelEl = null
  var currentEl = null

  var CHANNEL = 'design-canvas'
  function send(msg) {
    msg.channel = CHANNEL
    try { parent.postMessage(msg, '*') } catch (e) {}
  }

  function ensureOverlay() {
    if (overlay) return
    overlay = document.createElement('div')
    overlay.setAttribute('data-dc-overlay', '1')
    overlay.style.cssText =
      'position:fixed;pointer-events:none;display:none;border:2px solid #6366f1;' +
      'background:rgba(99,102,241,0.10);border-radius:3px;z-index:2147483646;' +
      'box-shadow:0 0 0 1px rgba(255,255,255,0.6) inset;transition:top .04s,left .04s,width .04s,height .04s;'
    labelEl = document.createElement('div')
    labelEl.setAttribute('data-dc-overlay', '1')
    labelEl.style.cssText =
      'position:absolute;top:-20px;left:-2px;background:#6366f1;color:#fff;' +
      'font:500 10px/18px ui-monospace,Menlo,Consolas,monospace;padding:0 6px;' +
      'border-radius:3px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;'
    overlay.appendChild(labelEl)
    ;(document.body || document.documentElement).appendChild(overlay)
  }

  function hideOverlay() {
    currentEl = null
    if (overlay) overlay.style.display = 'none'
  }

  function buildSelector(el) {
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && depth < 8) {
      var part = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift(part + '#' + node.id)
        break
      }
      var parent = node.parentElement
      if (parent) {
        var siblings = Array.prototype.filter.call(
          parent.children,
          function (c) { return c.tagName === node.tagName }
        )
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
        }
      }
      parts.unshift(part)
      node = parent
      depth++
    }
    return parts.join(' > ')
  }

  function metaFor(el) {
    var rect = el.getBoundingClientRect()
    var text = ''
    if (el.children.length === 0) {
      text = (el.textContent || '').trim().slice(0, 80)
    }
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList || []),
      text: text,
      outerHTML: el.outerHTML.length > 500 ? el.outerHTML.slice(0, 500) + '…' : el.outerHTML,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  }

  function highlight(el) {
    ensureOverlay()
    currentEl = el
    var r = el.getBoundingClientRect()
    overlay.style.display = 'block'
    overlay.style.left = r.x + 'px'
    overlay.style.top = r.y + 'px'
    overlay.style.width = r.width + 'px'
    overlay.style.height = r.height + 'px'
    labelEl.textContent = el.tagName.toLowerCase() + (el.classList.length ? '.' + Array.prototype.slice.call(el.classList).join('.') : '')
  }

  document.addEventListener('mousemove', function (e) {
    if (!enabled) return
    var t = e.target
    if (!(t instanceof Element)) return
    if (t.closest('[data-dc-overlay]')) return
    if (t === document.documentElement || t === document.body) {
      hideOverlay()
      send({ type: 'dc:hover', meta: null })
      return
    }
    if (t !== currentEl) highlight(t)
  }, true)

  document.addEventListener('mouseleave', function () {
    if (!enabled) return
    hideOverlay()
    send({ type: 'dc:hover', meta: null })
  }, true)

  document.addEventListener('click', function (e) {
    if (!enabled) return
    e.preventDefault()
    e.stopPropagation()
    var t = e.target
    if (!(t instanceof Element)) return
    send({ type: 'dc:select', meta: metaFor(t) })
  }, true)

  window.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    send({
      type: 'dc:wheel',
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      localX: e.clientX,
      localY: e.clientY,
    })
  }, { passive: false, capture: true })

  // 键盘转发：让宿主支持全局快捷键（画板获得焦点时宿主收不到 keydown）。
  // 焦点在可编辑元素内时不转发，避免干扰原型自身的输入。
  function inEditable(t) {
    if (!(t instanceof Element)) return false
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true
    return t.isContentEditable
  }

  document.addEventListener('keydown', function (e) {
    if (inEditable(e.target)) return
    var key = e.key
    var interesting =
      key === 'Escape' ||
      key === 'Delete' ||
      key === 'Backspace' ||
      key === '0' ||
      key === '1' ||
      ((e.ctrlKey || e.metaKey) && (key === 'd' || key === 'D'))
    if (!interesting) return
    if (key !== 'Escape') e.preventDefault()
    send({ type: 'dc:key', key: key, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
  }, true)

  window.addEventListener('scroll', function () { hideOverlay() }, true)
  window.addEventListener('resize', function () { hideOverlay() })

  window.addEventListener('message', function (e) {
    var d = e.data || {}
    if (d.channel !== CHANNEL) return
    if (d.type === 'dc:set-enabled') {
      enabled = !!d.value
      document.documentElement.style.cursor = enabled ? 'crosshair' : ''
      if (!enabled) hideOverlay()
      else send({ type: 'dc:hover', meta: null })
    }
  })

  send({ type: 'dc:ready' })
})();
`
