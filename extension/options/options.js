const urlInput = document.getElementById('serviceUrl')
const keyInput = document.getElementById('apiKey')
const savedMsg = document.getElementById('saved-msg')

chrome.storage.sync.get(['serviceUrl', 'apiKey'], ({ serviceUrl, apiKey }) => {
  if (serviceUrl) urlInput.value = serviceUrl
  if (apiKey) keyInput.value = apiKey
})

document.getElementById('save').addEventListener('click', () => {
  let url = urlInput.value.trim().replace(/\/$/, '')
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url
    urlInput.value = url
  }
  chrome.storage.sync.set(
    { serviceUrl: url, apiKey: keyInput.value.trim() },
    () => {
      savedMsg.style.display = 'block'
      setTimeout(() => { savedMsg.style.display = 'none' }, 2000)
    }
  )
})
