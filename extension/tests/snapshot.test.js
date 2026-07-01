/**
 * Story #8 — Content script: DOM snapshot extraction.
 */

const { extractSnapshot } = require('../lib/dom-utils')

describe('extractSnapshot', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.title = 'Create Pin | Pinterest'
  })

  test('captures visible inputs with label and placeholder', () => {
    document.body.innerHTML = `
      <label for="pin-title">Title</label>
      <input id="pin-title" type="text" placeholder="Add a title" aria-label="Title" />
      <textarea aria-label="Description" placeholder="Tell everyone what your Pin is about"></textarea>
      <button type="submit">Publish</button>
      <h1>Create Pin</h1>
    `
    const snap = extractSnapshot('pinterest')

    expect(snap.platform_hint).toBe('pinterest')
    expect(snap.inputs).toHaveLength(2)

    const titleInput = snap.inputs[0]
    expect(titleInput.tag).toBe('input')
    expect(titleInput.placeholder).toBe('Add a title')
    expect(titleInput.aria_label).toBe('Title')
    expect(titleInput.label_text).toBe('Title')

    const descInput = snap.inputs[1]
    expect(descInput.tag).toBe('textarea')
    expect(descInput.aria_label).toBe('Description')
  })

  test('excludes hidden inputs', () => {
    document.body.innerHTML = `
      <input type="hidden" name="csrf" value="abc123" />
      <input type="text" placeholder="Visible field" />
    `
    const snap = extractSnapshot('pinterest')
    expect(snap.inputs).toHaveLength(1)
    expect(snap.inputs[0].placeholder).toBe('Visible field')
  })

  test('captures buttons with text and disabled state', () => {
    document.body.innerHTML = `
      <button type="submit">Publish</button>
      <button type="button" disabled>Cancel</button>
    `
    const snap = extractSnapshot('pinterest')
    expect(snap.buttons).toHaveLength(2)
    expect(snap.buttons[0].text).toBe('Publish')
    expect(snap.buttons[0].disabled).toBe(false)
    expect(snap.buttons[1].text).toBe('Cancel')
    expect(snap.buttons[1].disabled).toBe(true)
  })

  test('captures h1–h3 headings', () => {
    document.body.innerHTML = `<h1>Create Pin</h1><h2>Details</h2><h3>Board</h3>`
    const snap = extractSnapshot('pinterest')
    expect(snap.headings).toEqual(['Create Pin', 'Details', 'Board'])
  })

  test('captures current value of a pre-filled input', () => {
    document.body.innerHTML = `<input type="text" value="Existing title" />`
    const snap = extractSnapshot('generic')
    expect(snap.inputs[0].current_value).toBe('Existing title')
  })

  test('returns empty arrays when page has no relevant elements', () => {
    document.body.innerHTML = `<p>Just a paragraph</p>`
    const snap = extractSnapshot('generic')
    expect(snap.inputs).toHaveLength(0)
    expect(snap.buttons).toHaveLength(0)
    expect(snap.headings).toHaveLength(0)
  })
})
