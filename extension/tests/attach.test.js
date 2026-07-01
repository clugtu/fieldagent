/**
 * Story #15 — Extension: attach_file injects file via DataTransfer.
 *
 * Done when:
 * - resolveElement returns an input[type="file"] for attach_file instructions
 * - injectFile sets input.files[0] to the correct File object
 * - change event fires after injection
 */

const { resolveElement, injectFile } = require('../lib/dom-utils')

// jsdom doesn't implement DataTransfer — provide a minimal polyfill so the
// production code path (new DataTransfer / dt.items.add / dt.files) executes.
// jsdom's HTMLInputElement.files setter rejects non-FileList values, so the
// tests override it with Object.defineProperty to capture what was assigned.
class MockDataTransfer {
  constructor() {
    this._files = []
    this.items = {
      add: (file) => {
        this._files.push(file)
      },
    }
  }
  get files() {
    return this._files
  }
}
global.DataTransfer = MockDataTransfer

function makeFileInput() {
  document.body.innerHTML = `<input type="file" id="upload" />`
  const el = document.getElementById('upload')
  // Override the files setter so jsdom doesn't reject our mock FileList.
  let _files = null
  Object.defineProperty(el, 'files', {
    get: () => _files,
    set: (v) => { _files = v },
    configurable: true,
  })
  return el
}

describe('resolveElement – attach_file action', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  test('returns the file input when selector_hint matches', () => {
    document.body.innerHTML = `<input type="file" id="media-upload" />`
    const el = resolveElement({
      selector_hint: '#media-upload',
      fallback_hint: '',
      action: 'attach_file',
    })
    expect(el).not.toBeNull()
    expect(el.type).toBe('file')
  })

  test('falls back to first input[type=file] when selector misses', () => {
    document.body.innerHTML = `<input type="file" aria-label="Image" />`
    const el = resolveElement({
      selector_hint: '',
      fallback_hint: 'image upload',
      action: 'attach_file',
    })
    expect(el).not.toBeNull()
    expect(el.type).toBe('file')
  })

  test('returns null when no file input exists', () => {
    document.body.innerHTML = `<input type="text" />`
    const el = resolveElement({
      selector_hint: '',
      fallback_hint: 'media',
      action: 'attach_file',
    })
    expect(el).toBeNull()
  })
})

describe('injectFile', () => {
  test('sets input.files[0] to the decoded File and fires change', () => {
    const el = makeFileInput()

    const changeEvents = []
    el.addEventListener('change', () => changeEvents.push(1))

    injectFile(el, { base64: btoa('hello'), mimeType: 'image/jpeg', filename: 'photo.jpg' })

    const files = el.files
    expect(files).not.toBeNull()
    expect(files[0].name).toBe('photo.jpg')
    expect(files[0].type).toBe('image/jpeg')
    expect(changeEvents).toHaveLength(1)
  })

  test('file size matches original byte count', () => {
    const el = makeFileInput()

    const original = 'field-agent-test'
    injectFile(el, { base64: btoa(original), mimeType: 'text/plain', filename: 'note.txt' })

    expect(el.files[0].size).toBe(original.length)
  })
})
