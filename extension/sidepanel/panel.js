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

function renderInstructions(payload) {
  questionSection.style.display = 'none'
  instructionsSection.style.display = 'none'

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

  if (payload.instructions?.length) {
    instructionsSection.style.display = ''
    instructionsList.innerHTML = payload.instructions.map((ins) => `
      <div class="instruction">
        <span class="instruction-field" title="${ins.fallback_hint}">${ins.fallback_hint}</span>
        <span class="instruction-value" title="${ins.value}">${ins.value}</span>
      </div>
    `).join('')
  }

  if (payload.notes) {
    agentNotes.textContent = payload.notes
    agentNotes.style.display = ''
  } else {
    agentNotes.style.display = 'none'
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

checkConfig().then((configured) => {
  if (!configured) return
  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TASK' }, (response) => {
    renderTask(response?.task || null)
  })
})

// Stay in sync with storage directly — don't rely solely on TASK_ACQUIRED
// which can be missed if the panel isn't open when the alarm fires.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'activeTask' in changes) {
    renderTask(changes.activeTask.newValue || null)
    if (!changes.activeTask.newValue) {
      renderInstructions(null)
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
  if (message.type === 'TASK_DONE') {
    renderTask(null)
    renderInstructions(null)
  }
  if (message.type === 'TASK_DONE') {
    renderTask(null)
    renderInstructions(null)
  }
})

btnReinspect.addEventListener('click', async () => {
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
    renderInstructions(null)
  })
})
