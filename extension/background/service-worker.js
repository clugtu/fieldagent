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

async function pollForTask() {
  const existing = await getActiveTask()
  if (existing) return // already have one

  const task = await fetchPendingTask()
  if (!task) return

  await setActiveTask(task)
  console.log('[FieldAgent] Task acquired:', task.task_id, task.payload.platform)

  chrome.runtime.sendMessage({ type: 'TASK_ACQUIRED', task }).catch(() => {})

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
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
      chrome.runtime.sendMessage({ type: 'INSTRUCTIONS_UPDATE', payload: result }).catch(() => {})
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
