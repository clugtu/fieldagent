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

  const res = await fetch(`${serviceUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    console.warn('[FieldAgent] API error', res.status, path)
    return null
  }
  return res.json()
}

async function fetchPendingTask() {
  return apiFetch('/tasks/pending')
}

async function postSnapshot(taskId, snapshot) {
  return apiFetch('/inspect', {
    method: 'POST',
    body: JSON.stringify({ task_id: taskId, snapshot }),
  })
}

async function completeTask(taskId, resultUrl) {
  return apiFetch(`/tasks/${taskId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ result_url: resultUrl }),
  })
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollForTask() {
  const existing = await getActiveTask()
  if (existing) return // already have one

  const task = await fetchPendingTask()
  if (!task) return

  await setActiveTask(task)
  console.log('[FieldAgent] Task acquired:', task.task_id, task.payload.platform)

  // Notify the side panel and any open content scripts
  chrome.runtime.sendMessage({ type: 'TASK_ACQUIRED', task }).catch(() => {})

  // Find the active tab — if it's on the right platform, trigger an inspect
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'INSPECT_NOW', taskId: task.task_id }).catch(() => {})
  }
}

// ─── Alarm setup ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollForTask()
})

// ─── Messages from content scripts and side panel ────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    const task = await getActiveTask()

    switch (message.type) {
      case 'SNAPSHOT_READY': {
        if (!task) { sendResponse({ type: 'NO_TASK' }); return }
        const instructions = await postSnapshot(task.task_id, message.snapshot)
        if (!instructions) { sendResponse({ type: 'NO_INSTRUCTIONS' }); return }
        sendResponse({ type: 'INSTRUCTIONS', payload: instructions })
        // Also push to side panel
        chrome.runtime.sendMessage({ type: 'INSTRUCTIONS_UPDATE', payload: instructions }).catch(() => {})
        break
      }

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

      case 'CLEAR_TASK': {
        await clearActiveTask()
        sendResponse({ type: 'OK' })
        break
      }
    }
  })()

  return true // keep message channel open for async response
})

// ─── Side panel ───────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id })
})
