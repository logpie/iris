export const CURSOR_OVERLAY_INIT_SCRIPT = String.raw`
(() => {
  const ID = 'iris-recording-cursor-overlay';
  if (globalThis.__irisRecordingCursorInstalled) return;
  globalThis.__irisRecordingCursorInstalled = true;

  const state = {
    x: -9999,
    y: -9999,
    visible: false,
    lastTrailTs: 0,
    lastTrailX: -9999,
    lastTrailY: -9999,
  };
  let cursor;
  let pulse;

  const ensure = () => {
    if (cursor && cursor.isConnected) return cursor;
    const root = document.documentElement;
    if (!root) return null;

    cursor = document.createElement('div');
    cursor.id = ID;
    cursor.setAttribute('data-iris-recording-cursor', 'true');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = [
      'position: fixed',
      'left: 0',
      'top: 0',
      'width: 28px',
      'height: 34px',
      'pointer-events: none',
      'z-index: 2147483647',
      'opacity: 0',
      'transform: translate(-9999px, -9999px)',
      'transition: opacity 80ms linear',
      'filter: drop-shadow(0 2px 3px rgba(0,0,0,0.45))',
    ].join(';');
    cursor.innerHTML = '<svg data-iris-recording-cursor-shape="true" viewBox="0 0 28 34" width="28" height="34" aria-hidden="true" focusable="false"><path d="M3 2.5v25.2l7.1-6.6 4.5 10.7 5.2-2.2-4.5-10.3h9.9L3 2.5z" fill="white" stroke="rgba(0,0,0,0.9)" stroke-width="2" stroke-linejoin="round"/><path d="M6.2 9.5v10.6l3.7-3.4 5.9 13.8 1.9-.8-5.9-13.7h5.7L6.2 9.5z" fill="rgba(0,0,0,0.82)"/></svg>';

    pulse = document.createElement('div');
    pulse.setAttribute('data-iris-recording-cursor-pulse', 'true');
    pulse.style.cssText = [
      'position: absolute',
      'left: 2px',
      'top: 2px',
      'width: 30px',
      'height: 30px',
      'margin-left: -15px',
      'margin-top: -15px',
      'border: 2px solid rgba(0,0,0,0.65)',
      'border-radius: 999px',
      'opacity: 0',
      'transform: scale(0.4)',
      'pointer-events: none',
    ].join(';');
    cursor.appendChild(pulse);
    root.appendChild(cursor);
    render();
    return cursor;
  };

  const render = () => {
    const el = ensure();
    if (!el) return;
    el.style.opacity = state.visible ? '1' : '0';
    el.style.transform = 'translate(' + state.x + 'px, ' + state.y + 'px)';
  };

  const addTrailPoint = (x, y) => {
    const root = document.documentElement;
    if (!root) return;
    const point = document.createElement('div');
    point.setAttribute('data-iris-recording-cursor-trail', 'true');
    point.style.cssText = [
      'position: fixed',
      'left: ' + x + 'px',
      'top: ' + y + 'px',
      'width: 7px',
      'height: 7px',
      'margin-left: -3px',
      'margin-top: -3px',
      'border: 1px solid rgba(255,255,255,0.85)',
      'border-radius: 999px',
      'background: rgba(0,0,0,0.42)',
      'box-shadow: 0 1px 3px rgba(0,0,0,0.28)',
      'pointer-events: none',
      'z-index: 2147483646',
    ].join(';');
    root.appendChild(point);
    point.animate(
      [
        { opacity: 0.58, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.45)' },
      ],
      { duration: 650, easing: 'ease-out' },
    );
    setTimeout(() => point.remove(), 700);
  };

  const clickPulse = () => {
    ensure();
    if (!pulse) return;
    pulse.animate(
      [
        { opacity: 0.95, transform: 'scale(0.35)' },
        { opacity: 0, transform: 'scale(1.35)' },
      ],
      { duration: 360, easing: 'ease-out' },
    );
  };

  addEventListener(
    'mousemove',
    (event) => {
      state.x = event.clientX;
      state.y = event.clientY;
      state.visible = true;
      const now = performance.now();
      const dx = event.clientX - state.lastTrailX;
      const dy = event.clientY - state.lastTrailY;
      const movedFarEnough = Math.sqrt(dx * dx + dy * dy) >= 18;
      if (now - state.lastTrailTs > 45 || movedFarEnough) {
        state.lastTrailTs = now;
        state.lastTrailX = event.clientX;
        state.lastTrailY = event.clientY;
        addTrailPoint(event.clientX, event.clientY);
      }
      render();
    },
    true,
  );
  addEventListener('mousedown', clickPulse, true);
  addEventListener('click', clickPulse, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure, { once: true });
  } else {
    ensure();
  }
})();
`;
