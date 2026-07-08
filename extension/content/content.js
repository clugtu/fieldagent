/**
 * FieldAgent Content Script
 *
 * Runs on target pages. Responsibilities:
 * - Extract a semantic DOM snapshot via FieldAgentUtils (lib/dom-utils.js)
 * - Call the FieldAgent service /inspect endpoint directly (avoids MV3 service
 *   worker lifetime limits — inference takes 5-10s, longer than SW stays alive)
 * - Apply fill instructions from the service
 * - Watch for significant DOM mutations (multi-step navigation) and re-inspect
 */

;(function () {
  'use strict'

  const { extractSnapshot, applyInstruction } = window.FieldAgentUtils

  const HOSTNAME_HINTS = {
    'www.facebook.com': 'facebook',
    'www.instagram.com': 'instagram',
    'www.pinterest.com': 'pinterest',
    'twitter.com': 'twitter',
    'x.com': 'twitter',
    'www.linkedin.com': 'linkedin',
  }

  const platform = HOSTNAME_HINTS[window.location.hostname] || window.location.hostname
  let inspectDebounceTimer = null
  let lastSnapshotUrl = null
  let inspectInProgress = false

  // ─── URL-lock + post-publish navigation ─────────────────────────────────────
  // Each task is locked to the URL where it was first inspected.  This prevents
  // the agent from running on unrelated pages (pin detail pages, other forms,
  // etc.) after SPA navigation.  One exception: when the user clicks Publish,
  // we allow one post-navigate inspect on the resulting page so the LLM can
  // detect the success state and auto-close the task.

  let taskStartUrl = null        // locked when the first inspect for this task runs
  let allowPostNavInspect = false  // lifted once after the user clicks Publish

  // Reset per-task state when the active task changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('activeTask' in changes)) return
    const prev = changes.activeTask?.oldValue
    const next = changes.activeTask?.newValue
    if (!next || (prev && prev.task_id !== next.task_id)) {
      taskStartUrl = null
      allowPostNavInspect = false
      chrome.storage.local.remove('lastInspectResult').catch(() => {})
    }
  })

  // Intercept SPA navigation (Pinterest uses history.pushState, not page loads).
  // When Publish triggers a navigate, do one final inspect to detect success.
  const _origPush = history.pushState.bind(history)
  history.pushState = function (...args) {
    _origPush(...args)
    if (allowPostNavInspect) {
      allowPostNavInspect = false
      lastSnapshotUrl = null
      scheduleInspect(800)
    }
  }
  window.addEventListener('popstate', () => {
    if (allowPostNavInspect) {
      allowPostNavInspect = false
      lastSnapshotUrl = null
      scheduleInspect(800)
    }
  })

  // Detect the Publish button click so we can allow one post-navigate inspect.
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest('button, [role="button"]')
    if (!btn) return
    const text = (btn.textContent?.trim() || btn.getAttribute('aria-label') || '').toLowerCase()
    if (text === 'publish' || text === 'post') {
      allowPostNavInspect = true
      // Fallback: if Pinterest stays on the same URL (no pushState), inspect in
      // place after 4 s to catch success banners.
      setTimeout(() => {
        if (allowPostNavInspect) {
          allowPostNavInspect = false
          lastSnapshotUrl = null
          scheduleInspect(200)
        }
      }, 4000)
    }
  }, true)

  // ─── File attachment ────────────────────────────────────────────────────────

  async function applyFileAttach(el, instruction, taskId) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'FETCH_ASSET', taskId, assetId: instruction.asset_id },
        (response) => {
          if (!response || response.error) {
            reject(new Error(response?.error || 'Asset fetch failed'))
            return
          }
          try {
            window.FieldAgentUtils.injectFile(el, response)
            resolve()
          } catch (err) {
            reject(err)
          }
        }
      )
    })
  }

  // ─── Upload completion watcher ──────────────────────────────────────────────
  // After a paste_file instruction we snapshot the form BEFORE the upload, then
  // watch for ANY meaningful form change (new inputs appearing, upload zone gaining
  // a preview, zone disappearing entirely). When the diff looks meaningful we set
  // uploadJustCompleted so the next inspect pass tells the LLM "upload finished" —
  // no platform-specific DOM rules needed in the prompt.

  let uploadWatcher = null
  let watchSettleTimer = null
  let uploadFallbackTimer = null  // last-resort re-inspect if observer misses the change
  let lastUploadTaskId = null     // prevents re-running paste_file for the same task
  let uploadJustCompleted = false

  function _formChanged(pre, post) {
    if (post.inputs.length > pre.inputs.length) return true
    const preHasPreview = pre.upload_zones.some((z) => z.has_preview)
    const postHasPreview = post.upload_zones.some((z) => z.has_preview)
    if (!preHasPreview && postHasPreview) return true
    if (pre.upload_zones.length > 0 && post.upload_zones.length === 0) return true
    return false
  }

  function watchForFormChange(preSnapshot) {
    if (uploadWatcher) return

    uploadWatcher = new MutationObserver(() => {
      clearTimeout(watchSettleTimer)
      watchSettleTimer = setTimeout(() => {
        const postSnapshot = extractSnapshot(platform)
        if (!_formChanged(preSnapshot, postSnapshot)) return
        clearTimeout(uploadFallbackTimer)
        uploadWatcher.disconnect()
        uploadWatcher = null
        lastSnapshotUrl = null
        uploadJustCompleted = true
        scheduleInspect(500)
      }, 800)
    })

    // Widen the attribute filter: Pinterest previews can use srcset or
    // style="background-image:..." rather than a plain src attribute.
    uploadWatcher.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'src', 'srcset', 'style'],
    })

    setTimeout(() => {
      if (uploadWatcher) { uploadWatcher.disconnect(); uploadWatcher = null }
    }, 3 * 60 * 1000)
  }

  // ─── Event-driven waiting ───────────────────────────────────────────────────
  // Wait until a CSS selector matches something in the DOM, or maxWait ms pass.
  // Resolves with the element (or null on timeout). Faster and more robust than
  // fixed sleeps because it fires the moment the element actually appears.

  function waitForElement(selector, maxWait = 3000) {
    // Like document.querySelector but skips elements inside aria-hidden containers
    // (inactive Pinterest draft panels, hidden sidebars) so we find the visible one.
    function findVisible() {
      for (const el of document.querySelectorAll(selector)) {
        if (!el.closest('[aria-hidden="true"]')) return el
      }
      return null
    }
    return new Promise((resolve) => {
      const existing = findVisible()
      if (existing) { resolve(existing); return }
      const obs = new MutationObserver(() => {
        const el = findVisible()
        if (el) { obs.disconnect(); resolve(el) }
      })
      obs.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => { obs.disconnect(); resolve(findVisible()) }, maxWait)
    })
  }

  // Wait until resolveElement can find the instruction's target.
  // Used after a click opens a dropdown whose contents aren't in the DOM yet.
  // Preserves the original action so action-specific guards (e.g. the
  // isContentEditable skip for click actions) remain in effect while waiting.
  function waitForTarget(ins, maxWait = 1500) {
    return new Promise((resolve) => {
      const existing = window.FieldAgentUtils.resolveElement(ins)
      if (existing) { resolve(existing); return }
      const obs = new MutationObserver(() => {
        const el = window.FieldAgentUtils.resolveElement(ins)
        if (el) { obs.disconnect(); resolve(el) }
      })
      // Include attribute changes: Pinterest toggles visibility via class/style
      // rather than add/remove elements, so childList alone misses the transition.
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] })
      setTimeout(() => { obs.disconnect(); resolve(window.FieldAgentUtils.resolveElement(ins)) }, maxWait)
    })
  }

  // ─── User-change detection ──────────────────────────────────────────────────
  // When the user manually types or interacts with the page (outside our
  // instruction application), re-inspect so MiniForge stays in sync.

  let applyingInstructions = false

  document.addEventListener('input', () => {
    if (applyingInstructions) return
    lastSnapshotUrl = null
    scheduleInspect(1200)
  }, true) // capture phase — sees events before React

  // ─── React fiber click helper ────────────────────────────────────────────────
  // Pinterest's custom pickers (board results, section items) use React event
  // handlers that check event.isTrusted and silently ignore all synthetic DOM
  // events. Calling the fiber's handler function directly with isTrusted: true
  // bypasses both the browser event system and the isTrusted guard.
  // Returns true if a handler was found and called, false if nothing was found.

  function reactFiberClick(el) {
    try {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
      if (!fk) return false
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
      for (let f = el[fk]; f; f = f.return) {
        const p = f.memoizedProps
        if (!p) continue
        const h = p.onClick || p.onMouseDown || p.onPointerDown
        if (!h) continue
        const evType = p.onClick ? 'click' : p.onMouseDown ? 'mousedown' : 'pointerdown'
        const currentTarget = (f.stateNode instanceof Element) ? f.stateNode : el
        console.log(`[FieldAgent] reactFiberClick: firing ${evType} on stateNode=${currentTarget.tagName || 'component'}`)
        h({
          type: evType, isTrusted: true, bubbles: true, cancelable: true,
          target: el, currentTarget,
          button: 0, buttons: 1, which: 1,
          clientX: cx, clientY: cy, pageX: cx, pageY: cy,
          screenX: cx, screenY: cy, detail: 1,
          shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
          preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
          isPropagationStopped() { return false }, isDefaultPrevented() { return false },
          persist() {},
          nativeEvent: {
            type: evType, isTrusted: true, target: el, button: 0,
            clientX: cx, clientY: cy, preventDefault() {}, stopPropagation() {},
          },
        })
        return true
      }
    } catch (e) { console.warn('[FieldAgent] reactFiberClick error', e) }
    return false
  }

  // Fire a keyboard event via the element's React onKeyDown handler with
  // isTrusted: true. Pinterest's board picker keyboard navigation rejects
  // synthetic DOM KeyboardEvents (isTrusted=false) but accepts handler calls.
  function reactFiberKeyDown(el, key, keyCode) {
    try {
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))
      if (!fk) return false
      for (let f = el[fk]; f; f = f.return) {
        const p = f.memoizedProps
        if (!p?.onKeyDown) continue
        const currentTarget = (f.stateNode instanceof Element) ? f.stateNode : el
        const codeMap = { ArrowDown: 'ArrowDown', Enter: 'Enter' }
        p.onKeyDown({
          type: 'keydown', isTrusted: true, bubbles: true, cancelable: true,
          key, keyCode, which: keyCode, code: codeMap[key] || key,
          target: el, currentTarget,
          shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
          repeat: false, isComposing: false,
          preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
          isPropagationStopped() { return false }, isDefaultPrevented() { return false },
          persist() {},
          nativeEvent: {
            type: 'keydown', isTrusted: true, key, keyCode, which: keyCode,
            target: el, preventDefault() {}, stopPropagation() {},
          },
        })
        console.log(`[FieldAgent] reactFiberKeyDown: fired ${key} on stateNode=${currentTarget.tagName || 'component'}`)
        return true
      }
    } catch (e) { console.warn('[FieldAgent] reactFiberKeyDown error', e) }
    return false
  }

  // Ask the service worker to dispatch a truly trusted CDP mouse click at the
  // centre of el. Returns a promise that resolves true on success, false on failure.
  // Required for elements whose click handlers use document-level native listeners
  // that check event.isTrusted (e.g. Pinterest's board autocomplete results).
  function cdpClick(el) {
    const rect = el.getBoundingClientRect()
    // Local (iframe-relative) centre of the element — used for elementFromPoint
    // diagnostic and for the el-level event listeners below.
    const localX = Math.round(rect.left + rect.width / 2)
    const localY = Math.round(rect.top + rect.height / 2)

    // CDP Input.dispatchMouseEvent uses TOP-LEVEL viewport coordinates, but
    // getBoundingClientRect() in an iframe returns iframe-local coordinates.
    // Walk window.frameElement up the same-origin frame chain and accumulate
    // each iframe's offset so CDP fires at the correct screen position.
    let x = localX, y = localY
    const inIframe = window !== window.top
    if (inIframe) {
      try {
        let win = window
        while (win !== win.top) {
          const fe = win.frameElement   // null if cross-origin
          if (!fe) break
          const fr = fe.getBoundingClientRect()
          x += fr.left
          y += fr.top
          win = win.parent
        }
      } catch (_) {}
      x = Math.round(x)
      y = Math.round(y)
    }

    const atPoint = document.elementFromPoint(localX, localY)
    const atText = (atPoint?.textContent?.trim() || '').slice(0, 30)
    console.log(`[FieldAgent] cdpClick: el="${(el.textContent?.trim() || '').slice(0,30)}" inIframe=${inIframe} local=(${localX},${localY}) cdp=(${x},${y}) elementFromPoint="${atText}"`)

    // Document-level capture listeners see ALL events before any element handler.
    // Element-level listeners fire even if the event doesn't propagate to document
    // (e.g. closed shadow DOM, top-layer dialog, cross-frame delivery mismatch).
    // Comparing which fires tells us WHERE the CDP events actually land.
    const logDoc = (e) => {
      console.log(`[FieldAgent] cdpClick: DOC-${e.type} isTrusted=${e.isTrusted} target=${e.target?.tagName}[${e.target?.getAttribute?.('role')||''}] txt="${(e.target?.textContent?.trim()||'').slice(0,25)}"`)
    }
    const logEl = (e) => {
      console.log(`[FieldAgent] cdpClick: EL-${e.type} isTrusted=${e.isTrusted}`)
    }
    document.addEventListener('mousedown',  logDoc, { capture: true, once: true })
    document.addEventListener('mouseup',    logDoc, { capture: true, once: true })
    document.addEventListener('click',      logDoc, { capture: true, once: true })
    document.addEventListener('pointerdown',logDoc, { capture: true, once: true })
    document.addEventListener('pointerup',  logDoc, { capture: true, once: true })
    el.addEventListener('mousedown',  logEl, { once: true })
    el.addEventListener('mouseup',    logEl, { once: true })
    el.addEventListener('click',      logEl, { once: true })
    el.addEventListener('pointerdown',logEl, { once: true })
    el.addEventListener('pointerup',  logEl, { once: true })

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CDP_CLICK', x, y }, (r) => {
        document.removeEventListener('mousedown',  logDoc, { capture: true })
        document.removeEventListener('mouseup',    logDoc, { capture: true })
        document.removeEventListener('click',      logDoc, { capture: true })
        document.removeEventListener('pointerdown',logDoc, { capture: true })
        document.removeEventListener('pointerup',  logDoc, { capture: true })
        el.removeEventListener('mousedown',  logEl)
        el.removeEventListener('mouseup',    logEl)
        el.removeEventListener('click',      logEl)
        el.removeEventListener('pointerdown',logEl)
        el.removeEventListener('pointerup',  logEl)
        if (chrome.runtime.lastError) {
          console.warn('[FieldAgent] cdpClick: runtime error —', chrome.runtime.lastError.message)
          resolve(false)
        } else if (r?.ok) {
          // topFrameEl tells us what the top-level frame sees at (x,y) via
          // Runtime.evaluate — if it's 'IFRAME:…' the form is in a child frame
          // and our content-script coordinates are iframe-relative, not top-level.
          console.log(`[FieldAgent] cdpClick: succeeded topFrameEl=${r.topFrameEl}`)
          resolve(true)
        } else {
          console.warn('[FieldAgent] cdpClick: failed —', r?.error)
          resolve(false)
        }
      })
    })
  }

  // Ask the SW to fire trusted CDP keyboard events at the currently focused element.
  // Used for board-picker listitem selection: ArrowDown highlights the first autocomplete
  // item, Enter selects it — without moving focus away from the search input (unlike
  // mousePressed which triggers blur → autocomplete closes before click fires).
  function cdpKeys(keys) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'CDP_KEYS', keys }, r => {
        if (chrome.runtime.lastError) { resolve(false); return }
        if (r?.ok) { console.log('[FieldAgent] cdpKeys: ok', keys); resolve(true) }
        else { console.warn('[FieldAgent] cdpKeys: failed —', r?.error); resolve(false) }
      })
    })
  }

  // ─── Apply instructions ─────────────────────────────────────────────────────

  async function applyInstructions(instructions, taskId) {
    applyingInstructions = true
    // Inject the isTrusted-bypass patch into the page's MAIN world before any
    // instruction runs. The scripting API bypasses Pinterest's CSP. The patch
    // wraps addEventListener so synthetic mousedown/pointerdown/keydown events
    // appear trusted to handlers registered AFTER this call — which includes
    // Pinterest's board-picker mousedown listener (registered when the picker opens).
    // The world:MAIN document_start content script covers handlers registered at
    // page load; this covers the board picker's dynamic registration.
    if (platform === 'pinterest') {
      await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'INJECT_MAIN_PATCH' }, r => {
          if (chrome.runtime.lastError) {
            console.warn('[FieldAgent] INJECT_MAIN_PATCH:', chrome.runtime.lastError.message)
          } else {
            console.log('[FieldAgent] INJECT_MAIN_PATCH:', r?.ok ? 'ok' : ('failed — ' + r?.error))
          }
          resolve()
        })
      )
    }
    // Pre-attach the CDP debugger now, before any board-picker interactions.
    // Attaching causes the focused input to blur (dismissing the autocomplete),
    // so we attach early while nothing sensitive is open, then reuse the session
    // for CDP_CLICK calls without re-attaching mid-interaction.
    // Send window.location.href so the SW can do an exact-URL tab search as a
    // reliable fallback when sender.tab.id is missing or points to a non-web tab.
    const cdpReady = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'CDP_ATTACH', pageUrl: window.location.href }, r => {
        if (chrome.runtime.lastError) { resolve(false); return }
        if (!r?.ok) console.warn('[FieldAgent] CDP_ATTACH failed:', r?.error)
        resolve(r?.ok ?? false)
      })
    )
    console.log('[FieldAgent] applyInstructions: CDP pre-attach =', cdpReady)
    try {
    for (let _insIdx = 0; _insIdx < instructions.length; _insIdx++) {
      const ins = instructions[_insIdx]
      console.log(`[FieldAgent] exec: ${ins.action} | sel="${ins.selector_hint || ''}" hint="${ins.fallback_hint || ''}" val=${JSON.stringify(ins.value || '')}`)
      if (ins.action === 'paste_file') {
        if (lastUploadTaskId === taskId) {
          // LLM re-issued paste_file without seeing the completed state.
          uploadJustCompleted = true
          lastSnapshotUrl = null
          scheduleInspect(300)
          break
        }
        lastUploadTaskId = taskId
        const preSnapshot = extractSnapshot(platform)

        // Inject the file directly — no CDP debugger needed.
        // Pinterest's upload zone accepts DragEvents (drag-and-drop); if no
        // zone is found we fall back to injecting into the bare file input.
        try {
          const assetData = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { type: 'FETCH_ASSET', taskId, assetId: ins.asset_id },
              (r) => {
                if (!r || r.error) reject(new Error(r?.error || 'Asset fetch failed'))
                else resolve(r)
              }
            )
          })
          const dropZone = window.FieldAgentUtils.resolveElement({ ...ins, action: 'paste_file' })
          if (dropZone) {
            window.FieldAgentUtils.pasteFileIntoDropZone(dropZone, assetData)
          } else {
            const fileInput = document.querySelector('input[type="file"]')
            if (fileInput) {
              window.FieldAgentUtils.injectFile(fileInput, assetData)
            } else {
              console.warn('[FieldAgent] paste_file: no drop zone or file input found')
            }
          }
        } catch (err) {
          console.error('[FieldAgent] paste_file injection failed:', err)
        }

        watchForFormChange(preSnapshot)

        // Fallback: if the mutation observer doesn't detect the upload completion
        // (Pinterest may update via srcset / background-image / JS state only),
        // force a re-inspect after 10 s so FieldAgent never gets stuck here.
        clearTimeout(uploadFallbackTimer)
        uploadFallbackTimer = setTimeout(() => {
          if (!uploadJustCompleted) {
            console.log('[FieldAgent] paste_file: fallback timer — forcing re-inspect')
            uploadJustCompleted = true
            lastSnapshotUrl = null
            scheduleInspect(200)
          }
        }, 3_000)
        break
      } else if (ins.action === 'pick') {
        // Type text into a field and React-click the first autocomplete result
        // whose text starts with the target value. React fiber click bypasses
        // isTrusted guards that block synthetic DOM events on custom pickers.
        let el = await waitForTarget(ins, 1500)
        // Always prefer the board-picker search input when it's visible in the DOM.
        // The LLM can accidentally resolve the tag search (#combobox-storyboard-interest-tags)
        // instead of the board search — override silently whenever the board picker is open.
        // Tags input is explicitly excluded so it can never be returned as the board input.
        const BOARD_EXCLUDED_IDS = new Set([
          'storyboard-selector-title',
          'WebsiteField',
          'combobox-storyboard-interest-tags',
        ])
        const BOARD_SELECTORS = [
          '[aria-label="Search through your boards"]',
          '[aria-label="Search for a board"]',
          '[placeholder="Search for a board"]',
          '[placeholder="Find a board"]',
          // Pinterest sometimes uses a bare "Search" placeholder for the board picker.
          // The tags input uses "Search for a tag" so this won't match it.
          '[placeholder="Search"]:not(#combobox-storyboard-interest-tags)',
        ]
        const findBoardInput = () => {
          for (const sel of BOARD_SELECTORS) {
            const inp = document.querySelector(sel)
            if (inp && !BOARD_EXCLUDED_IDS.has(inp.id) &&
                !inp.closest('[aria-hidden="true"]') && inp.offsetParent !== null) return inp
          }
          return Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'))
            .find(inp =>
              !inp.closest('[aria-hidden="true"]') && inp.offsetParent !== null &&
              !BOARD_EXCLUDED_IDS.has(inp.id) &&
              ((inp.getAttribute('aria-label') || '') + ' ' + (inp.placeholder || '')).toLowerCase().includes('board')
            ) || null
        }
        // Reactive wait: the pick action may run immediately after the click action
        // that opens the board picker, before the picker's DOM/animation settles.
        // Use a MutationObserver so we catch the board input the instant it
        // becomes visible — no fixed timeout needed. Cap at 1500 ms.
        // Also observe attribute changes (style/class) in case Pinterest toggles
        // display via CSS class rather than inserting new DOM nodes.
        //
        // If the picker is not already open, try to find and click the board button
        // ourselves — the preceding click instruction may have used a bad selector.
        if (!findBoardInput()) {
          const boardBtn = Array.from(document.querySelectorAll('[role="button"], button'))
            .find(btn => {
              const r = btn.getBoundingClientRect()
              if (r.width === 0 || r.height === 0) return false
              if (btn.closest('[aria-hidden="true"]')) return false
              const lbl = (btn.getAttribute('aria-label') || '').trim().toLowerCase()
              const txt = (btn.textContent || '').trim().toLowerCase()
              const matchesBoard = lbl.startsWith('board') || txt.startsWith('board')
              const notCreate = !txt.startsWith('create board') && !lbl.startsWith('create board')
              return matchesBoard && notCreate
            })
          if (boardBtn) {
            console.log('[FieldAgent] pick: board picker not open — auto-clicking board button:', boardBtn.textContent.trim().slice(0, 40))
            boardBtn.click()
          } else {
            console.warn('[FieldAgent] pick: board picker not open and board button not found')
          }
        }
        const boardPickerInput = await new Promise((resolve) => {
          const found = findBoardInput()
          if (found) { resolve(found); return }
          const obs = new MutationObserver(() => {
            const inp = findBoardInput()
            if (inp) { obs.disconnect(); clearTimeout(t); resolve(inp) }
          })
          obs.observe(document.body, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['style', 'class', 'hidden'],
          })
          const t = setTimeout(() => { obs.disconnect(); resolve(findBoardInput()) }, 1500)
        })
        if (boardPickerInput && el !== boardPickerInput) {
          console.log('[FieldAgent] pick: board-picker visible — overriding LLM-resolved element with board search input')
          el = boardPickerInput
        }
        // Fallback: LLM may send hint="Miniatures" (the value to pick, not the
        // field label). If no element found, reactive-wait for the board-picker
        // search input to appear in the DOM.
        if (!el) {
          // Board-picker search input fallback: reactive wait so we catch the
          // input the moment the board picker overlay appears in the DOM.
          el = await new Promise((resolve) => {
            const found = findBoardInput()
            if (found) { resolve(found); return }
            const obs = new MutationObserver(() => {
              const inp = findBoardInput()
              if (inp) { obs.disconnect(); clearTimeout(t); resolve(inp) }
            })
            obs.observe(document.body, { childList: true, subtree: true })
            const t = setTimeout(() => { obs.disconnect(); resolve(findBoardInput()) }, 2000)
          })
          if (el) {
            console.log(`[FieldAgent] pick: resolved via board-picker fallback aria="${el.getAttribute('aria-label') || ''}" placeholder="${el.placeholder || ''}"`)
          } else {
            const allInputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable]'))
              .filter(e => e.offsetParent !== null && !e.closest('[aria-hidden="true"]'))
              .map(e => `aria="${e.getAttribute('aria-label') || ''}" ph="${e.placeholder || ''}" id="${e.id || ''}"`)
            console.warn('[FieldAgent] pick: no board input found. visible inputs:', allInputs)
          }
        }
        // Look ahead: if the next instruction is a click, it may be a section
        // in the board picker — we'll pass it to PICK_BOARD for atomic click.
        const _nextClickIns = instructions[_insIdx + 1]
        const nextHint = (_nextClickIns?.action === 'click')
          ? (_nextClickIns.fallback_hint || _nextClickIns.value || '').trim()
          : ''
        // When the board is already selected Pinterest sometimes shows its
        // sections immediately on picker open (before any search is typed).
        // But the board picker's DEFAULT view also shows all boards as listitems
        // (including boards named "Cthulhu") — we must not confuse a board with
        // a section.  "Create board" is present in board-picker mode but absent
        // in section-picker mode, so we use it as a sentinel.
        const _inBoardPickerMode = () =>
          Array.from(document.querySelectorAll('button, [role="button"], [role="listitem"]'))
            .some(e => e.offsetParent !== null && !e.closest('[aria-hidden="true"]') &&
                       (e.textContent?.trim() || '').toLowerCase().includes('create board'))
        let pickedEarly = false
        if (el && nextHint && !_inBoardPickerMode()) {
          const _snorm = nextHint.toLowerCase()
          const _earlySection = await new Promise(resolve => {
            function _findEarly() {
              if (_inBoardPickerMode()) return null
              return Array.from(document.querySelectorAll('[role="listitem"], [role="option"], button'))
                .find(s => !s.closest('[aria-hidden="true"]') && s.offsetParent !== null &&
                           s.textContent.trim().toLowerCase().startsWith(_snorm)) || null
            }
            const _imm = _findEarly()
            if (_imm) { resolve(_imm); return }
            const _obs = new MutationObserver(() => {
              const _found = _findEarly()
              if (_found) { _obs.disconnect(); clearTimeout(_earlyT); resolve(_found) }
            })
            _obs.observe(document.body, { childList: true, subtree: true })
            const _earlyT = setTimeout(() => { _obs.disconnect(); resolve(null) }, 800)
          })
          if (_earlySection) {
            // Section is visible in section-picker mode — click it from MAIN world
            // (fiber+event dispatch) so isTrusted=true guards are satisfied.
            // boardName='' tells PICK_BOARD to skip the board search.
            console.log(`[FieldAgent] pick: section "${nextHint}" visible in section-picker mode — clicking via PICK_BOARD`)
            const earlyPickResult = await new Promise(resolve =>
              chrome.runtime.sendMessage({ type: 'PICK_BOARD', boardName: '', sectionName: nextHint }, r => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
                else resolve(r || { ok: false })
              })
            )
            console.log('[FieldAgent] pick: early PICK_BOARD result', JSON.stringify(earlyPickResult))
            if (earlyPickResult?.result?.section?.ok) {
              _insIdx++
              pickedEarly = true
            }
          }
        }
        if (el && !pickedEarly) {
          console.log(`[FieldAgent] pick: typing "${ins.value}" into el tag=${el.tagName} aria="${el.getAttribute('aria-label') || ''}" placeholder="${el.placeholder || ''}"`)
          window.FieldAgentUtils.applyTextFill(el, ins.value)
          const valueLC = (ins.value || '').toLowerCase()
          // Wait (event-driven, max 3s) for a text-matching autocomplete result.
          let matchEl = null
          await new Promise((resolve) => {
            function check() {
              for (const c of document.querySelectorAll('[role="option"], [role="menuitem"], [role="button"], [role="listitem"]')) {
                if (!c.closest('[aria-hidden="true"]') &&
                    (c.textContent?.trim() || '').toLowerCase().startsWith(valueLC)) {
                  matchEl = c; obs.disconnect(); clearTimeout(t); resolve(); return
                }
              }
            }
            const obs = new MutationObserver(check)
            obs.observe(document.body, { childList: true, subtree: true })
            const t = setTimeout(() => { obs.disconnect(); resolve() }, 3000)
            check()
          })
          if (matchEl) {
            const mText = (matchEl.textContent?.trim() || '').slice(0, 40)
            const mRole = matchEl.getAttribute('role') || matchEl.tagName
            console.log(`[FieldAgent] pick: match found "${mText}" [${mRole}]`)
            // Brief settle before clicking — gives Pinterest time to finish registering
            // native event listeners on the autocomplete dropdown items.
            await new Promise(r => setTimeout(r, 350))
            // For board autocomplete listitems we try approaches in order.
            let clickOk
            if (mRole === 'listitem') {
              // Snapshot current listitem texts — used after the pick attempt to detect
              // a board→section transition (board selection succeeded even if matchEl
              // wasn't removed from DOM, because React may reuse the DOM element).
              const beforeListitemTexts = new Set(
                Array.from(document.querySelectorAll('[role="listitem"]'))
                  .filter(e => !e.closest('[aria-hidden="true"]') && e.offsetParent !== null)
                  .map(e => (e.textContent?.trim() || '').toLowerCase())
              )

              // 1. PICK_BOARD via executeScript in MAIN world.
              //    Events bubble through React's event delegation (root container
              //    listener wrapped by the world:MAIN document_start patch) so
              //    React's SyntheticEvent gets isTrusted=true via the Proxy.
              // nextHint already computed above from lookahead.
              console.log('[FieldAgent] pick: trying PICK_BOARD (MAIN world)' + (nextHint ? ` sectionName="${nextHint}"` : ''))
              const pickResult = await new Promise(resolve =>
                chrome.runtime.sendMessage({ type: 'PICK_BOARD', boardName: mText, sectionName: nextHint || undefined }, r => {
                  if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
                  else resolve(r || { ok: false })
                })
              )
              console.log('[FieldAgent] pick: PICK_BOARD result', JSON.stringify(pickResult))
              // If the atomic board+section click succeeded, skip the next click instruction.
              if (pickResult?.result?.section?.ok && nextHint) {
                console.log(`[FieldAgent] pick: section "${nextHint}" clicked atomically — skipping next instruction`)
                _insIdx++
              }
              await new Promise(r => setTimeout(r, 800))
              // Primary: listitem left the DOM.
              // Secondary: listitem content changed (board→section view, React reuses DOM).
              const afterListitems = Array.from(document.querySelectorAll('[role="listitem"]'))
                .filter(e => !e.closest('[aria-hidden="true"]') && e.offsetParent !== null)
              const listitemContentChanged = afterListitems.some(
                e => !(beforeListitemTexts.has((e.textContent?.trim() || '').toLowerCase()))
              )
              // Tertiary: board button now shows the board name (PICK_BOARD reports this).
              // Section picker items often have no [role="listitem"], so DOM checks can
              // report clickOk=false even when the board WAS selected. Checking the board
              // button text is the most reliable indicator that a selection occurred.
              const boardBtnText = (pickResult?.result?.boardBtnText || '').toLowerCase()
              const boardBtnShowsBoard = boardBtnText.length > 0 && boardBtnText.includes(valueLC)
              clickOk = !document.contains(matchEl) || listitemContentChanged || boardBtnShowsBoard
              console.log(`[FieldAgent] pick: PICK_BOARD clickOk=${clickOk} (gone=${!document.contains(matchEl)} contentChanged=${listitemContentChanged} boardBtn="${boardBtnText}")`)

              if (!clickOk) {
                // 2. React fiber walk from isolated world (fallback).
                clickOk = reactFiberClick(matchEl)
              }

              if (!clickOk) {
                // 3. Synthetic event sequence with hover pre-conditioning.
                //    mouseover/mousemove fire first so Pinterest's picker registers
                //    the item as "active" before the mousedown commit event fires.
                //    The isTrusted-bypass Proxy (installed by INJECT_MAIN_PATCH) makes
                //    the mousedown handler see isTrusted=true.
                console.log('[FieldAgent] pick: trying synthetic events with hover pre-conditioning')
                const sRect = matchEl.getBoundingClientRect()
                const sCx = Math.round(sRect.left + sRect.width / 2)
                const sCy = Math.round(sRect.top + sRect.height / 2)
                const sOpts = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: sCx, clientY: sCy, view: window }
                // Hover pre-conditioning
                matchEl.dispatchEvent(new MouseEvent('mouseover', sOpts))
                matchEl.dispatchEvent(new MouseEvent('mousemove', sOpts))
                await new Promise(r => setTimeout(r, 150))
                // Press sequence
                matchEl.dispatchEvent(new PointerEvent('pointerdown', { ...sOpts, isPrimary: true, pointerId: 1 }))
                matchEl.dispatchEvent(new MouseEvent('mousedown', sOpts))
                await new Promise(r => setTimeout(r, 80))
                matchEl.dispatchEvent(new MouseEvent('mouseup', { ...sOpts, buttons: 0 }))
                matchEl.dispatchEvent(new PointerEvent('pointerup', { ...sOpts, buttons: 0, isPrimary: true, pointerId: 1 }))
                matchEl.dispatchEvent(new MouseEvent('click', { ...sOpts, buttons: 0, detail: 1 }))
                await new Promise(r => setTimeout(r, 300))
                clickOk = !document.contains(matchEl)
                console.log(`[FieldAgent] pick: synthetic events clickOk=${clickOk} (el in DOM: ${document.contains(matchEl)})`)
              }

              if (!clickOk) {
                // 3. React fiber keyboard nav — works when Pinterest exposes onKeyDown
                //    via React props (fakes isTrusted:true so handlers accept it).
                //    Pinterest's board picker uses document.addEventListener instead,
                //    so this typically returns false and we fall through.
                console.log('[FieldAgent] pick: trying reactFiberKeyDown ArrowDown+Enter on search input')
                reactFiberKeyDown(el, 'ArrowDown', 40)
                await new Promise(r => setTimeout(r, 300))
                reactFiberKeyDown(el, 'Enter', 13)
                await new Promise(r => setTimeout(r, 500))
                clickOk = !document.contains(matchEl)
                console.log(`[FieldAgent] pick: reactFiberKeyDown clickOk=${clickOk} (el in DOM: ${document.contains(matchEl)})`)
              }

              if (!clickOk) {
                // 4. Plain DOM keyboard events on the focused search input.
                //    isTrusted=false but keyboard handlers in board pickers rarely check
                //    isTrusted (unlike mouse handlers, which use it for anti-bot).
                console.log('[FieldAgent] pick: trying synthetic keyboard ArrowDown+Enter')
                try { el.focus() } catch (_) {}
                const kOpts = { bubbles: true, cancelable: true, composed: true }
                el.dispatchEvent(new KeyboardEvent('keydown', { ...kOpts, key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 }))
                await new Promise(r => setTimeout(r, 250))
                el.dispatchEvent(new KeyboardEvent('keydown', { ...kOpts, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }))
                await new Promise(r => setTimeout(r, 500))
                clickOk = !document.contains(matchEl)
                console.log(`[FieldAgent] pick: synthetic keyboard clickOk=${clickOk} (el in DOM: ${document.contains(matchEl)})`)
              }

              if (!clickOk) {
                // 5. matchEl.click() — fires a trusted click event (isTrusted=true) without
                //    a full mouse-event sequence. Doesn't cause OS-level focus transfer so
                //    the search input doesn't blur before the click handler fires.
                //    Works when Pinterest's selection handler is on 'click', not only 'mousedown'.
                console.log('[FieldAgent] pick: trying matchEl.click()')
                matchEl.click()
                await new Promise(r => setTimeout(r, 500))
                clickOk = !document.contains(matchEl)
                console.log(`[FieldAgent] pick: matchEl.click() clickOk=${clickOk} (el in DOM: ${document.contains(matchEl)})`)
              }

              if (!clickOk) {
                // 6. CDP trusted mouse events — isTrusted=true via chrome.debugger.
                //    Requires no other debugger attached to the tab (closing the SW
                //    DevTools inspector unblocks this).
                console.log('[FieldAgent] pick: trying CDP click')
                await cdpClick(matchEl)
                // cdpClick.ok does not reliably indicate board selection; post-pick check below decides
              }
            } else {
              clickOk = await cdpClick(matchEl)
              if (!clickOk) reactFiberClick(matchEl)
            }
          } else {
            // No specific match element — try CDP keyboard ArrowDown+Enter focused
            // on the search input as a last-resort navigation attempt.
            console.log('[FieldAgent] pick: no match element — keyboard fallback')
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true }))
            await new Promise((r) => setTimeout(r, 120))
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
          }
        } // end if (el && !pickedEarly)
        if (el) {
          // Wait for picker to settle (section list may appear after board selection).
          await new Promise((r) => setTimeout(r, pickedEarly ? 200 : 1000))
          // Show board button text and ALL visible interactive elements so we can
          // see if a separate "Section" button appeared after board selection.
          const boardBtn = document.querySelector('[aria-label="Board"], [data-testid*="board-dropdown"]')
          const boardText = boardBtn ? (boardBtn.textContent?.trim() || '').slice(0, 50) : '(board btn not found)'
          const visibleSections = Array.from(document.querySelectorAll('[role="listitem"]'))
            .filter(e => !e.closest('[aria-hidden="true"]'))
            .map(e => (e.textContent?.trim() || '').slice(0, 20))
          const allBtns = Array.from(document.querySelectorAll('button, [role="button"], [role="option"]'))
            .filter(e => e.offsetParent !== null && !e.closest('[aria-hidden="true"]'))
            .map(e => `"${(e.getAttribute('aria-label') || e.textContent?.trim() || '').slice(0, 30)}"`)
          console.log(`[FieldAgent] pick: post-pick board="${boardText}" sections=[${visibleSections.slice(0, 10).join(', ')}] btns=[${allBtns.slice(0, 20).join(', ')}]`)
        }
      } else if (ins.action === 'click') {
        // Try immediately; if the element isn't in the DOM yet (e.g. a section
        // picker that appears after the board pick above), wait up to 2 s for a
        // DOM mutation that makes it findable.  This lets the LLM emit board +
        // section click instructions in one response instead of needing a second
        // inspect pass.
        let el = window.FieldAgentUtils.resolveElement(ins)
        if (!el) el = await waitForTarget(ins, 2000)
        const hint = ins.fallback_hint || ''
        // If hint is set and the resolved element's text doesn't match, search
        // for an interactive element whose text includes the hint.  This handles
        // generic selectors like [role="listitem"] when multiple listitems are
        // present (e.g. "Miniatures" section vs "Cthulhu" section in the board
        // picker's section list).  Use a reactive wait so async-rendered items
        // (sections that appear after a short delay) are caught.
        if (hint) {
          const hintLC = hint.trim().toLowerCase()
          // Use startsWith so the description field (which contains "Call of Cthulhu
          // campaigns" in its full textContent) is never matched when hint="Cthulhu".
          // Also cap the candidate text length: board/section labels are short;
          // form-field containers with long descendant text are excluded.
          const textMatches = (candidate) => {
            const txt = (candidate.textContent?.trim() || '').toLowerCase()
            return txt.length < 80 && txt.startsWith(hintLC)
          }
          if (!el || !textMatches(el)) {
            const findByText = () =>
              Array.from(document.querySelectorAll(
                '[role="option"], [role="menuitem"], [role="listitem"],' +
                ' button, [role="button"]'
              )).find(e =>
                !e.closest('[aria-hidden="true"]') &&
                e.offsetParent !== null &&
                textMatches(e)
              ) || null
            const textMatch = await new Promise(resolve => {
              const immediate = findByText()
              if (immediate) { resolve(immediate); return }
              const obs = new MutationObserver(() => {
                const m = findByText()
                if (m) { obs.disconnect(); clearTimeout(t); resolve(m) }
              })
              obs.observe(document.body, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
              })
              const t = setTimeout(() => { obs.disconnect(); resolve(findByText()) }, 4000)
            })
            if (textMatch) {
              console.log(`[FieldAgent] click: hint="${hint}" — text-matched el tag=${textMatch.tagName} txt="${(textMatch.textContent?.trim() || '').slice(0, 40)}"`)
              el = textMatch
            }
          }
        }
        if (el) {
          console.log(`[FieldAgent] click: found el tag=${el.tagName} role="${el.getAttribute('role') || ''}" txt="${(el.textContent?.trim() || '').slice(0, 40)}"`)
          if (!reactFiberClick(el)) el.click()
        } else {
          // Log what was available so we can diagnose the missing selector.
          const sel = ins.selector_hint || ''
          const available = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], [role="listitem"]'))
            .map((b) => `<${b.tagName.toLowerCase()} aria-label="${b.getAttribute('aria-label') || ''}" text="${(b.textContent?.trim() || '').slice(0, 40)}">`)
            .slice(0, 20)
          console.warn(
            `[FieldAgent] click: element not found | selector="${sel}" fallback="${hint}"\n` +
            'Available: ' + available.join(' | ')
          )
        }
        // After any chevron/section click attempt (found or not), log visible
        // section candidates — sections appear here whether or not we clicked ">".
        if (hint === '>' || hint.includes('chevron')) {
          await new Promise((r) => setTimeout(r, 800))
          const sectionItems = Array.from(document.querySelectorAll('[role="option"], [role="listitem"], [role="menuitem"], li'))
            .filter((e) => !e.closest('[aria-hidden="true"]'))
            .map((e) => `txt="${(e.textContent?.trim() || '').slice(0, 30)}" role="${e.getAttribute('role')}" tag="${e.tagName}"`)
          console.log(`[FieldAgent] click: after '>' — section candidates: [${sectionItems.slice(0, 15).join(', ')}]`)
        }
      } else if (ins.action === 'attach_file') {
        const el = window.FieldAgentUtils.resolveElement(ins)
        if (el) await applyFileAttach(el, ins, taskId).catch(console.warn)
      } else {
        applyInstruction(ins)
      }
    }
    } finally {
      chrome.runtime.sendMessage({ type: 'CDP_DETACH' })
      applyingInstructions = false
    }
  }

  // ─── Inspect + fill cycle ───────────────────────────────────────────────────
  // Calls /inspect directly to avoid MV3 service worker lifetime limits.

  async function requestInspect() {
    if (inspectInProgress) return
    inspectInProgress = true
    try {
      // Read active task directly from local storage — avoids service worker
      // cold-start race that causes GET_ACTIVE_TASK to lose the message channel
      const { activeTask: task } = await new Promise((resolve) =>
        chrome.storage.local.get('activeTask', resolve)
      )
      if (!task) return

      // URL-lock: only inspect the page where the task originally started.
      // This prevents the agent from running fill instructions on pin detail
      // pages, other forms, etc. after SPA navigation.
      // allowPostNavInspect lifts the lock once after the Publish button is clicked.
      const currentUrl = window.location.href
      if (!taskStartUrl) {
        taskStartUrl = currentUrl
      } else if (currentUrl !== taskStartUrl) {
        if (!allowPostNavInspect) return
        allowPostNavInspect = false
        // This is the one post-publish inspect — let it through unchanged.
      }

      const snapshot = extractSnapshot(platform)

      // If the upload-completion watcher just fired, tell the LLM explicitly so
      // it doesn't re-issue paste_file. Consumed once per upload.
      if (uploadJustCompleted) {
        snapshot.upload_just_completed = true
        uploadJustCompleted = false
      }

      // Route the /inspect call through the service worker via a persistent port
      // connection. Content scripts on HTTPS pages can't fetch HTTP (mixed
      // content), but the service worker (chrome-extension:// origin) can.
      // An open port keeps the service worker alive during the ~5-10s inference.
      const result = await new Promise((resolve, reject) => {
        let settled = false
        const port = chrome.runtime.connect({ name: 'inspect' })

        port.onMessage.addListener((msg) => {
          settled = true
          port.disconnect()
          if (msg.error) reject(new Error(msg.error))
          else resolve(msg)
        })

        port.onDisconnect.addListener(() => {
          if (!settled) reject(new Error('Service worker disconnected before responding'))
        })

        port.postMessage({ type: 'INSPECT', taskId: task.task_id, snapshot })
      })

      if (result.status === 'complete') {
        // Agent detected a success/confirmation page — mark the task done
        chrome.runtime.sendMessage({
          type: 'TASK_COMPLETE',
          resultUrl: window.location.href,
        }).catch(() => {})
        return
      }

      // Notify side panel so it can display the instructions; also persist so
      // the panel can restore history when reopened mid-task.
      chrome.runtime.sendMessage({ type: 'INSTRUCTIONS_UPDATE', payload: result }).catch(() => {})
      chrome.storage.local.set({ lastInspectResult: { taskId: task.task_id, payload: result } }).catch(() => {})

      // Apply instructions to the page
      if (result?.instructions?.length) {
        await applyInstructions(result.instructions, task.task_id)
        // No automatic re-inspect here — re-inspection only happens from:
        //  • user input events (user typed/clicked something on the page)
        //  • upload completion (watchForFormChange / UPLOAD_DONE)
        //  • Publish button click (allowPostNavInspect flow)
        //  • user clicking Re-inspect in the panel
        // Automatic cycling risks filling the wrong draft in Pinterest's sidebar.
      }
    } finally {
      inspectInProgress = false
    }
  }

  function scheduleInspect(delayMs = 800) {
    clearTimeout(inspectDebounceTimer)
    inspectDebounceTimer = setTimeout(() => {
      if (window.location.href !== lastSnapshotUrl) {
        lastSnapshotUrl = window.location.href
        requestInspect()
      }
    }, delayMs)
  }

  // ─── Only inspect when explicitly triggered ─────────────────────────────────
  // Auto-inspect on page load only fires once. After that, only respond to
  // explicit INSPECT_NOW from the side panel. No MutationObserver polling —
  // the user clicked Re-inspect if they want another pass.

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECT_NOW') {
      lastSnapshotUrl = null // force re-inspect even if URL hasn't changed
      scheduleInspect(300)
    }
    if (message.type === 'APPLY_INSTRUCTIONS' && message.payload?.instructions?.length) {
      applyInstructions(message.payload.instructions, message.payload.task_id)
    }
    // CDP file-chooser intercept completed — the upload finished. This is more
    // reliable than DOM diffing because it fires from the SW's debugger event
    // regardless of where Pinterest puts the preview image in the DOM.
    if (message.type === 'UPLOAD_DONE') {
      uploadJustCompleted = true
      lastSnapshotUrl = null
      scheduleInspect(600)
    }
  })

  // Single auto-inspect on page load (handles initial task acquisition)
  scheduleInspect(1000)

  console.log(`[FieldAgent] Content script active on ${platform}`)
})()
