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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
