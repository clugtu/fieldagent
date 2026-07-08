/**
 * Story #9 — Content script: applyInstruction fills fields and fires events.
 */

const { applyInstruction, resolveElement } = require('../lib/dom-utils')

describe('resolveElement', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  test('resolves by CSS selector_hint', () => {
    document.body.innerHTML = `<textarea aria-label="Description"></textarea>`
    const el = resolveElement({
      selector_hint: "textarea[aria-label='Description']",
      fallback_hint: '',
      action: 'type',
    })
    expect(el).not.toBeNull()
    expect(el.tagName).toBe('TEXTAREA')
  })

  test('falls back to keyword matching on aria-label', () => {
    document.body.innerHTML = `<input aria-label="Title" type="text" />`
    const el = resolveElement({
      selector_hint: '',
      fallback_hint: 'title',
      action: 'type',
    })
    expect(el).not.toBeNull()
  })

  test('requires ALL long words in hint to match (prevents ambiguous fallback)', () => {
    // Board search input not in DOM yet, tag input has "search" but not "board".
    // Only the board search input — once it appears — should match.
    document.body.innerHTML = `
      <input id="tag-search" placeholder="Search for a tag" type="text" />
      <input id="board-search" placeholder="Search for a board" type="text" />
    `
    const el = resolveElement({
      selector_hint: '',
      fallback_hint: 'Search for a board',
      action: 'type',
    })
    expect(el).not.toBeNull()
    expect(el.id).toBe('board-search')
  })

  test('falls back to keyword matching on placeholder', () => {
    document.body.innerHTML = `<textarea placeholder="Tell everyone what your Pin is about"></textarea>`
    const el = resolveElement({
      selector_hint: '',
      fallback_hint: 'tell everyone about',
      action: 'type',
    })
    expect(el).not.toBeNull()
    expect(el.tagName).toBe('TEXTAREA')
  })

  test('returns null when no element matches', () => {
    document.body.innerHTML = `<p>No inputs here</p>`
    const el = resolveElement({ selector_hint: '', fallback_hint: 'title', action: 'type' })
    expect(el).toBeNull()
  })
})

describe('applyInstruction – type action', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  test('sets value on a text input and fires input + change events', () => {
    document.body.innerHTML = `<input id="pin-title" type="text" aria-label="Title" />`
    const el = document.getElementById('pin-title')

    const inputEvents = []
    const changeEvents = []
    el.addEventListener('input', () => inputEvents.push(1))
    el.addEventListener('change', () => changeEvents.push(1))

    const result = applyInstruction({
      selector_hint: '#pin-title',
      fallback_hint: 'title',
      value: 'Bog Witch',
      action: 'type',
    })

    expect(result).toBe(true)
    expect(el.value).toBe('Bog Witch')
    expect(inputEvents).toHaveLength(1)
    expect(changeEvents).toHaveLength(1)
  })

  test('sets value on a textarea', () => {
    document.body.innerHTML = `<textarea aria-label="Description"></textarea>`
    applyInstruction({
      selector_hint: "textarea[aria-label='Description']",
      fallback_hint: 'description',
      value: 'A haunting folk horror figure.',
      action: 'type',
    })
    expect(document.querySelector('textarea').value).toBe('A haunting folk horror figure.')
  })

  test('returns false when element cannot be resolved', () => {
    document.body.innerHTML = `<p>No inputs</p>`
    const result = applyInstruction({
      selector_hint: '#nonexistent',
      fallback_hint: 'some field',
      value: 'test',
      action: 'type',
    })
    expect(result).toBe(false)
  })
})

describe('applyInstruction – select action', () => {
  test('sets value on a select element and fires change', () => {
    document.body.innerHTML = `
      <select id="board">
        <option value="folk-horror">Folk Horror</option>
        <option value="miniatures">Miniatures</option>
      </select>
    `
    const el = document.getElementById('board')
    const changeEvents = []
    el.addEventListener('change', () => changeEvents.push(1))

    applyInstruction({
      selector_hint: '#board',
      fallback_hint: 'board select',
      value: 'miniatures',
      action: 'select',
    })

    expect(el.value).toBe('miniatures')
    expect(changeEvents).toHaveLength(1)
  })
})
