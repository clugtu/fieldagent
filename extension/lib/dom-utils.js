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
  const seen = new Set()

  document.querySelectorAll('input, textarea').forEach((el) => {
    if (el.type === 'hidden') return
    seen.add(el)
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

  // Contenteditable divs (used by Pinterest/Facebook description fields)
  document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
    if (seen.has(el)) return
    seen.add(el)
    inputs.push({
      tag: el.tagName.toLowerCase(),
      type: 'contenteditable',
      name: el.getAttribute('data-name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || el.dataset?.placeholder || el.getAttribute('aria-placeholder') || '',
      aria_label: el.getAttribute('aria-label') || '',
      label_text: nearestLabel(el),
      current_value: el.textContent?.trim() || '',
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

  // Native <select> dropdowns
  const selects = []
  document.querySelectorAll('select').forEach((el) => {
    selects.push({
      name: el.name || '',
      id: el.id || '',
      aria_label: el.getAttribute('aria-label') || '',
      label_text: nearestLabel(el),
      options: Array.from(el.options).map((o) => ({ value: o.value, text: o.text })),
      current_value: el.value || '',
    })
  })

  // Custom dropdown openers (board pickers, comboboxes)
  const dropdowns = []
  document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]').forEach((el) => {
    const text = el.textContent?.trim().slice(0, 120) || ''
    const label = el.getAttribute('aria-label') || ''
    if (!text && !label) return
    dropdowns.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      aria_label: label,
      text,
      placeholder: el.getAttribute('placeholder') || '',
    })
  })

  const headings = []
  document.querySelectorAll('h1, h2, h3').forEach((el) => {
    const text = el.textContent.trim()
    if (text) headings.push(text)
  })

  // Upload / drag-drop zones — look for the nearest interactive container
  // around any file input, plus elements with upload-related attributes
  const upload_zones = []
  const seenZones = new Set()
  document.querySelectorAll('input[type="file"]').forEach((input) => {
    // Walk up to find a labelled ancestor that looks like the drop zone
    let candidate = input.parentElement
    for (let i = 0; i < 6 && candidate; i++) {
      const cls = (candidate.className || '').toLowerCase()
      const testid = (candidate.getAttribute('data-testid') || candidate.getAttribute('data-test-id') || '').toLowerCase()
      const role = candidate.getAttribute('role') || ''
      if (cls.includes('upload') || cls.includes('drop') || cls.includes('media') ||
          testid.includes('upload') || testid.includes('image') || testid.includes('pin') ||
          role === 'presentation') {
        break
      }
      candidate = candidate.parentElement
    }
    const zone = candidate || input.parentElement
    if (!zone || seenZones.has(zone)) return
    seenZones.add(zone)
    // has_preview: true means an upload thumbnail is showing.
    // Check the zone itself AND its parent — Pinterest often places the preview
    // image as a sibling of the file input rather than a direct descendant.
    // Also check srcset: Pinterest uses responsive images without a bare src.
    const _previewQ = 'img[src]:not([src=""]), img[srcset]:not([srcset=""]), video[src]:not([src=""])'
    const has_preview = !!(
      zone.querySelector(_previewQ) ||
      zone.parentElement?.querySelector(_previewQ)
    )
    upload_zones.push({
      tag: zone.tagName.toLowerCase(),
      id: zone.id || '',
      data_testid: zone.getAttribute('data-testid') || zone.getAttribute('data-test-id') || '',
      aria_label: zone.getAttribute('aria-label') || '',
      class_hint: (zone.className || '').toString().replace(/\s+/g, ' ').slice(0, 80),
      has_file_input: true,
      has_preview,
    })
  })

  // Tag / keyword chips — rendered as custom DOM elements (not inputs).
  // Heuristic: look for remove/delete buttons whose aria-label names the tag,
  // or for parent elements of such buttons whose text content is the tag text.
  const chips = []
  const seenChips = new Set()
  if (typeof document !== 'undefined') {
    document.querySelectorAll('button, [role="button"]').forEach((btn) => {
      const label = btn.getAttribute('aria-label') || ''
      const lc = label.toLowerCase()
      // Pattern 1: aria-label = "Remove <tag>" or "Delete tag <tag>"
      if (lc.startsWith('remove ') || lc.startsWith('delete ')) {
        const text = label.replace(/^(remove|delete)\s+(tag\s+)?/i, '').trim()
        if (text && text.length < 60 && !seenChips.has(text)) {
          seenChips.add(text)
          chips.push(text)
          return
        }
      }
      // Pattern 2: button has no useful label but parent element looks like a chip
      if (lc === '×' || lc === 'remove' || lc === 'delete' || btn.textContent?.trim() === '×') {
        const parent = btn.parentElement
        if (!parent) return
        const text = (parent.textContent || '').replace(btn.textContent || '', '').trim()
        if (text && text.length < 60 && !seenChips.has(text)) {
          seenChips.add(text)
          chips.push(text)
        }
      }
    })
  }

  return {
    url: typeof window !== 'undefined' ? window.location.href : '',
    title: typeof document !== 'undefined' ? document.title : '',
    platform_hint: platformHint || 'unknown',
    inputs,
    buttons,
    headings,
    selects,
    dropdowns,
    upload_zones,
    chips,
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
  const action = instruction.action

  let tag
  if (action === 'attach_file') {
    tag = 'input[type="file"]'
  } else if (action === 'paste_file') {
    // Target a drop zone / upload container, not a file input
    tag = '[role="presentation"], [data-testid*="upload"], [class*="upload"], [class*="Upload"], [class*="drop"], [class*="Drop"]'
  } else if (action === 'click') {
    tag = 'button, [role="button"], [role="combobox"], [aria-haspopup], a, input:not([type=hidden]), textarea, [contenteditable]'
  } else {
    tag = 'input:not([type=hidden]), textarea, [contenteditable]'
  }

  const candidates = document.querySelectorAll(tag)
  for (const el of candidates) {
    const text = [
      el.placeholder,
      el.getAttribute('aria-label'),
      el.textContent?.trim().slice(0, 80),
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

  if (action === 'attach_file') {
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
    el.focus()
    // execCommand routes through the browser's native editing pipeline, which
    // React's synthetic event system intercepts correctly. Setting textContent
    // directly bypasses React's internal state, leaving the placeholder visible
    // and the field frozen.
    document.execCommand('selectAll', false, null)
    document.execCommand('insertText', false, value)
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
    case 'click':
      el.click()
      break
    case 'press_enter':
      el.focus()
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
      break
    // attach_file handled separately (requires async service worker call)
  }
  return true
}

/**
 * Inject a file into an <input type="file"> via DataTransfer.
 * Called by content.js after the SW returns the base64-encoded asset.
 * Extracted here so it can be unit-tested without the async chrome message.
 *
 * @param {HTMLInputElement} el
 * @param {{ base64: string, mimeType: string, filename: string }} fileData
 */
function injectFile(el, { base64, mimeType, filename }) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: mimeType })
  const file = new File([blob], filename, { type: mimeType })
  const dt = new DataTransfer()
  dt.items.add(file)

  // Native file input — set files and fire both input + change
  el.files = dt.files
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Simulate a drag-and-drop file upload onto an element.
 * Fires dragenter → dragover → drop with a DataTransfer containing the file.
 * React drop-zone libraries (react-dropzone, etc.) read event.dataTransfer.files
 * from the drop event, which IS set by the DragEvent constructor in Chrome.
 *
 * @param {Element} dropZone  — the upload container element
 * @param {{ base64: string, mimeType: string, filename: string }} fileData
 */
function pasteFileIntoDropZone(dropZone, { base64, mimeType, filename }) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: mimeType })
  const file = new File([blob], filename, { type: mimeType })
  const dt = new DataTransfer()
  dt.items.add(file)

  dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
  dropZone.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }))
  dropZone.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }))
}

if (typeof module !== 'undefined') {
  // CommonJS — used by Jest tests
  module.exports = { nearestLabel, extractSnapshot, resolveElement, applyTextFill, applyInstruction, injectFile, pasteFileIntoDropZone }
} else {
  // Browser content script — expose for content.js
  window.FieldAgentUtils = { nearestLabel, extractSnapshot, resolveElement, applyTextFill, applyInstruction, injectFile, pasteFileIntoDropZone }
}
