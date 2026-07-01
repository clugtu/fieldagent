const statusBadge = document.getElementById('status-badge')
const notConfigured = document.getElementById('not-configured')
const noTask = document.getElementById('no-task')
const taskSection = document.getElementById('task-section')
const taskPlatform = document.getElementById('task-platform')
const taskCaption = document.getElementById('task-caption')
const taskIdEl = document.getElementById('task-id')
const instructionsSection = document.getElementById('instructions-section')
const instructionsList = document.getElementById('instructions-list')
const agentNotes = document.getElementById('agent-notes')
const btnReinspect = document.getElementById('btn-reinspect')
const btnClear = document.getElementById('btn-clear')

function openSettings() {
  chrome.runtime.openOptionsPage()
}

document.getElementById('btn-open-settings').addEventListener('click', openSettings)
document.getElementById('btn-settings').addEventListener('click', openSettings)

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
}

function renderInstructions(payload) {
  if (!payload || !payload.instructions?.length) {
    instructionsSection.style.display = 'none'
    return
  }
  instructionsSection.style.display = ''
  instructionsList.innerHTML = payload.instructions.map((ins) => `
    <div class="instruction">
      <span class="instruction-field" title="${ins.fallback_hint}">${ins.fallback_hint}</span>
      <span class="instruction-value" title="${ins.value}">${ins.value}</span>
    </div>
  `).join('')

  if (payload.notes) {
    agentNotes.textContent = payload.notes
    agentNotes.style.display = ''
  } else {
    agentNotes.style.display = 'none'
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

checkConfig().then((configured) => {
  if (!configured) return
  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TASK' }, (response) => {
    renderTask(response?.task || null)
  })
})

// Re-check config whenever storage changes (e.g. user just saved Settings)
chrome.storage.onChanged.addListener((changes, area) => {
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
  if (message.type === 'TASK_DONE') {
    renderTask(null)
    renderInstructions(null)
  }
})

btnReinspect.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'INSPECT_NOW' })
})

btnClear.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_TASK' }, () => {
    renderTask(null)
    renderInstructions(null)
  })
})
