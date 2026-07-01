const statusBadge = document.getElementById('status-badge')
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

// Load current state on open
chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TASK' }, (response) => {
  renderTask(response?.task || null)
})

// Listen for live updates from the service worker
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
