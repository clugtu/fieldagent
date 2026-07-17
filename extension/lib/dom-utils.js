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

// Find the active editing container on the page.
// On tools like Pinterest's creation tool (single URL, multiple draft panels in
// the DOM), document.querySelectorAll picks up fields from every draft — the
// sidebar, background panels, etc.  Scoping to the active editor prevents the
// LLM from seeing a confusing mix of inputs from multiple drafts.
//
// Strategy: the [aria-label="note"] contenteditable only exists inside the
// currently selected draft's editing pane.  Walk up from it to find the
// tightest ancestor that contains at least 3 form-like elements (title input,
// note field, link input), which is the active editor container.
// A second, slightly wider root is used for buttons/upload zones that may sit
// just outside the form container (header, action bar).
function _findActiveRoots() {
  // Pinterest renders ALL drafts' editors in the DOM simultaneously — only the
  // selected draft's pane is visible.  el.offsetParent === null means the
  // element is inside a display:none subtree (hidden panel), so we skip those
  // and find the one that's actually on screen.
  const note = typeof document !== 'undefined'
    ? Array.from(document.querySelectorAll('[contenteditable][aria-label="note"]'))
        .find((el) => el.offsetParent !== null) ?? null
    : null

  if (!note) return { formRoot: document, wideRoot: document, scoped: false }

  // Walk up from the note field to find the tightest sensible form container.
  let el = note.parentElement
  let formRoot = null
  for (let i = 0; i < 20 && el && el !== document.body; i++) {
    if (el.tagName === 'FORM' || el.tagName === 'MAIN' || el.getAttribute('role') === 'main') {
      formRoot = el
      break
    }
    const editables = el.querySelectorAll('input:not([type=hidden]), textarea, [contenteditable]')
    if (editables.length >= 3) { formRoot = el; break }
    el = el.parentElement
  }

  if (!formRoot) {
    // Fallback: a few levels above the note field
    formRoot = note.parentElement?.parentElement?.parentElement || document
  }

  // The wide root goes a few levels higher to capture upload zones and action
  // buttons (Publish, board picker) that may be siblings of the form container.
  const wideRoot = formRoot.parentElement?.parentElement || formRoot

  return { formRoot, wideRoot, scoped: true }
}

function extractSnapshot(platformHint) {
  const { formRoot, wideRoot, scoped } = _findActiveRoots()

  const inputs = []
  const seen = new Set()

  formRoot.querySelectorAll('input, textarea').forEach((el) => {
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
  formRoot.querySelectorAll('[contenteditable="true"]').forEach((el) => {
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
  wideRoot.querySelectorAll('button, [role="button"], input[type="submit"]').forEach((el) => {
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
  formRoot.querySelectorAll('select').forEach((el) => {
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
  wideRoot.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]').forEach((el) => {
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
  wideRoot.querySelectorAll('h1, h2, h3').forEach((el) => {
    const text = el.textContent.trim()
    if (text) headings.push(text)
  })

  // Upload / drag-drop zones — look for the nearest interactive container
  // around any file input, plus elements with upload-related attributes
  const upload_zones = []
  const seenZones = new Set()
  wideRoot.querySelectorAll('input[type="file"]').forEach((input) => {
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
  const chipRoot = wideRoot !== document ? wideRoot : (typeof document !== 'undefined' ? document : null)
  if (chipRoot) {
    chipRoot.querySelectorAll('button, [role="button"]').forEach((btn) => {
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
    // scoped_to_active_editor: true means the snapshot was narrowed to the
    // currently active editing pane, not the full document.  Fields from other
    // draft panels, sidebars, or background elements are excluded.
    scoped_to_active_editor: scoped,
    inputs,
    buttons,
    headings,
    selects,
    dropdowns,
    upload_zones,
    chips,
  }
}

// After a Pinterest publish, a "View Pin" link appears (usually inside a toast)
// pointing at the new pin's real permalink. window.location.href is unreliable
// here — Pinterest frequently stays on the pin-builder page instead of
// navigating, so the current URL never becomes the pin URL. Read the
// permalink directly off the anchor instead.
function findPublishedPinUrl() {
  const anchors = typeof document !== 'undefined'
    ? Array.from(document.querySelectorAll('a[href]'))
    : []
  const isPinLink = (a) => /\/pin\/\d+/.test(a.href)
  const byText = anchors.find((a) => {
    const text = (a.textContent || '').trim().toLowerCase()
    return text.includes('view pin') && isPinLink(a)
  })
  if (byText) return byText.href
  const byPattern = anchors.find(isPinLink)
  return byPattern ? byPattern.href : null
}

// Finds the action inside Pinterest's "Your Pin has been published!" toast —
// confirmed against the live site to be an <a href="/pin/<id>"> whose visible
// text is just "View" (aria-label "Navigate to created Pin"), scoped inside
// a [data-test-id="toast"] container. Its href already carries the real pin
// permalink (see findPublishedPinUrl, used as the read-path once this is
// found), so this only needs to locate the clickable element, not parse its
// label — which is good, since Pinterest is free to change that label text.
function findViewPinAction() {
  const toasts = typeof document !== 'undefined'
    ? Array.from(document.querySelectorAll('[data-test-id="toast"], [aria-label="Toast notification"]'))
    : []
  if (toasts.length > 0) {
    for (const toast of toasts) {
      if (toast.closest('[aria-hidden="true"]')) continue
      if (!(toast.textContent || '').toLowerCase().includes('published')) continue
      const action = toast.querySelector('a[href], button, [role="button"]')
      if (action) return action
    }
    // A toast wrapper exists but none of them is the publish-success one
    // (could be an unrelated toast, e.g. "Upload complete") — don't fall
    // through to the broad match below, which could grab an unrelated link.
    return null
  }
  // Fallback in case Pinterest drops the toast wrapper entirely: broad text match.
  const candidates = typeof document !== 'undefined'
    ? Array.from(document.querySelectorAll('button, [role="button"], a[href]'))
    : []
  return candidates.find((el) => {
    if (el.closest('[aria-hidden="true"]')) return false
    const text = (el.textContent || '').trim().toLowerCase()
    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase()
    return text === 'view pin' || text === 'view' || aria.includes('created pin')
  }) || null
}

function resolveElement(instruction) {
  if (instruction.selector_hint) {
    try {
      for (const el of document.querySelectorAll(instruction.selector_hint)) {
        if (typeof el.closest === 'function' && el.closest('[aria-hidden="true"]')) continue
        if (instruction.action !== 'paste_file' && el.offsetParent === null) continue
        return el
      }
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
    tag = 'button, [role="button"], [role="combobox"], [aria-haspopup], a, input:not([type=hidden]), textarea, [contenteditable], [role="option"], [role="menuitem"], [role="listitem"]'
  } else {
    tag = 'input:not([type=hidden]), textarea, [contenteditable]'
  }

  const candidates = document.querySelectorAll(tag)
  for (const el of candidates) {
    // Skip elements inside aria-hidden containers (inactive draft panels, sidebars).
    // Pinterest hides non-active draft panes with aria-hidden="true"; clicking them
    // has no effect, and they can shadow the correct element in the active editor.
    if (typeof el.closest === 'function' && el.closest('[aria-hidden="true"]')) continue
    // Skip elements in display:none subtrees — they aren't interactive.
    // paste_file drop zones may be hidden until a drag event activates them.
    if (action !== 'paste_file' && el.offsetParent === null) continue

    const elText = [
      el.placeholder,
      el.getAttribute('aria-label'),
      el.textContent?.trim().slice(0, 80),
      nearestLabel(el),
      // Intentionally omit el.id and el.name — internal DOM identifiers (e.g.
      // "storyboard-selector-title") contain substrings like "board" that
      // spuriously match unrelated hints and shadow the real target.
    ]
      .join(' ')
      .toLowerCase()
    // Short hints (≤3 chars, e.g. ">") need an exact text-content match so they
    // don't get silently skipped by the word-length guard below.
    if (hint.length <= 3) {
      if (
        el.textContent?.trim().toLowerCase() === hint ||
        el.getAttribute('aria-label')?.toLowerCase() === hint
      ) return el
    } else {
      // All words longer than 3 chars must appear — prevents "Search for a board"
      // matching the tag input (which has "search" but not "board").
      // For click actions, skip contenteditable rich-text editors — their body text
      // can spuriously match section/tag names (e.g. description containing "Cthulhu").
      if (action === 'click' && el.isContentEditable) continue
      const keyWords = hint.split(' ').filter((w) => w.length > 3)
      if (keyWords.length > 0 && keyWords.every((w) => elText.includes(w))) return el
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
    // Select all existing content so the paste replaces rather than appends.
    // Selection API does NOT modify the DOM — no React removeChild risk.
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(range) }

    // Draft.js checks event.isTrusted and silently ignores synthetic InputEvents
    // (beforeinput approach, defaultPrevented always false). It does honour
    // ClipboardEvent paste: its onPaste handler reads clipboardData.getData()
    // and calls onChange with the new EditorState — React reconciles cleanly.
    const dt = new DataTransfer()
    dt.setData('text/plain', value)
    el.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    }))
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
  module.exports = { nearestLabel, extractSnapshot, resolveElement, applyTextFill, applyInstruction, injectFile, pasteFileIntoDropZone, findPublishedPinUrl, findViewPinAction }
} else {
  // Browser content script — expose for content.js
  window.FieldAgentUtils = { nearestLabel, extractSnapshot, resolveElement, applyTextFill, applyInstruction, injectFile, pasteFileIntoDropZone, findPublishedPinUrl, findViewPinAction }
}
