export const CURSOR_OVERLAY_INIT_SCRIPT = String.raw`
(() => {
  const ID = 'iris-recording-cursor-overlay';
  if (globalThis.__irisRecordingCursorInstalled) return;
  globalThis.__irisRecordingCursorInstalled = true;

  const state = { x: -9999, y: -9999, visible: false };
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
      'width: 14px',
      'height: 14px',
      'border: 2px solid white',
      'border-radius: 999px',
      'background: rgba(9,105,218,0.92)',
      'box-shadow: 0 0 0 1px rgba(0,0,0,0.75), 0 2px 8px rgba(0,0,0,0.35)',
      'pointer-events: none',
      'z-index: 2147483647',
      'opacity: 0',
      'transform: translate(-9999px, -9999px)',
      'transition: opacity 80ms linear',
    ].join(';');

    pulse = document.createElement('div');
    pulse.setAttribute('data-iris-recording-cursor-pulse', 'true');
    pulse.style.cssText = [
      'position: absolute',
      'left: 50%',
      'top: 50%',
      'width: 30px',
      'height: 30px',
      'margin-left: -15px',
      'margin-top: -15px',
      'border: 2px solid rgba(9,105,218,0.75)',
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
    el.style.transform = 'translate(' + (state.x - 7) + 'px, ' + (state.y - 7) + 'px)';
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
