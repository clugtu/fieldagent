/**
 * FieldAgent Content Script
 *
 * Runs on target pages. Responsibilities:
 * - Extract a semantic DOM snapshot via FieldAgentUtils (lib/dom-utils.js)
 * - Call the FieldAgent service /inspect endpoint directly (avoids MV3 service
 *   worker lifetime limits — inference takes 5-10s, longer than SW stays alive)
 * - Apply fill instructions from the service
 * - Watch for significant DOM mutations (multi-step navigation) and re-inspect
 */

;(function () {
  'use strict'

  const { extractSnapshot, applyInstruction } = window.FieldAgentUtils

  const HOSTNAME_HINTS = {
    'www.facebook.com': 'facebook',
    'www.instagram.com': 'instagram',
    'www.pinterest.com': 'pinterest',
    'twitter.com': 'twitter',
    'x.com': 'twitter',
    'www.linkedin.com': 'linkedin',
  }

  const platform = HOSTNAME_HINTS[window.location.hostname] || window.location.hostname
  let inspectDebounceTimer = null
  let lastSnapshotUrl = null
  let inspectInProgress = false

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
            window.FieldAgentUtils.injectFile(el, response)
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

  // ─── Inspect + fill cycle ───────────────────────────────────────────────────
  // Calls /inspect directly to avoid MV3 service worker lifetime limits.

  async function requestInspect() {
    if (inspectInProgress) return
    inspectInProgress = true
    try {
      // Read active task directly from local storage — avoids service worker
      // cold-start race that causes GET_ACTIVE_TASK to lose the message channel
      const { activeTask: task } = await new Promise((resolve) =>
        chrome.storage.local.get('activeTask', resolve)
      )
      if (!task) return

      const snapshot = extractSnapshot(platform)

      // Route the /inspect call through the service worker via a persistent port
      // connection. Content scripts on HTTPS pages can't fetch HTTP (mixed
      // content), but the service worker (chrome-extension:// origin) can.
      // An open port keeps the service worker alive during the ~5-10s inference.
      const result = await new Promise((resolve, reject) => {
        let settled = false
        const port = chrome.runtime.connect({ name: 'inspect' })

        port.onMessage.addListener((msg) => {
          settled = true
          port.disconnect()
          if (msg.error) reject(new Error(msg.error))
          else resolve(msg)
        })

        port.onDisconnect.addListener(() => {
          if (!settled) reject(new Error('Service worker disconnected before responding'))
        })

        port.postMessage({ type: 'INSPECT', taskId: task.task_id, snapshot })
      })

      if (result.status === 'complete') {
        // Agent detected a success/confirmation page — mark the task done
        chrome.runtime.sendMessage({
          type: 'TASK_COMPLETE',
          resultUrl: window.location.href,
        }).catch(() => {})
        return
      }

      // Notify side panel so it can display the instructions
      chrome.runtime.sendMessage({ type: 'INSTRUCTIONS_UPDATE', payload: result }).catch(() => {})

      // Apply instructions to the page
      if (result?.instructions?.length) {
        await applyInstructions(result.instructions, task.task_id)
      }
    } finally {
      inspectInProgress = false
    }
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

  // ─── Only inspect when explicitly triggered ─────────────────────────────────
  // Auto-inspect on page load only fires once. After that, only respond to
  // explicit INSPECT_NOW from the side panel. No MutationObserver polling —
  // the user clicked Re-inspect if they want another pass.

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'INSPECT_NOW') {
      lastSnapshotUrl = null // force re-inspect even if URL hasn't changed
      scheduleInspect(300)
    }
    if (message.type === 'APPLY_INSTRUCTIONS' && message.payload?.instructions?.length) {
      applyInstructions(message.payload.instructions, message.payload.task_id)
    }
  })

  // Single auto-inspect on page load (handles initial task acquisition)
  scheduleInspect(1000)

  console.log(`[FieldAgent] Content script active on ${platform}`)
})()
