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

  // ─── URL-lock + post-publish navigation ─────────────────────────────────────
  // Each task is locked to the URL where it was first inspected.  This prevents
  // the agent from running on unrelated pages (pin detail pages, other forms,
  // etc.) after SPA navigation.  One exception: when the user clicks Publish,
  // we allow one post-navigate inspect on the resulting page so the LLM can
  // detect the success state and auto-close the task.

  let taskStartUrl = null        // locked when the first inspect for this task runs
  let allowPostNavInspect = false  // lifted once after the user clicks Publish

  // Reset per-task state when the active task changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('activeTask' in changes)) return
    const prev = changes.activeTask?.oldValue
    const next = changes.activeTask?.newValue
    if (!next || (prev && prev.task_id !== next.task_id)) {
      taskStartUrl = null
      allowPostNavInspect = false
      chrome.storage.local.remove('lastInspectResult').catch(() => {})
    }
  })

  // Intercept SPA navigation (Pinterest uses history.pushState, not page loads).
  // When Publish triggers a navigate, do one final inspect to detect success.
  const _origPush = history.pushState.bind(history)
  history.pushState = function (...args) {
    _origPush(...args)
    if (allowPostNavInspect) {
      allowPostNavInspect = false
      lastSnapshotUrl = null
      scheduleInspect(800)
    }
  }
  window.addEventListener('popstate', () => {
    if (allowPostNavInspect) {
      allowPostNavInspect = false
      lastSnapshotUrl = null
      scheduleInspect(800)
    }
  })

  // Detect the Publish button click so we can allow one post-navigate inspect.
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest('button, [role="button"]')
    if (!btn) return
    const text = (btn.textContent?.trim() || btn.getAttribute('aria-label') || '').toLowerCase()
    if (text === 'publish' || text === 'post') {
      allowPostNavInspect = true
      // Fallback: if Pinterest stays on the same URL (no pushState), inspect in
      // place after 4 s to catch success banners.
      setTimeout(() => {
        if (allowPostNavInspect) {
          allowPostNavInspect = false
          lastSnapshotUrl = null
          scheduleInspect(200)
        }
      }, 4000)
    }
  }, true)

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

  // ─── Event-driven waiting ───────────────────────────────────────────────────
  // Wait until a CSS selector matches something in the DOM, or maxWait ms pass.
  // Resolves with the element (or null on timeout). Faster and more robust than
  // fixed sleeps because it fires the moment the element actually appears.

  function waitForElement(selector, maxWait = 3000) {
    // Like document.querySelector but skips elements inside aria-hidden containers
    // (inactive Pinterest draft panels, hidden sidebars) so we find the visible one.
    function findVisible() {
      for (const el of document.querySelectorAll(selector)) {
        if (!el.closest('[aria-hidden="true"]')) return el
      }
      return null
    }
    return new Promise((resolve) => {
      const existing = findVisible()
      if (existing) { resolve(existing); return }
      const obs = new MutationObserver(() => {
        const el = findVisible()
        if (el) { obs.disconnect(); resolve(el) }
      })
      obs.observe(document.body, { childList: true, subtree: true })
      setTimeout(() => { obs.disconnect(); resolve(findVisible()) }, maxWait)
    })
  }

  // Wait until resolveElement can find the instruction's target.
  // Used after a click opens a dropdown whose contents aren't in the DOM yet.
  // Preserves the original action so action-specific guards (e.g. the
  // isContentEditable skip for click actions) remain in effect while waiting.
  function waitForTarget(ins, maxWait = 1500) {
    return new Promise((resolve) => {
      const existing = window.FieldAgentUtils.resolveElement(ins)
      if (existing) { resolve(existing); return }
      const obs = new MutationObserver(() => {
        const el = window.FieldAgentUtils.resolveElement(ins)
        if (el) { obs.disconnect(); resolve(el) }
      })
      // Include attribute changes: Pinterest toggles visibility via class/style
      // rather than add/remove elements, so childList alone misses the transition.
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] })
      setTimeout(() => { obs.disconnect(); resolve(window.FieldAgentUtils.resolveElement(ins)) }, maxWait)
    })
  }

  // ─── User-change detection ──────────────────────────────────────────────────
  // When the user manually types or interacts with the page (outside our
  // instruction application), re-inspect so MiniForge stays in sync.

  let applyingInstructions = false

  document.addEventListener('input', () => {
    if (applyingInstructions) return
    lastSnapshotUrl = null
    scheduleInspect(1200)
  }, true) // capture phase — sees events before React

  // ─── Apply instructions ─────────────────────────────────────────────────────

  async function applyInstructions(instructions, taskId) {
    applyingInstructions = true
    try {
    for (const ins of instructions) {
      console.log(`[FieldAgent] exec: ${ins.action} | sel="${ins.selector_hint || ''}" hint="${ins.fallback_hint || ''}" val=${JSON.stringify(ins.value || '')}`)
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
        // Type text into a field, wait for autocomplete, click first option.
        // If the target isn't in the DOM yet (e.g. board search inside a just-opened
        // dropdown), waitForTarget waits until a DOM mutation makes it findable.
        const el = await waitForTarget(ins, 1500)
        if (el) {
          const valueLC = (ins.value || '').toLowerCase()

          // Find the first visible option whose text starts with the target value.
          // startsWith rather than includes: avoids matching "BoardMiniatures" or
          // "Werewolf Miniatures" when searching for "Miniatures".
          // Also includes [role="button"] because Pinterest renders board-picker
          // results as role="button" divs, not role="option".
          function findMatchingOption() {
            const pool = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="button"]'))
              .filter((c) => !c.closest('[aria-hidden="true"]'))
            console.log(
              `[FieldAgent] pick: findMatchingOption pool=${pool.length} for "${valueLC}":`,
              pool.slice(0, 8).map((c) => `${c.tagName}[${c.getAttribute('role')||''}] "${(c.textContent?.trim()||'').slice(0,30)}"`)
            )
            for (const candidate of pool) {
              const txt = (candidate.textContent?.trim() || '').toLowerCase()
              if (txt.startsWith(valueLC)) return candidate
            }
            return null
          }

          // Wait (event-driven, max 800ms) for a MATCHING option to appear in
          // the picker's default list. Using waitForElement (any option) resolved
          // too early on stale hidden elements; we want the matching one specifically.
          function waitForMatchingOption(maxWait) {
            return new Promise((resolve) => {
              const existing = findMatchingOption()
              if (existing) { resolve(existing); return }
              const obs = new MutationObserver(() => {
                const found = findMatchingOption()
                if (found) { obs.disconnect(); clearTimeout(timer); resolve(found) }
              })
              obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'aria-hidden'] })
              const timer = setTimeout(() => { obs.disconnect(); resolve(null) }, maxWait)
            })
          }

          let option = await waitForMatchingOption(800)

          if (!option) {
            // Default list didn't have a match; type to trigger autocomplete.
            window.FieldAgentUtils.applyTextFill(el, ins.value)
            option = await waitForMatchingOption(3000)
          }

          if (option) {
            console.log(`[FieldAgent] pick: clicking option text="${(option.textContent?.trim() || '').slice(0, 60)}"`)
            // Full pointer sequence — some React handlers listen on mousedown, not click.
            option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
            option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
            option.click()
          } else {
            // Keyboard fallback: Down to highlight the first item, Enter to confirm.
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }))
            await new Promise((r) => setTimeout(r, 80))
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }))
          }
          // Longer settle wait: picker needs time to dismiss autocomplete and show
          // the selected board row (which may contain the section chevron).
          await new Promise((r) => setTimeout(r, 1000))
          const postPickButtons = Array.from(document.querySelectorAll(
            '[role="option"] button, [role="option"] [role="button"], [role="listbox"] button, [role="listbox"] [role="button"]'
          ))
            .filter((b) => !b.closest('[aria-hidden="true"]'))
            .map((b) => `aria="${b.getAttribute('aria-label') || ''}" txt="${(b.textContent?.trim() || '').slice(0, 20)}"`)
          console.log(`[FieldAgent] pick: post-click buttons in picker: [${postPickButtons.join(', ')}]`)
        }
      } else if (ins.action === 'click') {
        // Try immediately; if the element isn't in the DOM yet (e.g. a section
        // picker that appears after the board pick above), wait up to 2 s for a
        // DOM mutation that makes it findable.  This lets the LLM emit board +
        // section click instructions in one response instead of needing a second
        // inspect pass.
        let el = window.FieldAgentUtils.resolveElement(ins)
        if (!el) el = await waitForTarget(ins, 2000)
        const hint = ins.fallback_hint || ''
        if (el) {
          console.log(`[FieldAgent] click: found el tag=${el.tagName} aria="${el.getAttribute('aria-label') || ''}" txt="${(el.textContent?.trim() || '').slice(0, 40)}"`)
          el.click()
        } else {
          // Log what was available so we can diagnose the missing selector.
          const sel = ins.selector_hint || ''
          const available = Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], [role="listitem"]'))
            .map((b) => `<${b.tagName.toLowerCase()} aria-label="${b.getAttribute('aria-label') || ''}" text="${(b.textContent?.trim() || '').slice(0, 40)}">`)
            .slice(0, 20)
          console.warn(
            `[FieldAgent] click: element not found | selector="${sel}" fallback="${hint}"\n`,
            'Available buttons/options:', available,
          )
        }
        // After any chevron/section click attempt (found or not), log visible
        // section candidates — sections appear here whether or not we clicked ">".
        if (hint === '>' || hint.includes('chevron')) {
          await new Promise((r) => setTimeout(r, 800))
          const sectionItems = Array.from(document.querySelectorAll('[role="option"], [role="listitem"], [role="menuitem"], li'))
            .filter((e) => !e.closest('[aria-hidden="true"]'))
            .map((e) => `txt="${(e.textContent?.trim() || '').slice(0, 30)}" role="${e.getAttribute('role')}" tag="${e.tagName}"`)
          console.log(`[FieldAgent] click: after '>' — section candidates: [${sectionItems.slice(0, 15).join(', ')}]`)
        }
      } else if (ins.action === 'attach_file') {
        const el = window.FieldAgentUtils.resolveElement(ins)
        if (el) await applyFileAttach(el, ins, taskId).catch(console.warn)
      } else {
        applyInstruction(ins)
      }
    }
    } finally {
      applyingInstructions = false
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

      // URL-lock: only inspect the page where the task originally started.
      // This prevents the agent from running fill instructions on pin detail
      // pages, other forms, etc. after SPA navigation.
      // allowPostNavInspect lifts the lock once after the Publish button is clicked.
      const currentUrl = window.location.href
      if (!taskStartUrl) {
        taskStartUrl = currentUrl
      } else if (currentUrl !== taskStartUrl) {
        if (!allowPostNavInspect) return
        allowPostNavInspect = false
        // This is the one post-publish inspect — let it through unchanged.
      }

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

      // Notify side panel so it can display the instructions; also persist so
      // the panel can restore history when reopened mid-task.
      chrome.runtime.sendMessage({ type: 'INSTRUCTIONS_UPDATE', payload: result }).catch(() => {})
      chrome.storage.local.set({ lastInspectResult: { taskId: task.task_id, payload: result } }).catch(() => {})

      // Apply instructions to the page
      if (result?.instructions?.length) {
        await applyInstructions(result.instructions, task.task_id)
        // No automatic re-inspect here — re-inspection only happens from:
        //  • user input events (user typed/clicked something on the page)
        //  • upload completion (watchForFormChange / UPLOAD_DONE)
        //  • Publish button click (allowPostNavInspect flow)
        //  • user clicking Re-inspect in the panel
        // Automatic cycling risks filling the wrong draft in Pinterest's sidebar.
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
