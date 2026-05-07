/* coi-serviceworker v0.1.7 — https://github.com/gzuidhof/coi-serviceworker */
(function() {
  const coiSW = {
    quiet: false,
    doReload() { window.location.reload(); },

    register() {
      if (!window.crossOriginIsolated && 'serviceWorker' in navigator) {
        navigator.serviceWorker
          .register(window.location.pathname.endsWith('/')
            ? './coi-serviceworker.js'
            : './coi-serviceworker.js')
          .then(reg => {
            if (!coiSW.quiet) console.log('[COI-SW] Registered:', reg.scope);
            reg.addEventListener('updatefound', () => {
              reg.installing?.addEventListener('statechange', (e) => {
                if (e.target.state === 'activated') coiSW.doReload();
              });
            });
            if (reg.active && !window.crossOriginIsolated) coiSW.doReload();
          })
          .catch(e => console.error('[COI-SW] Registration failed:', e));
      }
    }
  };

  if (typeof window === 'undefined') {
    // Service worker context
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => {
      if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
      e.respondWith(
        fetch(e.request).then(r => {
          if (r.status === 0) return r;
          const h = new Headers(r.headers);
          h.set('Cross-Origin-Opener-Policy', 'same-origin');
          h.set('Cross-Origin-Embedder-Policy', 'require-corp');
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
        })
      );
    });
  } else {
    coiSW.register();
  }
})();
