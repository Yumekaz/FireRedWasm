const STORAGE_KEY = 'pokefirered.frontend.keys.v1';
const actions = [
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['a', 'A button'], ['b', 'B button'], ['start', 'Start'], ['select', 'Select'],
  ['l', 'L button'], ['r', 'R button'],
];
const common = {
  a: ['KeyZ', 'KeyJ'], b: ['KeyX', 'KeyK'], start: ['Enter'],
  select: ['Backspace', 'ShiftLeft', 'ShiftRight'],
};
const presets = {
  arrows: {
    ...common, up: ['ArrowUp', 'KeyW'], down: ['ArrowDown'], left: ['ArrowLeft'],
    right: ['ArrowRight', 'KeyD'], l: ['KeyA', 'KeyQ'], r: ['KeyS', 'KeyE'],
  },
  wasd: {
    ...common, up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], l: ['KeyQ'], r: ['KeyE'],
  },
};
const labels = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', Space: 'Space', Backspace: 'Bksp',
};

function keyLabel(code) {
  return labels[code] ?? code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ');
}

function bindable(code) {
  return typeof code === 'string' && code !== 'KeyF' &&
    /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Enter|Space|Backspace|Shift(Left|Right)|Numpad[0-9])$/.test(code);
}

export function installInput({ canvas, dialog, ready, setPressed, clearState, toggleFullscreen }) {
  const layoutMenu = document.querySelector('#keyboard-layout');
  const feedback = document.querySelector('#binding-feedback');
  const bindingList = document.querySelector('#bindings');
  const held = new Map();
  const bindingButtons = new Map();
  const custom = new Map();
  let mode = 'auto';
  let layout = 'arrows';
  let capturing;

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (['auto', 'arrows', 'wasd'].includes(saved?.mode)) mode = saved.mode;
    for (const [action] of actions) {
      const code = saved?.bindings?.[action];
      if (bindable(code) && ![...custom.values()].includes(code)) custom.set(action, code);
    }
  } catch {
    // Keep the original key bindings when preferences are unavailable.
  }
  if (mode !== 'auto') layout = mode;

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, bindings: Object.fromEntries(custom) }));
    } catch {
      feedback.textContent = 'Keys are saved for this tab only.';
    }
  }

  function keysFor(action, preset = layout) {
    return custom.has(action) ? [custom.get(action)] : presets[preset][action];
  }

  function actionFor(code, preset) {
    const override = [...custom].find(([, value]) => value === code);
    if (override) return override[0];
    return actions.find(([action]) => !custom.has(action) && presets[preset][action].includes(code))?.[0];
  }

  function showBindings() {
    layoutMenu.value = mode;
    for (const [action, label] of actions) {
      const button = bindingButtons.get(action);
      const keys = keysFor(action).map(keyLabel).join(' / ');
      button.classList.toggle('capturing', action === capturing);
      button.textContent = action === capturing ? 'Press a key' : keys;
      button.setAttribute('aria-label', `Rebind ${label} (${keys})`);
    }
    document.querySelector('#move-keys').textContent =
      ['up', 'left', 'down', 'right'].map(action => keyLabel(keysFor(action)[0])).join(' ');
    for (const [id, action] of [['confirm-key', 'a'], ['back-key', 'b'], ['start-key', 'start']]) {
      document.getElementById(id).textContent = keyLabel(keysFor(action)[0]);
    }
  }

  function cancelCapture() {
    if (!capturing) return;
    capturing = undefined;
    feedback.textContent = '';
    showBindings();
  }

  function clear() {
    held.clear();
    clearState();
  }

  function press(source, action) {
    if (held.has(source)) return;
    const alreadyHeld = [...held.values()].includes(action);
    held.set(source, action);
    if (!alreadyHeld) setPressed(action, true);
  }

  function release(source) {
    const action = held.get(source);
    if (!action) return false;
    held.delete(source);
    if (![...held.values()].includes(action)) setPressed(action, false);
    return true;
  }

  for (const [action, label] of actions) {
    const row = document.createElement('div');
    row.className = 'binding-row';
    const name = document.createElement('span');
    name.textContent = label;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    row.append(name, button);
    bindingList.append(row);
    bindingButtons.set(action, button);
    button.addEventListener('click', () => {
      capturing = action;
      feedback.textContent = 'Press a key, or Escape to cancel.';
      showBindings();
    });
    button.addEventListener('blur', cancelCapture);
  }

  layoutMenu.addEventListener('change', () => {
    clear();
    mode = layoutMenu.value;
    layout = mode === 'auto' ? 'arrows' : mode;
    savePreferences();
    showBindings();
  });
  document.querySelector('#reset-bindings').addEventListener('click', () => {
    clear();
    custom.clear();
    mode = 'auto';
    layout = 'arrows';
    feedback.textContent = 'Default keys restored.';
    savePreferences();
    showBindings();
  });
  dialog.addEventListener('close', cancelCapture);
  canvas.addEventListener('blur', clear);

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (capturing && dialog.open) {
      if (event.code === 'Tab') { cancelCapture(); return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.code === 'Escape') { cancelCapture(); return; }
      if (!bindable(event.code)) {
        feedback.textContent = 'Choose an unused letter, number, arrow or game key.';
        return;
      }
      const owner = [actionFor(event.code, 'arrows'), actionFor(event.code, 'wasd')]
        .find(action => action && action !== capturing);
      if (owner) {
        const label = actions.find(([action]) => action === owner)[1];
        feedback.textContent = `${keyLabel(event.code)} is assigned to ${label}.`;
        return;
      }
      clear();
      custom.set(capturing, event.code);
      capturing = undefined;
      feedback.textContent = 'Key updated.';
      savePreferences();
      showBindings();
      return;
    }
    if (dialog.open || document.activeElement !== canvas) return;
    if (event.code === 'KeyF') {
      event.preventDefault();
      if (!event.repeat) toggleFullscreen();
      return;
    }
    if (!ready()) return;

    const source = `key:${event.code}`;
    if (held.has(source)) { event.preventDefault(); return; }
    let nextLayout = layout;
    if (mode === 'auto' && ![...custom.values()].includes(event.code)) {
      if (event.code.startsWith('Arrow')) nextLayout = 'arrows';
      if (event.code === 'KeyW' || event.code === 'KeyD') nextLayout = 'wasd';
    }
    const action = actionFor(event.code, nextLayout);
    if (!action) return;
    event.preventDefault();
    if (layout !== nextLayout) {
      layout = nextLayout;
      showBindings();
    }
    press(source, action);
  }, { capture: true });

  window.addEventListener('keyup', (event) => {
    if (release(`key:${event.code}`)) event.preventDefault();
  });

  for (const button of document.querySelectorAll('[data-key]')) {
    button.addEventListener('pointerdown', (event) => {
      if (!ready() || dialog.open || event.button !== 0) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      button.setPointerCapture(event.pointerId);
      press(`pointer:${event.pointerId}`, button.dataset.key);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, (event) => release(`pointer:${event.pointerId}`));
    }
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  showBindings();
  return {
    clear,
    getLayout: () => layout,
    setLayout(value) {
      if (value !== 'arrows' && value !== 'wasd') return;
      layout = value;
      if (mode !== 'auto') mode = value;
      showBindings();
    },
  };
}
