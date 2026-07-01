/**
 * FieldAgent Content Script
 *
 * Runs on target social platform pages. Responsibilities:
 * - Extract a semantic DOM snapshot (labels, inputs, buttons — not raw HTML)
 * - Apply fill instructions from the service worker (text + file attachment)
 * - Watch for significant DOM mutations (multi-step navigation) and re-inspect
 * - Surface agent questions in the side panel via the service worker
 */

;(function () {
  'use strict'

  const PLATFORM_MAP = {
    'www.facebook.com': 'facebook',
    'www.instagram.com': 'instagram',
    'www.pinterest.com': 'pinterest',
    'twitter.com': 'twitter',
    'x.com': 'twitter',
    'www.linkedin.com': 'linkedin',
  }

  const platform = PLATFORM_MAP[window.location.hostname] || 'unknown'
  let inspectDebounceTimer = null
  let lastSnapshotUrl = null

  // ─── DOM snapshot extraction ────────────────────────────────────────────────

  function nearestLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (lbl) return lbl.textContent.trim()
    }
    let parent = el.parentElement
    for (let i = 0; i < 5 && parent; i++) {
      if (parent.tagName === 'LABEL') return parent.textContent.replace(el.value || '', '').trim()
      parent = parent.parentElement
    }
    return ''
  }

  function extractSnapshot() {
    const inputs = []
    document.querySelectorAll('input, textarea').forEach((el) => {
      if (el.type === 'hidden') return
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      inputs.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        aria_label: el.getAttribute('aria-label') || '',
        label_text: nearestLabel(el),
        current_value: el.value || el.textContent?.trim() || '',
      })
    })

    const buttons = []
    document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach((el) => {
      const text = el.textContent?.trim() || el.value || el.getAttribute('aria-label') || ''
      if (!text) return
      buttons.push({
        text,
        type: el.type || 'button',
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      })
    })

    const headings = []
    document.querySelectorAll('h1, h2, h3').forEach((el) => {
      const text = el.textContent.trim()
      if (text) headings.push(text)
    })

    return {
      url: window.location.href,
      title: document.title,
      platform_hint: platform,
      inputs,
      buttons,
      headings,
      selects: [],
    }
  }

  // ─── Element resolution ─────────────────────────────────────────────────────

  function resolveElement(instruction) {
    if (instruction.selector_hint) {
      try {
        const el = document.querySelector(instruction.selector_hint)
        if (el) return el
      } catch { /* invalid selector */ }
    }

    const hint = (instruction.fallback_hint || '').toLowerCase()
    const tag = instruction.action === 'attach_file' ? 'input[type="file"]' : 'input:not([type=hidden]), textarea, [contenteditable]'
    const candidates = document.querySelectorAll(tag)
    for (const el of candidates) {
      const text = [
        el.placeholder,
        el.getAttribute('aria-label'),
        nearestLabel(el),
        el.name,
        el.id,
      ].join(' ').toLowerCase()
      if (hint.split(' ').some((word) => word.length > 3 && text.includes(word))) {
        return el
      }
    }

    // Last resort for file inputs: return the first visible one
    if (instruction.action === 'attach_file') {
      return document.querySelector('input[type="file"]') || null
    }
    return null
  }

  // ─── Text fill ──────────────────────────────────────────────────────────────

  function applyTextFill(el, value) {
    el.focus()
    const nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set

    if (nativeSetter) {
      nativeSetter.call(el, value)
    } else {
      el.value = value
      if (el.isContentEditable) el.textContent = value
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function applySelect(el, value) {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // ─── File attachment ────────────────────────────────────────────────────────
  // The service proxies asset files through /assets/{task_id}/{asset_id}.
  // The service worker fetches the bytes (it has the API key), sends them
  // back here as a base64 string, and we inject them via DataTransfer.

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
            // Decode base64 → Uint8Array → File
            const binary = atob(response.base64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            const blob = new Blob([bytes], { type: response.mimeType })
            const file = new File([blob], response.filename, { type: response.mimeType })

            const dt = new DataTransfer()
            dt.items.add(file)
            el.files = dt.files
            el.dispatchEvent(new Event('change', { bubbles: true }))
            resolve()
          } catch (err) {
            reject(err)
          }
        }
      )
    })
  }

  // ─── Apply a single fill instruction ────────────────────────────────────────

  async function applyInstruction(instruction, taskId) {
    const el = resolveElement(instruction)
    if (!el) {
      console.warn('[FieldAgent] Could not resolve element:', instruction.fallback_hint)
      return
    }

    switch (instruction.action) {
      case 'type':
        applyTextFill(el, instruction.value)
        break
      case 'select':
        applySelect(el, instruction.value)
        break
      case 'attach_file':
        await applyFileAttach(el, instruction, taskId)
        break
      case 'focus':
        el.focus()
        break
    }
  }

  // ─── Inspect + respond cycle ────────────────────────────────────────────────

  function requestInspect() {
    const snapshot = extractSnapshot()
    chrome.runtime.sendMessage({ type: 'SNAPSHOT_READY', snapshot }, async (response) => {
      if (!response || response.type === 'NO_TASK') return

      if (response.type === 'INSTRUCTIONS') {
        const { instructions, task_id } = response.payload
        for (const ins of instructions) {
          await applyInstruction(ins, task_id)
        }
      }

      // AWAITING_INPUT: the agent has a question — the side panel surfaces it
      // to the user (or to the calling agent), and the answer flows back via
      // POST /inspect/respond/{task_id}. Nothing more to do in the content
      // script for this case.
    })
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

  // ─── MutationObserver for multi-step navigation ─────────────────────────────

  let significantMutationCount = 0
  const observer = new MutationObserver((mutations) => {
    const significant = mutations.filter((m) => m.type === 'childList' && m.addedNodes.length > 3)
    if (significant.length > 0) {
      significantMutationCount++
      if (significantMutationCount >= 3) {
        significantMutationCount = 0
        scheduleInspect(1200)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // ─── Messages from service worker ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECT_NOW') scheduleInspect(300)
  })

  // ─── Initial inspect ────────────────────────────────────────────────────────

  scheduleInspect(1000)

  console.log(`[FieldAgent] Content script active on ${platform}`)
})()
