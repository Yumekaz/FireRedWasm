export function installAudio() {
  const volume = document.querySelector('#audio-volume');
  const feedback = document.querySelector('#audio-feedback');
  let context, gain, game, memory, nextTime = 0;
  let active = false;
  const sources = new Set();
  try { volume.value = localStorage.getItem('pokefirered.frontend.volume') ?? '70'; }
  catch { /* Use the default volume. */ }

  function stop() {
    for (const source of sources) source.stop();
    sources.clear();
    nextTime = 0;
  }

  function unlock() {
    if (!active) return;
    try {
      context ??= new AudioContext({ sampleRate: 32768, latencyHint: 'interactive' });
      if (!gain) {
        gain = context.createGain();
        gain.gain.value = Number(volume.value) / 100;
        gain.connect(context.destination);
      }
      context.resume().catch(() => {
        feedback.textContent = 'Tap the game to enable sound.';
      });
    } catch {
      feedback.textContent = 'Audio is unavailable in this browser.';
    }
  }

  volume.addEventListener('input', () => {
    if (gain) gain.gain.value = Number(volume.value) / 100;
    try { localStorage.setItem('pokefirered.frontend.volume', volume.value); }
    catch { /* The setting still applies to this session. */ }
    unlock();
  });
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, unlock, { capture: true });

  return {
    attach(instance, wasmMemory) {
      stop();
      game = instance.exports;
      memory = wasmMemory;
      volume.disabled = typeof game.WasmAudioBuffer !== 'function';
      feedback.textContent = volume.disabled ? 'This game build has no audio output.' : '';
    },
    setActive(value) {
      active = value;
      if (!value) stop();
      else unlock();
    },
    flush(speed) {
      if (!game?.WasmAudioFrames) return;
      const frames = game.WasmAudioFrames();
      if (frames && active && context?.state === 'running' && Number.isFinite(speed) && speed <= 2) {
        const data = new Float32Array(memory.buffer, game.WasmAudioBuffer(), frames * 2);
        const buffer = context.createBuffer(2, frames, game.WasmAudioRate());
        for (let channel = 0; channel < 2; channel++) {
          const output = buffer.getChannelData(channel);
          for (let i = 0; i < frames; i++) output[i] = data[i * 2 + channel];
        }
        if (nextTime < context.currentTime || nextTime > context.currentTime + .2) {
          stop();
          nextTime = context.currentTime + .035;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = speed;
        source.connect(gain);
        sources.add(source);
        source.onended = () => { sources.delete(source); source.disconnect(); };
        source.start(nextTime);
        nextTime += frames / game.WasmAudioRate() / speed;
      }
      game.WasmAudioClear();
    },
  };
}
