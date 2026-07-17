/**
 * findViewPinAction — locates the clickable action inside Pinterest's
 * "Your Pin has been published!" toast. Confirmed against the live site:
 * it's an <a href="/pin/<id>"> whose visible text is just "View" (aria-label
 * "Navigate to created Pin"), scoped inside a [data-test-id="toast"]
 * container — so the match is on the toast + "published" text, not the
 * action's own (Pinterest-controlled, renameable) label.
 */

const { findViewPinAction } = require('../lib/dom-utils')

describe('findViewPinAction', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  test('finds the action inside the real toast markup', () => {
    document.body.innerHTML = `
      <div aria-label="Toast notification" data-toast-id="toast0" role="region">
        <div data-test-id="toast">
          <span>Your Pin has been published!</span>
          <a aria-label="Navigate to created Pin" href="/pin/1151725304734484837">
            <div>View</div>
          </a>
        </div>
      </div>
    `
    const el = findViewPinAction()
    expect(el.tagName).toBe('A')
    expect(el.getAttribute('href')).toBe('/pin/1151725304734484837')
  })

  test('ignores a toast hidden inside an aria-hidden container', () => {
    document.body.innerHTML = `
      <div aria-hidden="true">
        <div data-test-id="toast">
          Your Pin has been published!
          <a href="/pin/123">View</a>
        </div>
      </div>
    `
    expect(findViewPinAction()).toBeNull()
  })

  test('ignores a toast with unrelated text', () => {
    document.body.innerHTML = `
      <div data-test-id="toast">
        Upload complete
        <a href="/pin/123">View</a>
      </div>
    `
    expect(findViewPinAction()).toBeNull()
  })

  test('falls back to a broad text match if the toast wrapper is missing', () => {
    document.body.innerHTML = `<a href="/pin/1234567890123/">View Pin</a>`
    expect(findViewPinAction().getAttribute('href')).toBe('/pin/1234567890123/')
  })

  test('falls back via aria-label when no toast wrapper and label lacks "view pin"', () => {
    document.body.innerHTML = `<a aria-label="Navigate to created Pin" href="/pin/42/">View</a>`
    expect(findViewPinAction().getAttribute('href')).toBe('/pin/42/')
  })

  test('returns null when nothing matches', () => {
    document.body.innerHTML = `<button>Create another Pin</button>`
    expect(findViewPinAction()).toBeNull()
  })
})
