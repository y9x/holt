// holt loader: the one script a platform page includes to embed the chatbox.
//
//   <script src="https://holt.example.com/holt-embed.js"></script>
//   <script>
//     Holt.mount({
//       origin: 'https://holt.example.com',
//       platform: 'nocturne',
//       container: document.getElementById('chat'),
//       // Your backend mints a short-lived identity token for the signed-in user (see docs/PLAN.md,
//       // "Identity tokens"). Resolve null for a guest.
//       getToken: () => fetch('/api/holt-token', { credentials: 'include' }).then((r) => (r.ok ? r.text() : null)),
//     })
//   </script>
//
// Messages are accepted only from the holt origin and only from this frame's window. A `navigate`
// message carries one of the platform's configured links; the host goes there with the top page.
// Pass `navigate(target, url)` to handle it yourself (for example a client-side router).
(function () {
  'use strict'
  var PROTOCOL = 1
  // The same rule platforms.ts applies to a platform's links: https, or http on localhost for development.
  var NAVIGABLE = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/

  function mount(options) {
    if (!options || typeof options.origin !== 'string' || !/^https?:\/\/[^/]+$/.test(options.origin)) throw new Error('Holt.mount: origin must be an absolute origin')
    if (typeof options.platform !== 'string' || !options.platform) throw new Error('Holt.mount: platform is required')
    if (!options.container || typeof options.container.appendChild !== 'function') throw new Error('Holt.mount: container must be an element')
    var getToken = typeof options.getToken === 'function' ? options.getToken : function () { return Promise.resolve(null) }
    var origin = options.origin
    var frame = document.createElement('iframe')
    frame.src = origin + '/embed?platform=' + encodeURIComponent(options.platform)
    frame.title = options.title || 'Chat'
    frame.setAttribute('allow', 'clipboard-write')
    frame.style.border = '0'
    frame.style.width = '100%'
    frame.style.height = options.height || '600px'
    frame.style.display = 'block'
    options.container.appendChild(frame)

    function post(message) {
      if (frame.contentWindow) frame.contentWindow.postMessage(message, origin)
    }

    function sendToken() {
      return Promise.resolve()
        .then(getToken)
        .then(function (token) { post({ holt: PROTOCOL, type: 'token', token: typeof token === 'string' && token ? token : null }) })
        .catch(function () { post({ holt: PROTOCOL, type: 'token', token: null }) })
    }

    function onMessage(event) {
      if (event.origin !== origin || event.source !== frame.contentWindow) return
      var data = event.data
      if (!data || data.holt !== PROTOCOL || typeof data.type !== 'string') return
      if (data.type === 'ready' || data.type === 'token-expired') sendToken()
      else if (data.type === 'navigate' && typeof data.url === 'string' && NAVIGABLE.test(data.url)) {
        if (typeof options.navigate === 'function') options.navigate(data.target, data.url)
        else window.location.assign(data.url)
      } else if (data.type === 'resize' && typeof data.height === 'number' && data.height > 0 && !options.height) {
        frame.style.height = Math.ceil(data.height) + 'px'
      }
    }
    window.addEventListener('message', onMessage)

    return {
      iframe: frame,
      refreshToken: sendToken,
      destroy: function () {
        window.removeEventListener('message', onMessage)
        if (frame.parentNode) frame.parentNode.removeChild(frame)
      },
    }
  }

  window.Holt = { mount: mount, protocol: PROTOCOL }
})()
