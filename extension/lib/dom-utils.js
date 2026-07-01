/**
 * Pure DOM utilities — extracted for testability.
 * Used by content.js and directly by Jest tests via CommonJS require().
 */

'use strict'

function nearestLabel(el) {
  if (el.id) {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id
    const lbl = document.querySelector(`label[for="${escaped}"]`)
    if (lbl) return lbl.textContent.trim()
  }
  let parent = el.parentElement
  for (let i = 0; i < 5 && parent; i++) {
    if (parent.tagName === 'LABEL') return parent.textContent.replace(el.value || '', '').trim()
    parent = parent.parentElement
  }
  return ''
}

function extractSnapshot(platformHint) {
  const inputs = []
  document.querySelectorAll('input, textarea').forEach((el) => {
    if (el.type === 'hidden') return
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
    url: typeof window !== 'undefined' ? window.location.href : '',
    title: typeof document !== 'undefined' ? document.title : '',
    platform_hint: platformHint || 'unknown',
    inputs,
    buttons,
    headings,
    selects: [],
  }
}

function resolveElement(instruction) {
  if (instruction.selector_hint) {
    try {
      const el = document.querySelector(instruction.selector_hint)
      if (el) return el
    } catch { /* invalid selector */ }
  }

  const hint = (instruction.fallback_hint || '').toLowerCase()
  const tag =
    instruction.action === 'attach_file'
      ? 'input[type="file"]'
      : 'input:not([type=hidden]), textarea, [contenteditable]'

  const candidates = document.querySelectorAll(tag)
  for (const el of candidates) {
    const text = [
      el.placeholder,
      el.getAttribute('aria-label'),
      nearestLabel(el),
      el.name,
      el.id,
    ]
      .join(' ')
      .toLowerCase()
    if (hint.split(' ').some((word) => word.length > 3 && text.includes(word))) {
      return el
    }
  }

  if (instruction.action === 'attach_file') {
    return document.querySelector('input[type="file"]') || null
  }
  return null
}

function applyTextFill(el, value) {
  el.focus()
  // Use the native setter so React / Vue synthetic events fire correctly.
  // contenteditable divs (common in React rich-text editors like Pinterest's)
  // don't have a .value property — set textContent instead.
  if (el.isContentEditable) {
    el.textContent = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  // Pick the setter from the element's own prototype — calling the
  // HTMLInputElement setter on a textarea (or vice versa) throws in jsdom.
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (nativeSetter) {
    nativeSetter.call(el, value)
  } else {
    el.value = value
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function applyInstruction(instruction) {
  const el = resolveElement(instruction)
  if (!el) return false

  switch (instruction.action) {
    case 'type':
      applyTextFill(el, instruction.value)
      break
    case 'select':
      el.value = instruction.value
      el.dispatchEvent(new Event('change', { bubbles: true }))
      break
    case 'focus':
      el.focus()
      break
    // attach_file handled separately (requires async service worker call)
  }
  return true
}

if (typeof module !== 'undefined') {
  // CommonJS — used by Jest tests
  module.exports = { nearestLabel, extractSnapshot, resolveElement, applyTextFill, applyInstruction }
} else {
  // Browser content script — expose for content.js
  window.FieldAgentUtils = { nearestLabel, extractSnapshot, resolveElement, applyTextFill, applyInstruction }
}
