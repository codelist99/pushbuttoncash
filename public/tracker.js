(() => {
  const params = new URLSearchParams(location.search);
  const keys = ['aid', 'tid', 'utm_source', 'utm_campaign'];
  const attribution = Object.fromEntries(keys.map(key => [key, params.get(key) || localStorage.getItem(`pbc_${key}`) || '']));
  Object.entries(attribution).forEach(([key, value]) => value && localStorage.setItem(`pbc_${key}`, value));
  let sessionId = sessionStorage.getItem('pbc_session_id');
  if (!sessionId) {
    sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('pbc_session_id', sessionId);
  }
  const context = { ...attribution, session_id:sessionId, device:innerWidth < 768 ? 'Mobile' : innerWidth < 1100 ? 'Tablet' : 'Desktop' };
  const send = (url, data) => fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(data), keepalive:true }).catch(() => {});
  send('/api/events', { type:'page_view', page:location.pathname, ...context });

  document.addEventListener('click', event => {
    const link = event.target.closest('[data-step2-webinar]');
    if (!link) return;
    send('/api/events', { type:'step2_webinar_click', page:location.pathname, product_id:link.href, ...context });
  }, true);

  if (location.pathname === '/checkout' || location.pathname === '/checkout.html') {
    let started = false;
    document.addEventListener('focusin', event => {
      if (!started && event.target.matches('input,select')) {
        started = true;
        send('/api/events', { type:'checkout_start', page:location.pathname, ...context });
      }
    }, true);
  }

  document.querySelectorAll('video').forEach(video => {
    const fired = new Set();
    const fire = type => {
      if (fired.has(type)) return;
      fired.add(type);
      send('/api/events', { type, page:location.pathname, ...context });
    };
    video.addEventListener('volumechange', () => !video.muted && video.volume > 0 && fire('video_unmute'));
    video.addEventListener('timeupdate', () => {
      if (!video.duration) return;
      const progress = video.currentTime / video.duration;
      if (progress >= .25) fire('video_25');
      if (progress >= .5) fire('video_50');
      if (progress >= .75) fire('video_75');
      if (progress >= .98) fire('video_100');
    });
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    const email = data.email || data.Email || form.querySelector('input[type=email]')?.value;
    const phone = data.phone || data.Phone || form.querySelector('input[type=tel]')?.value;
    if (!email && !phone) return;
    send('/api/leads', { ...data, email, phone, landing_page:location.pathname, ...attribution });
  }, true);
})();
