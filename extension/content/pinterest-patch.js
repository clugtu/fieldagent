// MAIN world, document_start — runs before any Pinterest JS.
// Extension content scripts bypass the page's Content Security Policy, so
// Pinterest's script-src restriction does not apply here.
// Wraps EventTarget.prototype.addEventListener so every mousedown/pointerdown/
// keydown handler receives a Proxy where isTrusted reads as true for synthetic
// events (isTrusted is [LegacyUnforgeable] — non-configurable own property on
// each Event instance — so modifying the instance is impossible; a Proxy is
// the only way to intercept the property read without touching the instance).
//
// Also patches removeEventListener so Pinterest's own removeEventListener calls
// correctly remove the wrapped version.  Without this, Pinterest's backdrop-
// click dismiss handler would never be removed between picker open/close cycles,
// causing every subsequent click (including real user clicks) to dismiss the
// picker without making a selection.
;(function () {
  if (window.__faEventPatchInstalled) return
  window.__faEventPatchInstalled = true

  var _origAEL = EventTarget.prototype.addEventListener
  var _origREL = EventTarget.prototype.removeEventListener

  // WeakMap from the ORIGINAL handler function to the wrapped version so that
  // removeEventListener(type, originalHandler) correctly removes the wrap.
  var _wrapMap = new WeakMap()

  function getWrapped(handler) {
    if (_wrapMap.has(handler)) return _wrapMap.get(handler)
    var wrapped = function (event) {
      if (event.isTrusted) return handler.call(this, event)
      // event.view carries the isolated world's window proxy for cross-world
      // synthetic events; return the MAIN world window so handlers that
      // compare event.view === window see the right object.
      var proxied = new Proxy(event, {
        get: function (target, prop) {
          if (prop === 'isTrusted') return true
          if (prop === 'view') return window
          var val = target[prop]
          return typeof val === 'function' ? val.bind(target) : val
        },
      })
      return handler.call(this, proxied)
    }
    _wrapMap.set(handler, wrapped)
    return wrapped
  }

  var PATCHED_TYPES = new Set([
    'mousedown', 'mouseup', 'click',
    'pointerdown', 'pointerup',
    'keydown', 'keyup',
  ])

  EventTarget.prototype.addEventListener = function (type, handler, options) {
    if (PATCHED_TYPES.has(type) && typeof handler === 'function') {
      return _origAEL.call(this, type, getWrapped(handler), options)
    }
    return _origAEL.call(this, type, handler, options)
  }

  EventTarget.prototype.removeEventListener = function (type, handler, options) {
    if (PATCHED_TYPES.has(type) && typeof handler === 'function' && _wrapMap.has(handler)) {
      return _origREL.call(this, type, _wrapMap.get(handler), options)
    }
    return _origREL.call(this, type, handler, options)
  }

  console.log('[FieldAgent] Pinterest patch: addEventListener + removeEventListener wrapped for isTrusted bypass')
})()
