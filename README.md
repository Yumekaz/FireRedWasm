<h1 align="center">
  <img src="docs/readme-banner.png" width="1000" alt="FireRed WASM">
</h1>

<p align="center">Play Pokémon FireRed in your browser with native WebAssembly.</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#controls">Controls</a> ·
  <a href="#project-layout">Project layout</a> ·
  <a href="#tests">Tests</a>
</p>

## Quick start

Install GNU Make, Python 3, Node.js 20+, a host C/C++ compiler, `pkg-config`, libpng development headers, and LLVM Clang with the `wasm32` target and `wasm-ld`.

From the repository root, build the host tools and the English Rev 1 WebAssembly module, then start the local server.

```sh
make -f make_tools.mk
make wasm
node web/server.mjs
```

Open [localhost:8000](http://localhost:8000/) and select **Play Game**. You can also [open the player directly](http://localhost:8000/#play).

<details>
<summary>Build paths and local preview</summary>

- The module is written to `build/wasm/pokefirered.wasm`. Use `make clean-wasm` to clear the WASM build output.
- Set `WASM_CC` and `WASM_LD` when Clang and the linker are installed outside your shell's search path.
- A local capture at `screenshots/12_pallet_town_outside.png` appears on the landing page. The page uses its pixel-flame artwork when the capture is absent.

</details>

## Controls

| Action | Default keys |
| --- | --- |
| Move | <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> |
| Confirm / A | <kbd>Z</kbd> or <kbd>J</kbd> |
| Back / B | <kbd>X</kbd> or <kbd>K</kbd> |
| Start | <kbd>Enter</kbd> |
| Select | <kbd>Backspace</kbd> or <kbd>Shift</kbd> |
| L / R | <kbd>Q</kbd> / <kbd>E</kbd> |
| Fullscreen | <kbd>F</kbd> |

Open **Settings** for WASD, custom keybindings, touch controls, playback speed, and integer pixel scaling. **Home** pauses the current session, and **Resume Game** picks up where you left off.

Use the in-game **Save** command to keep progress in this browser. To back up or transfer it, export a `.sav` from **Settings**. Importing a compatible 128 KiB save replaces the current save and restarts the game.

## Project layout

| Path | Role |
| --- | --- |
| [`web/`](web/) | Landing page, player, keyboard and touch input, and local server |
| [`src/main.c`](src/main.c) | Game initialization and frame stepping |
| [`src/wasm_display.c`](src/wasm_display.c) | 240 × 160 framebuffer rendering |
| [`tools/wasm_asm_data.py`](tools/wasm_asm_data.py) | Translation of map, event, and battle data for the WASM link |
| [`Makefile`](Makefile) | Host tools, data generation, and the WASM build |

## Tests

| Command | Coverage |
| --- | --- |
| `node tools/test_wasm.mjs` | Intro rendering, save round trip, overworld movement, battle initialization, and affine backgrounds |
| `node --experimental-websocket tools/test_chromium.mjs` | Browser startup, title screen, menus, and keyboard layouts |
| `node --experimental-websocket tools/test_new_game_full.mjs` | New-game setup, the starting bedroom, and the Pallet Town starter sequence |

The browser tests launch `google-chrome`. If you run them from another checkout, update their server working directory and the full new-game test's screenshot destination to match.
