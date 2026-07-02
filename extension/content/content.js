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
  let submitWatchedForm = null

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

  // ─── Upload completion watcher ──────────────────────────────────────────────
  // After a paste_file instruction we snapshot the form BEFORE the upload, then
  // watch for ANY meaningful form change (new inputs appearing, upload zone gaining
  // a preview, zone disappearing entirely). When the diff looks meaningful we set
  // uploadJustCompleted so the next inspect pass tells the LLM "upload finished" —
  // no platform-specific DOM rules needed in the prompt.

  let uploadWatcher = null
  let watchSettleTimer = null
  let uploadFallbackTimer = null  // last-resort re-inspect if observer misses the change
  let lastUploadTaskId = null     // prevents re-running paste_file for the same task
  let uploadJustCompleted = false

  function _formChanged(pre, post) {
    if (post.inputs.length > pre.inputs.length) return true
    const preHasPreview = pre.upload_zones.some((z) => z.has_preview)
    const postHasPreview = post.upload_zones.some((z) => z.has_preview)
    if (!preHasPreview && postHasPreview) return true
    if (pre.upload_zones.length > 0 && post.upload_zones.length === 0) return true
    return false
  }

  function watchForFormChange(preSnapshot) {
    if (uploadWatcher) return

    uploadWatcher = new MutationObserver(() => {
      clearTimeout(watchSettleTimer)
      watchSettleTimer = setTimeout(() => {
        const postSnapshot = extractSnapshot(platform)
        if (!_formChanged(preSnapshot, postSnapshot)) return
        clearTimeout(uploadFallbackTimer)
        uploadWatcher.disconnect()
        uploadWatcher = null
        lastSnapshotUrl = null
        uploadJustCompleted = true
        scheduleInspect(500)
      }, 800)
    })

    // Widen the attribute filter: Pinterest previews can use srcset or
    // style="background-image:..." rather than a plain src attribute.
    uploadWatcher.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'src', 'srcset', 'style'],
    })

    setTimeout(() => {
      if (uploadWatcher) { uploadWatcher.disconnect(); uploadWatcher = null }
    }, 3 * 60 * 1000)
  }

  // ─── Submit watcher ─────────────────────────────────────────────────────────
  // After filling a form, re-inspect 2s after the user submits so the agent
  // can detect in-page success states (banners, modals) without navigation.

  function watchForSubmit() {
    const form = document.querySelector('form')
    if (!form || form === submitWatchedForm) return
    submitWatchedForm = form
    form.addEventListener('submit', () => {
      submitWatchedForm = null
      lastSnapshotUrl = null
      scheduleInspect(2000)
    }, { once: true })
  }

  // ─── Apply instructions ─────────────────────────────────────────────────────

  async function applyInstructions(instructions, taskId) {
    for (const ins of instructions) {
      if (ins.action === 'paste_file') {
        if (lastUploadTaskId === taskId) {
          // LLM re-issued paste_file without seeing the completed state.
          uploadJustCompleted = true
          lastSnapshotUrl = null
          scheduleInspect(300)
          break
        }
        lastUploadTaskId = taskId
        const preSnapshot = extractSnapshot(platform)

        // Inject the file directly — no CDP debugger needed.
        // Pinterest's upload zone accepts DragEvents (drag-and-drop); if no
        // zone is found we fall back to injecting into the bare file input.
        try {
          const assetData = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { type: 'FETCH_ASSET', taskId, assetId: ins.asset_id },
              (r) => {
                if (!r || r.error) reject(new Error(r?.error || 'Asset fetch failed'))
                else resolve(r)
              }
            )
          })
          const dropZone = window.FieldAgentUtils.resolveElement({ ...ins, action: 'paste_file' })
          if (dropZone) {
            window.FieldAgentUtils.pasteFileIntoDropZone(dropZone, assetData)
          } else {
            const fileInput = document.querySelector('input[type="file"]')
            if (fileInput) {
              window.FieldAgentUtils.injectFile(fileInput, assetData)
            } else {
              console.warn('[FieldAgent] paste_file: no drop zone or file input found')
            }
          }
        } catch (err) {
          console.error('[FieldAgent] paste_file injection failed:', err)
        }

        watchForFormChange(preSnapshot)

        // Fallback: if the mutation observer doesn't detect the upload completion
        // (Pinterest may update via srcset / background-image / JS state only),
        // force a re-inspect after 10 s so FieldAgent never gets stuck here.
        clearTimeout(uploadFallbackTimer)
        uploadFallbackTimer = setTimeout(() => {
          if (!uploadJustCompleted) {
            console.log('[FieldAgent] paste_file: fallback timer — forcing re-inspect')
            uploadJustCompleted = true
            lastSnapshotUrl = null
            scheduleInspect(200)
          }
        }, 3_000)
        break
      } else if (ins.action === 'pick') {
        // Type text into a field, wait for the autocomplete dropdown, click first option.
        // Used for Pinterest tags: typing alone doesn't add the tag, you must pick from
        // the suggestions list. Tags are pre-validated server-side so a match will appear.
        const el = window.FieldAgentUtils.resolveElement({ ...ins, action: 'type' })
        if (el) {
          window.FieldAgentUtils.applyTextFill(el, ins.value)
          // Wait for autocomplete dropdown to populate
          await new Promise((r) => setTimeout(r, 700))
          const option = document.querySelector('[role="option"]')
          if (option) {
            option.click()
          } else {
            // Fallback: press Enter in case this specific field accepts it
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
          }
          // Brief pause before the next tag so the field resets
          await new Promise((r) => setTimeout(r, 300))
        }
      } else if (ins.action === 'attach_file') {
        const el = window.FieldAgentUtils.resolveElement(ins)
        if (el) await applyFileAttach(el, ins, taskId).catch(console.warn)
      } else {
        applyInstruction(ins)
        // After a click, pause so dropdowns/modals have time to open before
        // the next instruction runs (board picker needs ~300 ms to animate open).
        if (ins.action === 'click') {
          await new Promise((r) => setTimeout(r, 350))
        }
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

      // If the upload-completion watcher just fired, tell the LLM explicitly so
      // it doesn't re-issue paste_file. Consumed once per upload.
      if (uploadJustCompleted) {
        snapshot.upload_just_completed = true
        uploadJustCompleted = false
      }

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
        watchForSubmit()
        // After any non-paste instructions, schedule a follow-up inspect so
        // multi-step UI flows (board section picker, tag confirmation, etc.)
        // are caught in the next cycle rather than silently dropped.
        const hasNonFile = result.instructions.some(
          (i) => i.action !== 'paste_file' && i.action !== 'attach_file'
        )
        if (hasNonFile && !uploadJustCompleted) {
          lastSnapshotUrl = null
          scheduleInspect(1500)
        }
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
    // CDP file-chooser intercept completed — the upload finished. This is more
    // reliable than DOM diffing because it fires from the SW's debugger event
    // regardless of where Pinterest puts the preview image in the DOM.
    if (message.type === 'UPLOAD_DONE') {
      uploadJustCompleted = true
      lastSnapshotUrl = null
      scheduleInspect(600)
    }
  })

  // Single auto-inspect on page load (handles initial task acquisition)
  scheduleInspect(1000)

  console.log(`[FieldAgent] Content script active on ${platform}`)
})()
