import { syncGameView } from './app.js';

const home = document.querySelector('#home');
const player = document.querySelector('#play');
const launch = document.querySelector('#launch-game');
const status = document.querySelector('#status');
const canvas = document.querySelector('#screen');
const preview = document.querySelector('#preview-image');
const automate = new URLSearchParams(location.search).get('automate') === '1';

function showPreview() {
  preview.hidden = false;
  document.querySelector('#preview-caption').hidden = false;
}

if (preview.naturalWidth) showPreview();
else preview.addEventListener('load', showPreview, { once: true });

function showView() {
  const hash = location.hash;
  const playing = hash === '#play' || (!hash && automate);
  if (playing === !player.hidden) return;

  home.hidden = playing;
  player.hidden = !playing;

  if (playing) {
    window.scrollTo(0, 0);
    const target = status.dataset.state === 'error' ? document.querySelector('#retry') : canvas;
    target.focus({ preventScroll: true });
  } else {
    player.querySelector('dialog[open]')?.close();
    if (document.fullscreenElement === player) document.exitFullscreen().catch(() => {});
    if (status.dataset.state === 'ready') document.querySelector('#launch-label').textContent = 'Resume Game';

    if (hash === '#controls') {
      const controls = document.querySelector('#controls');
      controls.focus({ preventScroll: true });
      controls.scrollIntoView();
    } else {
      launch.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  syncGameView();
}

window.addEventListener('hashchange', showView);
showView();
