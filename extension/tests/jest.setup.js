/**
 * jsdom doesn't implement layout, so `offsetParent` always returns null
 * regardless of real visibility (see jsdom/jsdom#1670 — this is documented,
 * intentional non-support). dom-utils.js's resolveElement() uses
 * `offsetParent === null` as its real-browser visibility check (skip
 * aria-hidden/display:none candidates), which is correct in a real browser
 * but makes every element in a jsdom test look hidden, so resolveElement
 * always returned null.
 *
 * Stub it to a reasonable jsdom approximation: elements actually attached to
 * the document report a non-null offsetParent (as any plain visible element
 * would in a real browser); detached elements still report null.
 */
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() {
    return this.isConnected ? document.body : null
  },
})
