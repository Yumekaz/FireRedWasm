"""Build native audio data using FireRed's own song and voice definitions."""
import re
import subprocess
from pathlib import Path

from generate_wasm_sound import ROOT, generate_song_asm, load_midi_options, load_song_entries
from wasm_asm_data import convert, preprocess


def main():
    directory = ROOT / "build/wasm/audio"
    directory.mkdir(parents=True, exist_ok=True)
    songs = directory / "songs"
    songs.mkdir(exist_ok=True)
    options = load_midi_options()
    for name in sorted({name for name, _ in load_song_entries()}):
        song = generate_song_asm(name, options.get(name, []), songs)
        if song is None:
            raise ValueError(f"Missing song source {name}")
        song.write_text(song.read_text().replace('"MPlayDef.s"', '"sound/MPlayDef.s"'))

    samples = re.findall(r'\.incbin "([^"]+)"', (ROOT / "sound/direct_sound_data.inc").read_text())
    expanded = {}
    for sample in samples:
        output = directory / Path(sample).name
        subprocess.run([str(ROOT / "tools/wav2agb/wav2agb"), "-b", str(ROOT / Path(sample).with_suffix(".wav")), str(output)], check=True)
        expanded[sample] = str(output)

    source = directory / "audio.s"
    includes = ["asm/macros/m4a.inc", "asm/macros/music_voice.inc", "sound/voice_groups.inc",
                "sound/keysplit_tables.inc", "sound/programmable_wave_data.inc",
                "sound/direct_sound_data.inc", "sound/song_table.inc"]
    source.write_text('.section .rodata\n' + "\n".join(f'.include "{path}"' for path in includes) + "\n")
    output = []
    for unit in [source, *sorted(songs.glob("*.s"))]:
        text = preprocess(unit)
        text = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines())
        text = text.replace(".word ", ".4byte ")
        text = re.sub(r"^\.end$", "", text, flags=re.M)
        constants = {}
        lines = []
        for line in text.splitlines():
            definition = re.match(r"\.equ (\w+),\s*(.+)", line)
            if definition:
                name, expression = definition.groups()
                expression = re.sub(r"\b\w+\b", lambda m: str(constants.get(m[0], m[0])), expression)
                try:
                    constants[name] = int(eval(expression, {"__builtins__": {}}, {}))
                except (NameError, SyntaxError):
                    constants[name] = expression
                continue
            line = re.sub(r"\b\w+\b", lambda m: str(constants.get(m[0], m[0])), line)
            directive = re.match(r"(\.byte|\.2byte|\.4byte) (.+)", line)
            if directive:
                values = []
                for value in directive[2].split(","):
                    try:
                        value = str(int(eval(value.strip(), {"__builtins__": {}}, {})))
                    except (NameError, SyntaxError):
                        pass
                    values.append(value.strip())
                line = directive[1] + " " + ", ".join(values)
            lines.append(line)
        text = "\n".join(lines)
        for sample, target in expanded.items():
            text = text.replace(f'"{sample}"', f'"{target}"')
        output.append(convert(text, unit))
    (directory / "audio.wasm.s").write_text("\n".join(output))


if __name__ == "__main__":
    main()
