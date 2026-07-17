/**
 * findPublishedPinUrl — reads the real pin permalink off Pinterest's
 * post-publish "View Pin" link, since window.location.href is unreliable
 * (Pinterest often doesn't navigate away from the pin-builder page).
 */

const { findPublishedPinUrl } = require('../lib/dom-utils')

describe('findPublishedPinUrl', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  test('finds the pin URL from a "View Pin" link', () => {
    document.body.innerHTML = `
      <div class="toast">
        Your Pin was published!
        <a href="/pin/1234567890123/">View Pin</a>
      </div>
    `
    expect(findPublishedPinUrl()).toBe('http://localhost/pin/1234567890123/')
  })

  test('matches case-insensitively and with surrounding whitespace', () => {
    document.body.innerHTML = `<a href="https://www.pinterest.com/pin/999/">  View pin  </a>`
    expect(findPublishedPinUrl()).toBe('https://www.pinterest.com/pin/999/')
  })

  test('falls back to any pin-permalink anchor if no "View Pin" text matches', () => {
    document.body.innerHTML = `<a href="https://www.pinterest.com/pin/42/">See it live</a>`
    expect(findPublishedPinUrl()).toBe('https://www.pinterest.com/pin/42/')
  })

  test('ignores unrelated links and returns null when no pin URL exists', () => {
    document.body.innerHTML = `<a href="/pin-creation-tool/">Create another Pin</a>`
    expect(findPublishedPinUrl()).toBeNull()
  })

  test('returns null with no anchors on the page', () => {
    document.body.innerHTML = `<button>Publish</button>`
    expect(findPublishedPinUrl()).toBeNull()
  })
})
