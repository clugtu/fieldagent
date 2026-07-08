const statusBadge = document.getElementById('status-badge')
const notConfigured = document.getElementById('not-configured')
const noTask = document.getElementById('no-task')
const taskSection = document.getElementById('task-section')
const taskPlatform = document.getElementById('task-platform')
const taskCaption = document.getElementById('task-caption')
const taskIdEl = document.getElementById('task-id')
const questionSection = document.getElementById('question-section')
const questionText = document.getElementById('question-text')
const questionAnswer = document.getElementById('question-answer')
const btnAnswer = document.getElementById('btn-answer')
const uploadSection = document.getElementById('upload-section')
const uploadPromptReady = document.getElementById('upload-prompt-ready')
const uploadFilenameReady = document.getElementById('upload-filename-ready')
const uploadPromptDone = document.getElementById('upload-prompt-done')
const uploadPromptFallback = document.getElementById('upload-prompt-fallback')
const uploadFilenameFallback = document.getElementById('upload-filename-fallback')
const instructionsSection = document.getElementById('instructions-section')
const instructionsList = document.getElementById('instructions-list')
const agentNotes = document.getElementById('agent-notes')
const btnReinspect = document.getElementById('btn-reinspect')
const btnClear = document.getElementById('btn-clear')
const btnComplete = document.getElementById('btn-complete')

function openSettings() {
  chrome.runtime.openOptionsPage()
}

document.getElementById('btn-open-settings').addEventListener('click', openSettings)
document.getElementById('btn-settings').addEventListener('click', openSettings)

// Keep the service worker alive while the panel is open.
// An open port prevents MV3 SW termination, which matters when we're waiting
// for the user to click the upload area (CDP file chooser interception).
const _keepAlivePort = chrome.runtime.connect({ name: 'keepalive' })

// ─── Config check ─────────────────────────────────────────────────────────────

async function checkConfig() {
  const { serviceUrl, apiKey } = await chrome.storage.sync.get(['serviceUrl', 'apiKey'])
  if (!serviceUrl || !apiKey) {
    notConfigured.style.display = ''
    noTask.style.display = 'none'
    statusBadge.textContent = 'Not configured'
    statusBadge.className = 'badge none'
    btnReinspect.disabled = true
    btnClear.disabled = true
    btnComplete.disabled = true
    return false
  }
  notConfigured.style.display = 'none'
  return true
}

// ─── Task rendering ───────────────────────────────────────────────────────────

function renderTask(task) {
  if (!task) {
    noTask.style.display = ''
    taskSection.style.display = 'none'
    statusBadge.textContent = 'No task'
    statusBadge.className = 'badge none'
    btnReinspect.disabled = true
    btnClear.disabled = true
    btnComplete.disabled = true
    return
  }

  noTask.style.display = 'none'
  taskSection.style.display = ''
  taskPlatform.textContent = task.payload.platform
  taskCaption.textContent = task.payload.caption || '(no caption)'
  taskIdEl.textContent = task.task_id
  statusBadge.textContent = task.status
  statusBadge.className = `badge ${task.status}`
  btnReinspect.disabled = false
  btnClear.disabled = false
  btnComplete.disabled = false
}

function showUploadReady(filename) {
  uploadFilenameReady.textContent = filename
  uploadPromptReady.style.display = ''
  uploadPromptDone.style.display = 'none'
  uploadPromptFallback.style.display = 'none'
  uploadSection.style.display = ''
}

function showUploadDone() {
  uploadPromptReady.style.display = 'none'
  uploadPromptDone.style.display = ''
  uploadPromptFallback.style.display = 'none'
  uploadSection.style.display = ''
  // Auto-hide after the re-inspect has time to fire
  setTimeout(hideUploadPrompt, 4000)
}

function showUploadFallback(filename) {
  uploadFilenameFallback.textContent = filename
  uploadPromptReady.style.display = 'none'
  uploadPromptDone.style.display = 'none'
  uploadPromptFallback.style.display = ''
  uploadSection.style.display = ''
}

function hideUploadPrompt() {
  uploadSection.style.display = 'none'
}

// Accumulated history for the current task — cleared only when the task changes.
let _instructionHistory = []

function _insRow(ins) {
  const action = ins.action || 'type'
  const field = ins.fallback_hint || ins.selector_hint || '?'
  const val = ins.value != null
    ? (ins.value.length > 60 ? ins.value.slice(0, 60) + '…' : ins.value)
    : (ins.asset_id ? `[file: ${ins.asset_id}]` : '')
  return `<div class="instruction">
    <span class="instruction-action" title="${action}">${action}</span>
    <span class="instruction-field" title="${field}">${field}</span>
    ${val ? `<span class="instruction-value" title="${ins.value || ''}">${val}</span>` : ''}
  </div>`
}

function _rebuildHistory() {
  if (!_instructionHistory.length) { instructionsSection.style.display = 'none'; return }
  instructionsSection.style.display = ''
  // Newest entry first
  instructionsList.innerHTML = _instructionHistory.slice().reverse().map((entry, i, arr) => {
    const num = arr.length - i
    const rows = entry.instructions.map(_insRow).join('') || '<div class="instruction"><span class="instruction-field">(no instructions)</span></div>'
    const notesHtml = entry.notes ? `<div class="notes">${entry.notes}</div>` : ''
    return `<div class="history-entry">
      <div class="history-ts">#${num} · ${entry.time}${entry.status ? ' · ' + entry.status : ''}</div>
      ${rows}${notesHtml}
    </div>`
  }).join('')
}

function clearHistory() {
  _instructionHistory = []
  instructionsSection.style.display = 'none'
  instructionsList.innerHTML = ''
  agentNotes.style.display = 'none'
  chrome.storage.local.remove('lastInspectResult').catch(() => {})
}

function renderInstructions(payload) {
  questionSection.style.display = 'none'

  if (!payload) return

  if (payload.status === 'awaiting_input' && payload.question) {
    questionSection.style.display = ''
    questionText.textContent = payload.question.text
    questionAnswer.value = ''
    statusBadge.textContent = 'Waiting for answer'
    statusBadge.className = 'badge pending'
    btnAnswer.onclick = () => submitAnswer(payload.task_id, payload.question.question_id)
    return
  }

  if (payload.instructions?.length || payload.notes) {
    console.log('[FieldAgent] instructions:', JSON.stringify(payload.instructions, null, 2))
    _instructionHistory.push({
      time: new Date().toLocaleTimeString(),
      status: payload.status,
      instructions: payload.instructions || [],
      notes: payload.notes || '',
    })
    _rebuildHistory()
  }
}

async function submitAnswer(taskId, _questionId) {
  const answer = questionAnswer.value.trim()
  if (!answer) return
  btnAnswer.disabled = true
  btnAnswer.textContent = 'Sending…'
  chrome.runtime.sendMessage(
    { type: 'ANSWER_QUESTION', taskId, answer },
    (response) => {
      btnAnswer.disabled = false
      btnAnswer.textContent = 'Send answer'
      if (response?.payload) renderInstructions(response.payload)
    }
  )
}

// ─── Init ─────────────────────────────────────────────────────────────────────

checkConfig().then(async (configured) => {
  if (!configured) return
  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TASK' }, (response) => {
    renderTask(response?.task || null)
  })
  // Restore instruction history from the last inspect pass so the panel shows
  // context even when opened after instructions were already applied.
  const { lastInspectResult } = await chrome.storage.local.get('lastInspectResult')
  if (lastInspectResult?.payload) {
    renderInstructions(lastInspectResult.payload)
  }
})

// Stay in sync with storage directly — don't rely solely on TASK_ACQUIRED
// which can be missed if the panel isn't open when the alarm fires.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'activeTask' in changes) {
    const prev = changes.activeTask.oldValue
    const next = changes.activeTask.newValue
    renderTask(next || null)
    // Clear history only when the task itself changes (different task_id or task gone)
    if (!next || (prev && prev.task_id !== next.task_id)) {
      clearHistory()
    }
  }
  if (area === 'sync' && (changes.serviceUrl || changes.apiKey)) {
    checkConfig().then((configured) => {
      if (configured) {
        chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TASK' }, (response) => {
          renderTask(response?.task || null)
        })
      }
    })
  }
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TASK_ACQUIRED') renderTask(message.task)
  if (message.type === 'INSTRUCTIONS_UPDATE') renderInstructions(message.payload)
  if (message.type === 'UPLOAD_READY') showUploadReady(message.filename)
  if (message.type === 'UPLOAD_DONE') showUploadDone()
  if (message.type === 'UPLOAD_NEEDED') showUploadFallback(message.filename)
  if (message.type === 'TASK_DONE') {
    renderTask(null)
    clearHistory()
    hideUploadPrompt()
  }
})


btnReinspect.addEventListener('click', async () => {
  hideUploadPrompt()
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'INSPECT_NOW' }).catch(() => {})
})

btnComplete.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const resultUrl = tab?.url || ''
  btnComplete.disabled = true
  btnComplete.textContent = 'Completing…'
  chrome.runtime.sendMessage({ type: 'TASK_COMPLETE', resultUrl }, () => {
    renderTask(null)
    renderInstructions(null)
  })
})

btnClear.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_TASK' }, () => {
    renderTask(null)
    clearHistory()
  })
})
