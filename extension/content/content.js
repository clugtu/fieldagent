/**
 * FieldAgent Content Script
 *
 * Runs on target social platform pages. Responsibilities:
 * - Extract a semantic DOM snapshot via FieldAgentUtils (lib/dom-utils.js)
 * - Apply fill instructions from the service worker (text + file attachment)
 * - Watch for significant DOM mutations (multi-step navigation) and re-inspect
 * - Surface agent questions in the side panel via the service worker
 *
 * lib/dom-utils.js is injected before this file (see manifest.json) and
 * exposes pure DOM utilities on window.FieldAgentUtils.
 */

;(function () {
  'use strict'

  const { extractSnapshot, applyInstruction } = window.FieldAgentUtils

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

  // ─── File attachment ────────────────────────────────────────────────────────

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

  // ─── Apply instructions ─────────────────────────────────────────────────────

  async function applyInstructions(instructions, taskId) {
    for (const ins of instructions) {
      if (ins.action === 'attach_file') {
        const el = window.FieldAgentUtils.resolveElement(ins)
        if (el) await applyFileAttach(el, ins, taskId).catch(console.warn)
      } else {
        applyInstruction(ins)
      }
    }
  }

  // ─── Inspect + respond cycle ────────────────────────────────────────────────

  function requestInspect() {
    const snapshot = extractSnapshot(platform)
    chrome.runtime.sendMessage({ type: 'SNAPSHOT_READY', snapshot }, async (response) => {
      if (!response || response.type === 'NO_TASK') return
      if (response.type === 'INSTRUCTIONS') {
        await applyInstructions(response.payload.instructions, response.payload.task_id)
      }
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

  scheduleInspect(1000)

  console.log(`[FieldAgent] Content script active on ${platform}`)
})()
