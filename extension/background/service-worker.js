/**
 * FieldAgent Service Worker
 *
 * Responsibilities:
 * - Manage connection to the FieldAgent service (URL + API key from storage)
 * - Poll for pending tasks on a short interval when on a target platform
 * - Relay DOM snapshots from content scripts to the service
 * - Push fill instructions back to the active content script
 * - Open side panel when a task becomes active
 */

const POLL_ALARM = 'fieldagent-poll'
const POLL_INTERVAL_MINUTES = 0.25 // 15 seconds

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getConfig() {
  const { serviceUrl, apiKey } = await chrome.storage.sync.get(['serviceUrl', 'apiKey'])
  return { serviceUrl: serviceUrl || '', apiKey: apiKey || '' }
}

async function getActiveTask() {
  const { activeTask } = await chrome.storage.local.get('activeTask')
  return activeTask || null
}

async function setActiveTask(task) {
  await chrome.storage.local.set({ activeTask: task })
}

async function clearActiveTask() {
  await chrome.storage.local.remove('activeTask')
}

// ─── CDP file-chooser interception ───────────────────────────────────────────
// Registered at top-level so Chrome can wake the SW to deliver the event even
// if the SW was terminated between setting up the intercept and the user click.
// State is persisted in chrome.storage.local so it survives SW restarts.

async function _detachDebugger(tabId) {
  return new Promise((resolve) =>
    chrome.debugger.detach({ tabId }, () => { chrome.runtime.lastError; resolve() })
  )
}

chrome.debugger.onEvent.addListener(async (source, method) => {
  if (method !== 'Page.fileChooserOpened') return
  const { pendingFileChooser } = await chrome.storage.local.get('pendingFileChooser')
  if (!pendingFileChooser || source.tabId !== pendingFileChooser.tabId) return

  await chrome.storage.local.remove('pendingFileChooser')

  await new Promise((resolve) =>
    chrome.debugger.sendCommand(
      { tabId: pendingFileChooser.tabId },
      'Page.handleFileChooser',
      { action: 'accept', files: [pendingFileChooser.absolutePath] },
      resolve
    )
  )
  await _detachDebugger(pendingFileChooser.tabId)
  chrome.runtime.sendMessage({ type: 'UPLOAD_DONE' }).catch(() => {})
  // MutationObserver in content.js will detect the new image and re-inspect
})

// ─── Service API calls ────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const { serviceUrl, apiKey } = await getConfig()
  if (!serviceUrl || !apiKey) return null

  let res
  try {
    res = await fetch(`${serviceUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(options.headers || {}),
      },
    })
  } catch (err) {
    console.warn('[FieldAgent] Fetch failed for', path, '—', err.message, '(serviceUrl:', serviceUrl + ')')
    return null
  }
  if (!res.ok) {
    console.warn('[FieldAgent] API error', res.status, path)
    return { _error: true, status: res.status }
  }
  return res.json()
}

async function fetchPendingTask() {
  const r = await apiFetch('/tasks/pending')
  return r?._error ? null : r
}

async function completeTask(taskId, resultUrl) {
  return apiFetch(`/tasks/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ result_url: resultUrl }),
  })
}

async function fetchAssetAsBase64(taskId, assetId) {
  const { serviceUrl, apiKey } = await getConfig()
  const res = await fetch(`${serviceUrl}/assets/${taskId}/${assetId}`, {
    headers: { 'X-API-Key': apiKey },
  })
  if (!res.ok) throw new Error(`Asset fetch failed: ${res.status}`)
  const mimeType = res.headers.get('content-type') || 'application/octet-stream'
  const disposition = res.headers.get('content-disposition') || ''
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
  const filename = filenameMatch ? filenameMatch[1] : assetId
  const buffer = await res.arrayBuffer()
  // Convert to base64 for transfer to content script
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return { base64: btoa(binary), mimeType, filename }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

const PLATFORM_HOSTS = { pinterest: 'pinterest.com', reddit: 'reddit.com', cults3d: 'cults3d.com' }

// Persistent CDP debugger session — attached once before the board picker opens,
// kept alive through all pick/click actions, detached when instructions complete.
// This avoids the attach-causes-blur problem that closes the autocomplete dropdown.
let cdpSession = null  // { tid: { tabId } } when active

async function pollForTask() {
  const existing = await getActiveTask()
  if (existing) return // already have one

  const task = await fetchPendingTask()
  if (!task) return

  // Prefer a tab already on the target platform so activeTaskTabId is the
  // real Pinterest/Reddit tab, not whatever MiniForge tab triggered the task.
  const host = PLATFORM_HOSTS[task.payload?.platform]
  const PLATFORM_START_URLS = {
    pinterest: 'https://www.pinterest.com/pin-builder/',
    // add others here if needed
  }
  let tab = null
  if (host) {
    const [platformTab] = await chrome.tabs.query({ url: `*://*.${host}/*` })
    tab = platformTab
  }
  if (!tab) {
    // No platform tab is open. Open one now in a regular Chrome tab — NOT via
    // any PWA shortcut — so chrome.debugger can reach it for trusted CDP events.
    const startUrl = PLATFORM_START_URLS[task.payload?.platform]
    if (startUrl) {
      console.log('[FieldAgent] No', host, 'tab found — opening', startUrl)
      tab = await chrome.tabs.create({ url: startUrl, active: true })
      // Give the page a moment to load before the content script tries to act.
      await new Promise(r => setTimeout(r, 2500))
    } else {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      tab = activeTab
    }
  }

  await setActiveTask(task)
  console.log('[FieldAgent] Task acquired:', task.task_id, task.payload.platform, 'sending to tab:', tab?.id)

  chrome.runtime.sendMessage({ type: 'TASK_ACQUIRED', task }).catch(() => {})

  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'INSPECT_NOW', taskId: task.task_id }).catch(() => {})
  }
}

// ─── Alarm setup ──────────────────────────────────────────────────────────────
// Ensure the alarm exists on install AND on every service worker startup —
// MV3 service workers are terminated when idle and restarted on demand, so
// onInstalled alone (which fires only once) isn't enough.

async function ensureAlarm() {
  const existing = await chrome.alarms.get(POLL_ALARM)
  if (!existing) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES })
  }
}

chrome.runtime.onInstalled.addListener(ensureAlarm)
chrome.runtime.onStartup.addListener(ensureAlarm)
ensureAlarm() // also runs when the service worker restarts mid-session

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollForTask()
})

// ─── Messages from content scripts and side panel ────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ;(async () => {
    try {
      const task = await getActiveTask()

      switch (message.type) {
        case 'TASK_COMPLETE': {
          if (!task) { sendResponse({ type: 'OK' }); return }
          await completeTask(task.task_id, message.resultUrl)
          await clearActiveTask()
          chrome.runtime.sendMessage({ type: 'TASK_DONE', taskId: task.task_id }).catch(() => {})
          sendResponse({ type: 'OK' })
          break
        }

        case 'GET_ACTIVE_TASK': {
          sendResponse({ type: 'ACTIVE_TASK', task })
          break
        }

        case 'FETCH_ASSET': {
          const asset = await fetchAssetAsBase64(message.taskId, message.assetId)
          sendResponse(asset)
          break
        }

        case 'SETUP_FILE_UPLOAD': {
          // Download image to disk, then use CDP Page.setInterceptFileChooserDialog
          // so the user's single click on the upload area supplies our file automatically.
          // The top-level chrome.debugger.onEvent handler (above) handles the event
          // reliably even if the SW is restarted between setup and the user's click.
          if (!task) { sendResponse({ error: 'No active task' }); return }
          const tabId = sender.tab?.id
          console.log('[FieldAgent] SETUP_FILE_UPLOAD received — sender tabId:', tabId, 'url:', sender.tab?.url)
          if (!tabId) { sendResponse({ error: 'Cannot identify tab' }); return }

          sendResponse({ ok: true }) // respond immediately; rest is async

          // ── Resolve the tab that will receive the CDP debugger ────────────────
          // sender.tab.id can point to a chrome-extension:// page (e.g. if the
          // panel or another context sent the message, or if the tab navigated).
          // CDP cannot attach to extension pages; find the real Pinterest tab.
          const _resolveTarget = async () => {
            try {
              const info = await chrome.tabs.get(tabId)
              console.log('[FieldAgent] sender tab URL:', info.url)
              if (info.url?.startsWith('https://')) return tabId
            } catch { /* tab gone */ }
            // Fallback: find any open Pinterest pin-creation tab
            const [pinTab] = await chrome.tabs.query({ url: 'https://www.pinterest.com/*' })
            if (pinTab?.id) {
              console.warn('[FieldAgent] sender tab unusable; falling back to Pinterest tab', pinTab.id, pinTab.url)
              return pinTab.id
            }
            return null
          }

          let targetTabId = await _resolveTarget()
          if (!targetTabId) {
            console.error('[FieldAgent] No usable tab for CDP attach')
            chrome.runtime.sendMessage({ type: 'UPLOAD_NEEDED', filename: 'image' }).catch(() => {})
            return
          }

          // ── Step 1: fetch asset with auth, create data URL for download ────
          // Using a data URL (not the service URL directly) bypasses the browser's
          // "Ask where to save" setting — data URLs always save silently.
          let absolutePath, assetFilename, shortName
          try {
            const asset = await fetchAssetAsBase64(task.task_id, message.assetId)
            assetFilename = asset.filename || message.assetId.split('/').pop() || 'upload.jpg'
            const dataUrl = `data:${asset.mimeType};base64,${asset.base64}`

            const downloadId = await new Promise((resolve, reject) => {
              chrome.downloads.download(
                { url: dataUrl, filename: assetFilename, conflictAction: 'uniquify', saveAs: false },
                (id) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id)
              )
            })
            absolutePath = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Download timed out')), 30_000)
              const onChanged = (delta) => {
                if (delta.id !== downloadId) return
                if (delta.state?.current === 'complete') {
                  clearTimeout(timer)
                  chrome.downloads.onChanged.removeListener(onChanged)
                  chrome.downloads.search({ id: downloadId }, ([item]) => resolve(item?.filename || null))
                } else if (delta.state?.current === 'interrupted') {
                  clearTimeout(timer)
                  chrome.downloads.onChanged.removeListener(onChanged)
                  reject(new Error('Download interrupted'))
                }
              }
              chrome.downloads.onChanged.addListener(onChanged)
            })
          } catch (err) {
            console.error('[FieldAgent] File download failed:', err)
            chrome.runtime.sendMessage({ type: 'UPLOAD_NEEDED', filename: assetFilename || 'image', error: err.message }).catch(() => {})
            return
          }

          if (!absolutePath) {
            chrome.runtime.sendMessage({ type: 'UPLOAD_NEEDED', filename: assetFilename }).catch(() => {})
            return
          }
          shortName = absolutePath.split(/[/\\]/).pop()

          // ── Step 2: attach debugger + enable file chooser intercept ────────
          // Re-resolve target in case the tab navigated during the download.
          targetTabId = await _resolveTarget() ?? targetTabId
          try {
            const preAttach = await chrome.tabs.get(targetTabId).catch(() => null)
            console.log('[FieldAgent] Attaching CDP to tab', targetTabId, 'url:', preAttach?.url)
            await new Promise((resolve, reject) =>
              chrome.debugger.attach({ tabId: targetTabId }, '1.3', () =>
                chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
              )
            )
            await new Promise((resolve) =>
              chrome.debugger.sendCommand({ tabId: targetTabId }, 'Page.setInterceptFileChooserDialog', { enabled: true }, resolve)
            )
          } catch (err) {
            console.error('[FieldAgent] Debugger attach failed:', err)
            chrome.runtime.sendMessage({ type: 'UPLOAD_NEEDED', filename: assetFilename }).catch(() => {})
            return
          }

          // ── Step 3: persist intercept state so top-level handler can use it
          await chrome.storage.local.set({ pendingFileChooser: { tabId: targetTabId, absolutePath } })

          // ── Step 4: tell panel to prompt user ─────────────────────────────
          chrome.runtime.sendMessage({ type: 'UPLOAD_READY', filename: shortName }).catch(() => {})

          // Safety: detach after 90 s if user never clicks
          setTimeout(async () => {
            const { pendingFileChooser } = await chrome.storage.local.get('pendingFileChooser')
            if (pendingFileChooser?.tabId === targetTabId) {
              await chrome.storage.local.remove('pendingFileChooser')
              await _detachDebugger(targetTabId)
              chrome.runtime.sendMessage({ type: 'UPLOAD_NEEDED', filename: shortName }).catch(() => {})
            }
          }, 90_000)

          return // channel already closed via sendResponse above
        }

        case 'ANSWER_QUESTION': {
          if (!task) { sendResponse({ error: 'No active task' }); return }
          const result = await apiFetch(`/inspect/respond/${task.task_id}`, {
            method: 'POST',
            body: JSON.stringify({ answer: message.answer }),
          })
          if (!result || result._error) {
            sendResponse({ error: 'Failed to submit answer' })
          } else {
            chrome.runtime.sendMessage({ type: 'INSTRUCTIONS_UPDATE', payload: result }).catch(() => {})
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
            if (tabs[0] && result.instructions?.length) {
              chrome.tabs.sendMessage(tabs[0].id, { type: 'APPLY_INSTRUCTIONS', payload: result }).catch(() => {})
            }
            sendResponse({ payload: result })
          }
          break
        }

        case 'CLEAR_TASK': {
          await clearActiveTask()
          sendResponse({ type: 'OK' })
          pollForTask() // pick up a pending task immediately instead of waiting for the alarm
          break
        }

        case 'CDP_ATTACH': {
          // Pre-attach the debugger before the board picker is opened so that
          // subsequent CDP_CLICK calls can fire without re-attaching (attach causes
          // the autocomplete to dismiss by blurring the focused input).
          if (!task) { sendResponse({ error: 'No active task' }); break }

          // Primary: use sender.tab.id — for content-script senders this is the
          // exact tab the content script is running in (always has an https:// URL).
          // Guard: verify the tab actually has an https:// URL before trusting it,
          // because in rare cases (race with navigation, or side-panel association)
          // sender.tab may reflect a non-debuggable tab.
          let targetTabId = sender.tab?.id
          if (targetTabId) {
            let senderTabUrl = null
            try {
              const t = await new Promise((res, rej) =>
                chrome.tabs.get(targetTabId, t =>
                  chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(t)
                )
              )
              senderTabUrl = t?.url
            } catch (_) {}
            console.log('[FieldAgent SW] CDP_ATTACH: sender.tab.id=', targetTabId, 'url=', senderTabUrl)
            if (!senderTabUrl?.startsWith('https://')) {
              console.warn('[FieldAgent SW] CDP_ATTACH: sender tab is not https — falling back to pageUrl search')
              targetTabId = null
            }
          }

          if (!targetTabId) {
            // Fallback: exact pageUrl match (content script sends window.location.href).
            // When only one Pinterest tab exists this is always correct.
            // With multiple tabs at the same URL we pick the newest (highest tabId)
            // since that's the auto-opened tab the user is looking at.
            const pageUrl = message.pageUrl || ''
            const senderUrl = sender.url || ''
            const senderHost = senderUrl.replace(/^https?:\/\//, '').split('/')[0] || ''
            const platformHost = PLATFORM_HOSTS[task.payload?.platform] || ''
            const allTabs = await new Promise(r => chrome.tabs.query({}, r))
            const webTabs = allTabs.filter(t => (t.url || '').startsWith('https://'))
            // Sort descending by ID so the newest tab wins when multiple match
            webTabs.sort((a, b) => b.id - a.id)
            const platformTab =
              (pageUrl      && webTabs.find(t => t.url === pageUrl)) ||
              (senderHost   && webTabs.find(t => (t.url || '').includes(senderHost))) ||
              (platformHost && webTabs.find(t => (t.url || '').includes(platformHost)))
            targetTabId = platformTab?.id
            console.log('[FieldAgent SW] CDP_ATTACH: URL-search pageUrl=', pageUrl, '→ tabId=', targetTabId)
          }

          if (!targetTabId) { sendResponse({ error: 'CDP_ATTACH: no tab found' }); break }

          // Persist the verified Pinterest tab ID so the sidepanel can resolve it
          // for chrome.automation.getTree() without needing its own tab query.
          chrome.storage.local.set({ taskTabId: targetTabId }).catch(() => {})

          // If an existing session targets a different tab, detach it first.
          if (cdpSession && cdpSession.tid.tabId === targetTabId) {
            sendResponse({ ok: true, reused: true })
            break
          }
          if (cdpSession) {
            await new Promise(r => chrome.debugger.detach(cdpSession.tid, () => { void chrome.runtime.lastError; r() }))
            cdpSession = null
          }

          // Enumerate all our current debug sessions via getTargets().
          // Chrome keeps sessions alive across SW restarts (cdpSession is lost on restart
          // but Chrome still holds the underlying connection).  A stale session on any
          // chrome-extension:// target causes ALL subsequent attach attempts to fail with
          // "Cannot access a chrome-extension:// URL of different extension", so we must
          // sweep and detach everything we hold before opening a new session.
          const allTargets = await new Promise(r => chrome.debugger.getTargets(r))
          const pageTarget = allTargets.find(t => t.tabId === targetTabId && t.type === 'page')
          const ourAttached = allTargets.filter(t => t.attached)
          if (ourAttached.length > 0) {
            console.log('[FieldAgent SW] CDP_ATTACH: detaching', ourAttached.length,
              'stale session(s):', ourAttached.map(t => t.url?.slice(0, 80)))
            for (const target of ourAttached) {
              // Skip if this is already the Pinterest page — we'll reuse it below.
              if (target.id === pageTarget?.id) continue
              await new Promise(r => chrome.debugger.detach(
                { targetId: target.id },
                () => { void chrome.runtime.lastError; r() }
              ))
            }
            cdpSession = null
          }

          // If we're already attached to the Pinterest page (e.g. leftover SETUP_FILE_UPLOAD
          // session after the fallback timer fired without detaching), reuse it.
          if (pageTarget?.attached) {
            cdpSession = { tid: { tabId: targetTabId } }
            console.log('[FieldAgent SW] CDP_ATTACH: reusing existing session on tab', targetTabId)
            sendResponse({ ok: true, reused: true })
            break
          }

          // Attach to the Pinterest tab.
          const tidA = { tabId: targetTabId }
          await new Promise(r => chrome.debugger.detach(tidA, () => { void chrome.runtime.lastError; r() }))
          const attachErr = await new Promise(resolve =>
            chrome.debugger.attach(tidA, '1.3', () =>
              resolve(chrome.runtime.lastError?.message ?? null)
            )
          )
          if (attachErr) {
            console.error('[FieldAgent SW] CDP_ATTACH error:', attachErr)
            sendResponse({ error: attachErr })
            break
          }
          cdpSession = { tid: tidA }
          console.log('[FieldAgent SW] CDP_ATTACH: attached tabId=', targetTabId)
          sendResponse({ ok: true })
          break
        }

        case 'CDP_KEYS': {
          // Fire a sequence of trusted keyboard events (ArrowDown, Enter, etc.) via CDP.
          // Used instead of mouse-click for board-picker listitems — mousePressed causes
          // the search input to blur (closing the autocomplete) before click fires.
          // Keyboard events go to the focused element, which is the board search input
          // after typing, so ArrowDown highlights the first autocomplete item and Enter
          // selects it without touching focus.
          if (!cdpSession) { sendResponse({ error: 'CDP_KEYS: no session' }); break }
          const KEY_INFO = {
            ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
            Enter:     { keyCode: 13, code: 'Enter',     key: 'Enter', unmodifiedText: '\r', text: '\r' },
            Escape:    { keyCode: 27, code: 'Escape',    key: 'Escape' },
            Tab:       { keyCode:  9, code: 'Tab',       key: 'Tab' },
          }
          const sendKey = (type, info) => new Promise(r =>
            chrome.debugger.sendCommand(cdpSession.tid, 'Input.dispatchKeyEvent',
              { type, modifiers: 0, timestamp: Date.now() / 1000, ...info }, r)
          )
          try {
            for (const k of (message.keys || [])) {
              const info = KEY_INFO[k]
              if (!info) continue
              await sendKey('rawKeyDown', info)
              if (info.text) await sendKey('char', info)
              await sendKey('keyUp', info)
              // Small pause after ArrowDown so the autocomplete highlights the item
              // before the next key fires.
              if (k === 'ArrowDown') await new Promise(r => setTimeout(r, 80))
            }
            sendResponse({ ok: true })
          } catch (err) {
            console.error('[FieldAgent SW] CDP_KEYS error:', err.message)
            sendResponse({ error: err.message })
          }
          break
        }

        case 'PICK_BOARD': {
          // Runs in MAIN world so React fibers are natively accessible and we
          // can create a Proxy where isTrusted=true in the same JS realm as the
          // handler — no cross-world identity issues.
          const tabId = sender.tab?.id
          if (!tabId) { sendResponse({ ok: false, error: 'no tab id' }); break }
          async function pickBoardMain(boardName, sectionName) {
            // Build a plain synthetic-event object with isTrusted:true.
            // This is the same approach used by content.js's reactFiberClick —
            // passing a plain object is accepted by Pinterest's React handlers
            // whereas a Proxy-wrapped MouseEvent (isTrusted still false on the
            // underlying native event) is rejected by the picker's security check.
            function fiberEvent(evType, el, ct, cx, cy) {
              return {
                type: evType, isTrusted: true, bubbles: true, cancelable: true,
                target: el, currentTarget: ct || el,
                button: 0, buttons: 1, which: 1,
                clientX: cx, clientY: cy, pageX: cx, pageY: cy,
                screenX: cx, screenY: cy, detail: 1,
                shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
                preventDefault: function() {}, stopPropagation: function() {},
                stopImmediatePropagation: function() {},
                isPropagationStopped: function() { return false },
                isDefaultPrevented: function() { return false },
                persist: function() {},
                nativeEvent: {
                  type: evType, isTrusted: true, target: el, button: 0,
                  clientX: cx, clientY: cy,
                  preventDefault: function() {}, stopPropagation: function() {},
                },
              }
            }
            // Walk an element's React fiber chain.
            // fiberClick: call the FIRST handler found (stop at first hit).
            // fiberClickAll: call ALL handlers in chain (simulates React event bubbling).
            function fiberClick(el, nodeErrors) {
              var fk = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') })
              if (!fk) return null
              var r = el.getBoundingClientRect()
              var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
              var idx = 0
              for (var f = el[fk]; f; f = f.return) {
                var p = f.memoizedProps
                if (!p) { idx++; continue }
                var h = p.onClick || p.onMouseDown || p.onPointerDown
                if (!h) { idx++; continue }
                var evType = p.onClick ? 'click' : p.onMouseDown ? 'mousedown' : 'pointerdown'
                var ct = (f.stateNode instanceof Element) ? f.stateNode : el
                try {
                  h(fiberEvent(evType, el, ct, cx, cy))
                  return 'fiber:' + evType + ':' + idx
                } catch (e) { if (nodeErrors) nodeErrors.push(idx + ':' + e.message.slice(0, 60)) }
                idx++
              }
              return null
            }
            function fiberClickAll(el, nodeErrors) {
              var fk = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') })
              if (!fk) return null
              var r = el.getBoundingClientRect()
              var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2)
              var hits = [], idx = 0
              // Diagnostic: log available handlers before calling
              var available = []
              for (var f0 = el[fk]; f0; f0 = f0.return) {
                var p0 = f0.memoizedProps
                if (!p0) { idx++; continue }
                var hs = []
                if (p0.onClick) hs.push('onClick')
                if (p0.onMouseDown) hs.push('onMouseDown')
                if (p0.onPointerDown) hs.push('onPointerDown')
                if (hs.length) available.push(idx + ':' + hs.join(','))
                idx++
              }
              console.log('[FieldAgent] board fiber handlers:', JSON.stringify(available))
              idx = 0
              for (var f = el[fk]; f; f = f.return) {
                var p = f.memoizedProps
                if (!p) { idx++; continue }
                var h = p.onMouseDown || p.onPointerDown || p.onClick
                if (!h) { idx++; continue }
                var evType = p.onMouseDown ? 'mousedown' : p.onPointerDown ? 'pointerdown' : 'click'
                var ct = (f.stateNode instanceof Element) ? f.stateNode : el
                try {
                  h(fiberEvent(evType, el, ct, cx, cy))
                  hits.push('fiber:' + evType + ':' + idx)
                } catch (e) { if (nodeErrors) nodeErrors.push(idx + ':' + e.message.slice(0, 60)) }
                idx++
              }
              return hits.length > 0 ? hits.join(',') : null
            }

            // Pinterest often wraps the actual clickable target in a decorative
            // outer container — walking UP the fiber tree (as fiberClick/
            // fiberClickAll do) only finds ANCESTOR handlers, which may belong
            // to something unrelated (e.g. a popover-dismiss handler) rather
            // than the real selection handler on a nested descendant. Search
            // descendants in DOM order for the first element with its own
            // click/mousedown/pointerdown fiber handler.
            function findInnerInteractive(el) {
              var descendants = el.querySelectorAll('*')
              for (var i = 0; i < descendants.length; i++) {
                var c = descendants[i]
                var fk = Object.keys(c).find(function(k) {
                  return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
                })
                if (!fk) continue
                var p = c[fk] && c[fk].memoizedProps
                if (p && (p.onClick || p.onMouseDown || p.onPointerDown)) return c
              }
              return null
            }

            // Poll for the section listitem up to maxMs ms, then click it.
            // Called after a board click opens the section view so everything
            // stays in one atomic executeScript call (the section picker
            // dismisses if more than ~1 s elapses between board click and
            // section click).
            async function clickSection(sectionName, maxMs) {
              var snorm = sectionName.trim().toLowerCase()
              var deadline = Date.now() + maxMs
              var firstPoll = true
              while (Date.now() < deadline) {
                // Use getBoundingClientRect for visibility — offsetParent is null
                // for position:fixed elements (common in Pinterest's modal overlays).
                function isVis(el) {
                  if (el.closest('[aria-hidden="true"]')) return false
                  var r = el.getBoundingClientRect()
                  return r.width > 0 && r.height > 0
                }
                // Pass 1: preferred roles (fast)
                var sItems = Array.from(document.querySelectorAll(
                  '[role="listitem"], [role="option"], [role="menuitem"], [role="row"], li, button'
                ))
                var sTarget = sItems.find(function (el) {
                  if (!isVis(el)) return false
                  var txt = el.textContent.trim().toLowerCase()
                  return txt.includes(snorm)
                })
                // Pass 2: any visible element — section picker items may be plain divs.
                // Limit text length to exclude long page content (like pin descriptions)
                // that coincidentally contain the section name as a substring.
                if (!sTarget) {
                  var candidates = Array.from(document.querySelectorAll('*'))
                    .filter(function(el) {
                      if (!isVis(el)) return false
                      var txt = el.textContent.trim().toLowerCase()
                      // Must include the section name AND be short enough to not be
                      // a description paragraph — section names are typically <50 chars.
                      if (!txt.includes(snorm) || txt.length > 50) return false
                      var r = el.getBoundingClientRect()
                      return r.height >= 16 && r.height <= 200 && r.width >= 40
                    })
                    .sort(function(a, b) {
                      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
                      return (ra.width * ra.height) - (rb.width * rb.height)
                    })
                  sTarget = candidates[0] || null
                }
                if (firstPoll) {
                  firstPoll = false
                  console.log('[FieldAgent] clickSection first poll: sTarget=', sTarget ? (sTarget.tagName + '[' + (sTarget.getAttribute('role')||'') + '] "' + sTarget.textContent.trim().slice(0,30) + '"') : 'null')
                  var allVis = Array.from(document.querySelectorAll('[role="listitem"], [role="option"], button, li'))
                    .filter(isVis)
                    .map(function(el) { return (el.getAttribute('role')||el.tagName) + ' "' + el.textContent.trim().slice(0,40) + '"' })
                  console.log('[FieldAgent] clickSection role-items:', JSON.stringify(allVis))
                }
                if (sTarget) {
                  var sMethod = fiberClick(sTarget, [])
                  if (!sMethod) {
                    // Fiber not found — fall back to native .click()
                    sTarget.click()
                    sMethod = 'native-click'
                  }
                  return { ok: true, text: sTarget.textContent.trim().slice(0, 30), method: sMethod }
                }
                await new Promise(function (r) { setTimeout(r, 80) })
              }
              return { ok: false, error: 'section not found: ' + sectionName }
            }

            // If boardName is empty, skip the board search and click the section
            // directly — used when the board is already selected and sections are
            // already visible in the picker.
            if (!boardName || !boardName.trim()) {
              if (!sectionName) return { ok: false, error: 'no boardName and no sectionName' }
              var sectionOnlyResult = await clickSection(sectionName, 4000)
              return { ok: true, method: 'section-only', section: sectionOnlyResult }
            }

            var norm = boardName.trim().toLowerCase()

            // Scope the listitem search to the board picker overlay, not the whole page.
            // "Create board" is uniquely present inside the picker; walk up ancestors
            // until we find a container that actually holds board listitems.
            var createBoardBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(el) {
              var r = el.getBoundingClientRect()
              return r.width > 0 && r.height > 0 &&
                     el.textContent.trim().toLowerCase() === 'create board'
            })
            var pickerRoot = null
            if (createBoardBtn) {
              var anc = createBoardBtn.parentElement
              while (anc && anc !== document.body) {
                if (anc.querySelectorAll('[role="listitem"], [role="option"]').length > 0) {
                  pickerRoot = anc; break
                }
                anc = anc.parentElement
              }
            }
            if (!pickerRoot) pickerRoot = document
            console.log('[FieldAgent] picker root:', pickerRoot === document
              ? 'document (fallback — no container with listitems found above Create board btn)'
              : pickerRoot.tagName + '[role=' + (pickerRoot.getAttribute('role') || 'none') + '] items=' + pickerRoot.querySelectorAll('[role="listitem"],[role="option"]').length)

            var items = Array.from(pickerRoot.querySelectorAll('[role="listitem"], [role="option"]'))
            var target = items.find(function (el) {
              return !el.closest('[aria-hidden="true"]') &&
                     el.offsetParent !== null &&
                     el.textContent.trim().toLowerCase().startsWith(norm)
            })
            if (!target) return { ok: false, error: 'listitem not found: ' + boardName, pickerRootTag: pickerRoot.tagName || 'document', itemCount: items.length }
            console.log('[FieldAgent] board target:', target.tagName + '[role=' + (target.getAttribute('role')||'none') + '] "' + target.textContent.trim().slice(0,40) + '"')

            // Fire the full pointer + mouse + click sequence so Pinterest sees the
            // same event order as a real browser interaction (pointerdown fires
            // before click; some React handlers use onPointerDown for selection).
            function firePointerClick(el) {
              var r = el.getBoundingClientRect()
              var cx = Math.round(r.left + r.width / 2)
              var cy = Math.round(r.top + r.height / 2)
              var base = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }
              ;['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(t) {
                var Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent
                el.dispatchEvent(new Ctor(t, Object.assign({ isPrimary: true }, base)))
              })
            }
            // Try the fiber-based click on a nested interactive descendant first —
            // confirmed by live testing to be the one that actually selects the
            // board; a native dispatchEvent sequence never registered as a real
            // selection for this listitem in three separate live tests, so it's
            // demoted to a fallback below instead of always being tried (and
            // waited on) first.
            var innerTarget = findInnerInteractive(target)
            console.log('[FieldAgent] board inner interactive descendant:',
              innerTarget ? (innerTarget.tagName + '[role=' + (innerTarget.getAttribute('role')||'none') + ']') : 'none found')
            var fiberHits = fiberClick(innerTarget || target, [])
            console.log('[FieldAgent] board fiberClick hit:', fiberHits)
            var boardResult = { ok: true, method: fiberHits ? ('fiber-click' + (innerTarget ? '(inner)' : '')) : 'fiber-click-no-handler' }

            if (sectionName) {
              // Give React time to re-render the section picker after the board click.
              await new Promise(function (r) { setTimeout(r, 400) })

              // Read the board button's displayed text to confirm selection.
              // The button's aria-label encodes the board name: "Board{Name}" when
              // selected, or just "Board"/"Choose a board" when nothing selected.
              var boardBtnEl = Array.from(document.querySelectorAll('[role="button"], button'))
                .find(function(el) {
                  var r = el.getBoundingClientRect()
                  if (r.width === 0 || r.height === 0) return false
                  var lbl = (el.getAttribute('aria-label') || '').trim().toLowerCase()
                  var txt = (el.textContent || '').trim().toLowerCase()
                  return (lbl.startsWith('board') || txt.startsWith('board')) &&
                         (lbl.length < 80 || txt.length < 80) &&
                         !txt.startsWith('create')
                })
              boardResult.boardBtnText = boardBtnEl ? boardBtnEl.textContent.trim().slice(0, 60) : 'not-found'
              console.log('[FieldAgent] board btn text after click:', boardResult.boardBtnText)

              var postBoardItems = Array.from(document.querySelectorAll('[role="listitem"], [role="option"], button'))
                .filter(function(el) {
                  var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]')
                })
                .map(function(el) { return (el.getAttribute('role')||el.tagName) + ' "' + el.textContent.trim().slice(0,40) + '"' })
              console.log('[FieldAgent] post-board-click visible items:', JSON.stringify(postBoardItems))

              // If the board list is still visible after the click, the click was a
              // no-op. Recover: find the form's board-selection hook (identified by
              // its {boardId, title, url} shape), dispatch null to deselect, then
              // fire the pointer sequence again as a guaranteed-fresh selection.
              //
              // NOTE: the board UUID extracted from the listitem fiber is NOT the
              // stable boardId stored in the form hook — they use different formats.
              // We match by hook SHAPE ({boardId, title, url} keys) instead.
              var stillBoardView = postBoardItems.some(function(t) {
                return t.toLowerCase().includes(norm)
              })
              if (stillBoardView) {
                // The fiber click either found no handler or didn't register as a
                // real selection — fall back to native pointer-event dispatch,
                // which hasn't worked in testing so far but may for board/DOM
                // shapes we haven't tried.
                console.log('[FieldAgent] fiber click no-op — trying native pointer sequence')
                firePointerClick(target)
                boardResult.method += '+pointer-sequence'
                await new Promise(function (r) { setTimeout(r, 400) })
                var postPointerItems = Array.from(document.querySelectorAll('[role="listitem"], [role="option"], button'))
                  .filter(function(el) {
                    var r = el.getBoundingClientRect()
                    return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]')
                  })
                  .map(function(el) { return (el.getAttribute('role')||el.tagName) + ' "' + el.textContent.trim().slice(0,40) + '"' })
                console.log('[FieldAgent] post-pointer-sequence visible items:', JSON.stringify(postPointerItems))
                stillBoardView = postPointerItems.some(function(t) { return t.toLowerCase().includes(norm) })
              }
              if (stillBoardView) {
                console.log('[FieldAgent] board click still no-op — scanning picker fiber for direct state injection')

                // Full fiber scan: collect boardStateDispatch AND allBoards without
                // breaking early. We need both to inject the target board state directly
                // (bypassing DOM events entirely, which Pinterest's security checks block).
                var pFk = Object.keys(pickerRoot).find(function(k) {
                  return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
                })
                var boardStateDispatch = null  // dispatch() for {boardId,title,url} form state
                var allBoards = null           // all_boards list from picker cache
                if (pFk) {
                  var compIdx = 0
                  for (var pf = pickerRoot[pFk]; pf; pf = pf.return) {
                    if (!pf.memoizedState) { compIdx++; continue }
                    var hookLog = []
                    var ph = pf.memoizedState, phIdx = 0
                    while (ph && phIdx < 55) {
                      var phVal = ph.memoizedState
                      var pt = typeof phVal
                      if (pt === 'string' && phVal.length > 0 && phVal.length < 60) hookLog.push(phIdx + ':s:' + phVal)
                      else if (pt === 'boolean') hookLog.push(phIdx + ':b:' + phVal)
                      else if (pt === 'number') hookLog.push(phIdx + ':n:' + phVal)
                      else if (pt === 'object' && phVal !== null) {
                        var pkeys = Object.keys(phVal)
                        hookLog.push(phIdx + ':o:{' + pkeys.slice(0, 4).join(',') + '}')
                        if ('boardId' in phVal && 'title' in phVal) {
                          console.log('[FieldAgent] comp[' + compIdx + '] hook[' + phIdx + '] board-state:', JSON.stringify(phVal).slice(0, 150))
                        }
                        // Capture all_boards once — log every entry in full so we can
                        // identify the name/url field names for direct injection.
                        if ('all_boards' in phVal && !allBoards) {
                          allBoards = phVal.all_boards || []
                          console.log('[FieldAgent] comp[' + compIdx + '] hook[' + phIdx + '] all_boards len=' + allBoards.length)
                          allBoards.forEach(function(b, bi) {
                            console.log('[FieldAgent] all_boards[' + bi + ']:', JSON.stringify(b).slice(0, 300))
                          })
                        }
                        // Capture board-state dispatch (first occurrence only).
                        if ('boardId' in phVal && 'title' in phVal && 'url' in phVal &&
                            ph.queue && ph.queue.dispatch && !boardStateDispatch) {
                          boardStateDispatch = ph.queue.dispatch
                          console.log('[FieldAgent] comp[' + compIdx + '] hook[' + phIdx + ']: board-state dispatch saved')
                        }
                      }
                      ph = ph.next; phIdx++
                    }
                    if (hookLog.length > 0) console.log('[FieldAgent] comp[' + compIdx + ']', hookLog.join(' | '))
                    compIdx++
                  }
                }

                // Strategy 1: direct state injection — find the target board in all_boards
                // and dispatch its {boardId,title,url} directly, bypassing DOM events.
                var injected = false
                if (boardStateDispatch && allBoards && allBoards.length > 0) {
                  var normSlug = norm.replace(/[^a-z0-9]/g, '')
                  var targetBoardEntry = null
                  for (var bi = 0; bi < allBoards.length; bi++) {
                    var b = allBoards[bi]
                    var bName = (b.name || b.board_name || b.title || '').toLowerCase()
                    var bUrl  = (b.url  || b.board_url  || '').toLowerCase()
                    var bSlug = bUrl.replace(/[^a-z0-9]/g, '')
                    if (bName === norm || bName.startsWith(norm) || bSlug.includes(normSlug)) {
                      targetBoardEntry = b; break
                    }
                  }
                  console.log('[FieldAgent] target board entry:', targetBoardEntry
                    ? JSON.stringify(targetBoardEntry).slice(0, 250)
                    : 'NOT FOUND — board names: ' + allBoards.map(function(b) { return b.name || b.board_name || b.title || '?' }).join(', '))
                  if (targetBoardEntry) {
                    var newBoardState = {
                      boardId: targetBoardEntry.id || targetBoardEntry.board_id,
                      title:   targetBoardEntry.name || targetBoardEntry.board_name || targetBoardEntry.title || boardName,
                      url:     targetBoardEntry.url  || targetBoardEntry.board_url  || ''
                    }
                    console.log('[FieldAgent] injecting board state:', JSON.stringify(newBoardState))
                    try {
                      boardStateDispatch(newBoardState)
                      injected = true
                      boardResult.method += '+direct-inject'
                    } catch (e) {
                      console.warn('[FieldAgent] direct inject failed:', e.message)
                    }
                  }
                }

                // Strategy 2: deselect + fresh pointer click fallback.
                if (!injected) {
                  if (boardStateDispatch) {
                    console.log('[FieldAgent] direct inject unavailable — falling back to deselect+reselect')
                    try { boardStateDispatch(null) } catch (e) {}
                    await new Promise(function(r) { setTimeout(r, 200) })
                    var freshItems = Array.from(pickerRoot.querySelectorAll('[role="listitem"], [role="option"]'))
                    var freshTarget = freshItems.find(function(el) {
                      return !el.closest('[aria-hidden="true"]') &&
                             el.offsetParent !== null &&
                             el.textContent.trim().toLowerCase().startsWith(norm)
                    }) || target
                    console.log('[FieldAgent] fresh pointer-click on:', freshTarget.textContent.trim().slice(0, 40))
                    firePointerClick(freshTarget)
                    boardResult.method += '+deselect+reselect'
                  } else {
                    console.log('[FieldAgent] no board state dispatch found — cannot recover')
                  }
                }

                // Brief settle: let React re-render after inject or reselect.
                await new Promise(function(r) { setTimeout(r, 500) })
                var postRecover = Array.from(document.querySelectorAll('[role="listitem"], [role="option"], button'))
                  .filter(function(el) {
                    var r = el.getBoundingClientRect()
                    return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]')
                  })
                  .map(function(el) { return (el.getAttribute('role')||el.tagName) + ' "' + el.textContent.trim().slice(0,40) + '"' })
                console.log('[FieldAgent] post-recover visible items:', JSON.stringify(postRecover))
              }

              var sectionResult = await clickSection(sectionName, 4000)
              boardResult.section = sectionResult
            }

            return boardResult
          }
          chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pickBoardMain, args: [message.boardName, message.sectionName || null] })
            .then(results => sendResponse({ ok: true, result: results?.[0]?.result }))
            .catch(err => { console.warn('[FieldAgent SW] PICK_BOARD error:', err.message); sendResponse({ ok: false, error: err.message }) })
          return true
        }

        case 'INJECT_MAIN_PATCH': {
          // Inject the isTrusted-bypass patch into the page's MAIN world via the
          // scripting API, which bypasses Pinterest's Content Security Policy.
          // Called at the start of applyInstructions so the patch is in place
          // before the board picker opens and Pinterest registers its mousedown listener.
          // world:MAIN document_start content script handles page-load registrations;
          // this covers any handlers registered dynamically (e.g. when picker opens).
          const tabId = sender.tab?.id
          if (!tabId) { sendResponse({ ok: false, error: 'no tab id' }); break }
          function pinterestPatch() {
            if (window.__faEventPatchInstalled) return
            window.__faEventPatchInstalled = true
            var _origAEL = EventTarget.prototype.addEventListener
            EventTarget.prototype.addEventListener = function (type, handler, options) {
              if ((type === 'mousedown' || type === 'pointerdown' || type === 'keydown') &&
                  typeof handler === 'function') {
                var wrapped = function (event) {
                  if (event.isTrusted) return handler.call(this, event)
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
                return _origAEL.call(this, type, wrapped, options)
              }
              return _origAEL.call(this, type, handler, options)
            }
            console.log('[FieldAgent] Pinterest patch: installed via scripting.executeScript')
          }
          chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pinterestPatch })
            .then(() => sendResponse({ ok: true }))
            .catch(err => { console.warn('[FieldAgent SW] INJECT_MAIN_PATCH error:', err.message); sendResponse({ ok: false, error: err.message }) })
          return true
        }

        case 'AUTOMATION_CLICK': {
          sendResponse({ ok: false })
          break
        }

        case 'CDP_DETACH': {
          if (cdpSession) {
            try { await new Promise(r => chrome.debugger.detach(cdpSession.tid, r)) } catch {}
            console.log('[FieldAgent SW] CDP_DETACH: detached')
            cdpSession = null
          }
          sendResponse({ ok: true })
          break
        }

        case 'CDP_CLICK': {
          if (!cdpSession) { sendResponse({ error: 'CDP_CLICK: no session — send CDP_ATTACH first' }); break }
          const { x, y } = message
          const tid = cdpSession.tid

          // Diagnostic: plant a listener in the PAGE world (via Runtime.evaluate)
          // to detect whether CDP mouse events actually reach JavaScript.
          // evalSafe times out after 1 s so it can never hang the response.
          const evalSafe = (expression) => Promise.race([
            new Promise(resolve => chrome.debugger.sendCommand(
              tid, 'Runtime.evaluate', { expression, returnByValue: true },
              r => { void chrome.runtime.lastError; resolve(r) }
            )),
            new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000)),
          ])
          // Ensure the tab is in the foreground — Input.dispatchMouseEvent returns
          // "Internal error" if the tab is not the active/focused window tab.
          await new Promise(r => chrome.debugger.sendCommand(tid, 'Page.bringToFront', {}, r))

          const plantResult = await evalSafe(
            `window.__fa_cdp={f:false,t:null,tag:null};` +
            `document.addEventListener('mousedown',function __fat(e){` +
            `  window.__fa_cdp={f:true,t:e.isTrusted,tag:e.target?.tagName};` +
            `  document.removeEventListener('mousedown',__fat,{capture:true});` +
            `},{capture:true,once:true});'ok'`
          )
          console.log('[FieldAgent SW] CDP_CLICK: plant=', plantResult?.result?.value ?? plantResult?.timeout)

          const fire = (type, opts = {}) => new Promise(resolve =>
            chrome.debugger.sendCommand(tid, 'Input.dispatchMouseEvent', {
              type, x, y, modifiers: 0, timestamp: Date.now() / 1000, pointerType: 'mouse', ...opts,
            }, () => {
              if (chrome.runtime.lastError) console.warn('[FieldAgent SW] CDP_CLICK:', type, 'err:', chrome.runtime.lastError.message)
              resolve()
            })
          )
          await fire('mouseMoved')
          await fire('mousePressed', { button: 'left', clickCount: 1, buttons: 1 })
          await fire('mouseReleased', { button: 'left', clickCount: 1, buttons: 0 })

          await new Promise(r => setTimeout(r, 150))
          const checkResult = await evalSafe(`JSON.stringify(window.__fa_cdp)`)
          console.log('[FieldAgent SW] CDP_CLICK: event-test =', checkResult?.result?.value ?? checkResult?.timeout)

          sendResponse({ ok: true })
          break
        }
      }
    } catch (err) {
      console.error('[FieldAgent] Message handler error:', err)
      sendResponse({ error: err.message })
    }
  })()

  return true // keep message channel open for async response
})

// ─── Inspect port ─────────────────────────────────────────────────────────────
// Content scripts on HTTPS pages can't fetch HTTP (mixed content). They open a
// port named "inspect" instead; the open port keeps this service worker alive
// for the duration of the Claude inference call (~5-10s).

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'inspect') return

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'INSPECT') return
    try {
      // Reject inspects from tabs that are NOT on the task's platform URL.
      // This prevents a non-platform tab (e.g. a MiniForge or Google tab) from
      // racing with the actual Pinterest tab and falsely claiming "complete".
      // We use the URL rather than a tab ID because the task may be acquired
      // before the Pinterest tab exists, making ID-locking unreliable.
      const { activeTask } = await chrome.storage.local.get('activeTask')
      if (activeTask) {
        const host = PLATFORM_HOSTS[activeTask.payload?.platform]
        const senderUrl = port.sender?.tab?.url || ''
        if (host && senderUrl && !senderUrl.includes(host)) {
          port.postMessage({ error: 'wrong_tab' })
          return
        }
      }

      const result = await apiFetch('/inspect', {
        method: 'POST',
        body: JSON.stringify({ task_id: msg.taskId, snapshot: msg.snapshot }),
      })
      if (!result || result._error) {
        if (result?.status === 404 || result?.status === 409) {
          console.warn('[FieldAgent] Task rejected by service (status', result?.status, ') — clearing local task')
          await clearActiveTask()
          chrome.runtime.sendMessage({ type: 'TASK_DONE' }).catch(() => {})
          pollForTask()
        }
        port.postMessage({ error: `Service returned ${result?.status ?? 'no response'}` })
        return
      }
      port.postMessage(result)
    } catch (err) {
      port.postMessage({ error: err.message })
    }
  })
})

// ─── Side panel ───────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})
