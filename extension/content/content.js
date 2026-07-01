/**
 * FieldAgent Content Script
 *
 * Runs on target social platform pages. Responsibilities:
 * - Extract a semantic DOM snapshot (labels, inputs, buttons — not raw HTML)
 * - Apply fill instructions from the service worker
 * - Watch for significant DOM mutations (multi-step navigation) and re-inspect
 * - Detect success pages and report task completion
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
    // Try explicit label first
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (lbl) return lbl.textContent.trim()
    }
    // Walk up for wrapping label
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
      if (rect.width === 0 && rect.height === 0) return // invisible
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

  // ─── Apply fill instructions ────────────────────────────────────────────────

  function resolveElement(instruction) {
    // Try the primary selector hint
    if (instruction.selector_hint) {
      try {
        const el = document.querySelector(instruction.selector_hint)
        if (el) return el
      } catch { /* invalid selector — fall through */ }
    }

    // Fallback: find an input/textarea whose label/placeholder/aria-label
    // contains keywords from fallback_hint
    const hint = (instruction.fallback_hint || '').toLowerCase()
    const candidates = document.querySelectorAll('input:not([type=hidden]), textarea, [contenteditable]')
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
    return null
  }

  function applyInstruction(instruction) {
    const el = resolveElement(instruction)
    if (!el) {
      console.warn('[FieldAgent] Could not resolve element for instruction:', instruction)
      return false
    }

    el.focus()

    if (instruction.action === 'type') {
      // Simulate real typing so React / Vue state updates fire
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, instruction.value)
      } else {
        el.value = instruction.value
        if (el.isContentEditable) el.textContent = instruction.value
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (instruction.action === 'select' && el.tagName === 'SELECT') {
      el.value = instruction.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    return true
  }

  // ─── Inspect + respond cycle ────────────────────────────────────────────────

  function requestInspect() {
    const snapshot = extractSnapshot()
    chrome.runtime.sendMessage({ type: 'SNAPSHOT_READY', snapshot }, (response) => {
      if (!response || response.type === 'NO_TASK' || response.type === 'NO_INSTRUCTIONS') return
      if (response.type === 'INSTRUCTIONS') {
        const { instructions } = response.payload
        instructions.forEach(applyInstruction)
      }
    })
  }

  function scheduleInspect(delayMs = 800) {
    clearTimeout(inspectDebounceTimer)
    inspectDebounceTimer = setTimeout(() => {
      // Only re-inspect if the URL changed or this is the first run
      if (window.location.href !== lastSnapshotUrl) {
        lastSnapshotUrl = window.location.href
        requestInspect()
      }
    }, delayMs)
  }

  // ─── MutationObserver for multi-step navigation ─────────────────────────────

  let significantMutationCount = 0
  const observer = new MutationObserver((mutations) => {
    // Count mutations that suggest a new page/step has loaded
    const significant = mutations.filter((m) =>
      m.type === 'childList' && m.addedNodes.length > 3
    )
    if (significant.length > 0) {
      significantMutationCount++
      if (significantMutationCount >= 3) {
        significantMutationCount = 0
        scheduleInspect(1200) // slightly longer debounce after large DOM changes
      }
    }
  })

  observer.observe(document.body, { childList: true, subtree: true })

  // ─── Messages from service worker ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECT_NOW') {
      scheduleInspect(300)
    }
  })

  // ─── Initial inspect on page load ──────────────────────────────────────────

  scheduleInspect(1000)

  console.log(`[FieldAgent] Content script active on ${platform}`)
})()
