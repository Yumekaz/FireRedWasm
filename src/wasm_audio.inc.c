// Native m4a sequence playback for the browser target.
// Track bytes, voicegroups and samples are generated from this project's sound sources.
#define AUDIO_RATE 32768
#define AUDIO_TRACKS 16
#define AUDIO_VOICES 64
#define AUDIO_BUFFER 8192
void m4aMPlayContinue(struct MusicPlayerInfo *info);

struct AudioTrack {
    const u8 *pc, *returns[4];
    u8 depth, wait, running, key, velocity, voice, volume, bendRange, repeat;
    s8 pan, shift, bend, tune;
    u8 lfoSpeed, lfoPhase, lfoDelay, lfoCountdown, modDepth, modType;
    u16 externalVolume;
    s16 externalPitch, externalPan, modulation;
};
struct AudioPlayer {
    struct MusicPlayerInfo *info;
    struct SongHeader *song;
    struct AudioTrack tracks[AUDIO_TRACKS];
    u16 tempo, counter, scale, fadeSpeed, fadeClock;
    u8 paused;
};
struct AudioVoice {
    struct AudioTrack *track;
    struct AudioPlayer *player;
    struct ToneData tone;
    float position, step, envelope;
    u32 noise;
    u16 gate;
    u8 key, velocity, phase, active;
};
static struct AudioPlayer sAudioPlayers[6];
static struct AudioVoice sAudioVoices[AUDIO_VOICES];
static float sAudioBuffer[AUDIO_BUFFER * 2];
static u32 sAudioSamples, sAudioRemainder, sAudioSteal;
static u8 sCryVolume = 120;
static s8 sCryPan;
static s16 sCryPitch = 15360;
static u16 sCryLength = 180;
static u32 sAudioUnknownCommands;
static const u8 sAudioWaits[49] = {
    0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,
    28,30,32,36,40,42,44,48,52,54,56,60,64,66,68,72,76,78,80,84,88,90,92,96
};

float *WasmAudioBuffer(void) { return sAudioBuffer; }
u32 WasmAudioFrames(void) { return sAudioSamples; }
u32 WasmAudioRate(void) { return AUDIO_RATE; }
u32 WasmAudioUnknownCommands(void) { return sAudioUnknownCommands; }
void WasmAudioClear(void) { sAudioSamples = 0; }

static struct AudioPlayer *AudioPlayerFor(struct MusicPlayerInfo *info)
{
    u32 i;
    for (i = 0; i < 6; i++)
        if (sAudioPlayers[i].info == info) return &sAudioPlayers[i];
    return NULL;
}

static float AudioPitch(s32 semitones)
{
    float value = 1;
    while (semitones > 0) { value *= 1.059463094f; semitones--; }
    while (semitones < 0) { value *= 0.943874313f; semitones++; }
    return value;
}

static float AudioFinePitch(s32 units)
{
    s32 semitones = units / 256;
    s32 fine = units % 256;
    float base = AudioPitch(semitones);
    if (fine > 0) return base * (1 + fine * (1.059463094f - 1) / 256);
    return base * (1 + fine * (1 - 0.943874313f) / 256);
}

static const u8 *AudioPointer(const u8 **pc)
{
    const u8 *p = *pc;
    u32 address = p[0] | p[1] << 8 | p[2] << 16 | p[3] << 24;
    *pc += 4;
    return (const u8 *)address;
}

static void AudioStopVoices(struct AudioPlayer *player)
{
    u32 i;
    for (i = 0; i < AUDIO_VOICES; i++)
        if (sAudioVoices[i].player == player) sAudioVoices[i].active = FALSE;
}

static void AudioStartNote(struct AudioPlayer *player, struct AudioTrack *track, u16 gate)
{
    const struct ToneData *tone = &player->song->tone[track->voice];
    s32 key = track->key + track->shift;
    u32 i;
    struct AudioVoice *voice = NULL;
    if (key < 0 || key > 127) return;
    if (tone->type & TONEDATA_TYPE_SPL) {
        const u8 *split = &tone->attack;
        u32 address = split[0] | split[1] << 8 | split[2] << 16 | split[3] << 24;
        tone = &((const struct ToneData *)tone->wav)[((const u8 *)address)[key]];
    } else if (tone->type & TONEDATA_TYPE_RHY) {
        tone = &((const struct ToneData *)tone->wav)[key];
        key = tone->key;
    }
    for (i = 0; i < AUDIO_VOICES; i++)
        if (!sAudioVoices[i].active) { voice = &sAudioVoices[i]; break; }
    if (voice == NULL) voice = &sAudioVoices[sAudioSteal++ % AUDIO_VOICES];
    memset(voice, 0, sizeof(*voice));
    voice->active = TRUE;
    voice->track = track;
    voice->player = player;
    voice->tone = *tone;
    voice->key = key;
    voice->velocity = track->velocity;
    voice->gate = gate;
    voice->noise = 0x7fff;
    voice->envelope = (tone->type & 7) ? 1 : 0;
    track->lfoCountdown = track->lfoDelay;
    track->lfoPhase = 0;
}

static void AudioTrackTick(struct AudioPlayer *player, struct AudioTrack *track)
{
    u32 i, limit = 0;
    if (track->lfoCountdown) track->lfoCountdown--;
    else {
        s32 phase;
        track->lfoPhase += track->lfoSpeed;
        phase = track->lfoPhase;
        if (phase >= 64 && phase < 192) phase = 128 - phase;
        else if (phase >= 192) phase -= 256;
        track->modulation = phase * track->modDepth / 64;
    }
    for (i = 0; i < AUDIO_VOICES; i++) {
        struct AudioVoice *voice = &sAudioVoices[i];
        if (voice->active && voice->track == track && voice->gate && --voice->gate == 0)
            voice->phase = 3;
    }
    if (track->pc == NULL || (track->wait && --track->wait)) return;
    while (track->pc && !track->wait && limit++ < 256) {
        u8 command = *track->pc;
        if (command < 0x80) command = track->running;
        else {
            track->pc++;
            if (command >= 0xbd) track->running = command;
        }
        if (command >= 0x80 && command <= 0xb0) {
            track->wait = sAudioWaits[command - 0x80];
        } else if (command >= 0xcf) {
            u16 gate = command == 0xcf ? 0 : sAudioWaits[command - 0xcf];
            if (*track->pc < 0x80) track->key = *track->pc++;
            if (*track->pc < 0x80) track->velocity = *track->pc++;
            if (*track->pc < 0x80) gate += *track->pc++;
            AudioStartNote(player, track, gate);
        } else {
            switch (command) {
            case 0xb1: track->pc = NULL; break;
            case 0xb2: track->pc = AudioPointer(&track->pc); break;
            case 0xb3: {
                const u8 *target = AudioPointer(&track->pc);
                if (track->depth == 4) { track->pc = NULL; break; }
                track->returns[track->depth++] = track->pc;
                track->pc = target;
                break;
            }
            case 0xb4:
                if (track->depth) track->pc = track->returns[--track->depth];
                break;
            case 0xb5: {
                u8 count = *track->pc++;
                const u8 *target = AudioPointer(&track->pc);
                if (++track->repeat < count) track->pc = target;
                else track->repeat = 0;
                break;
            }
            case 0xba: track->pc++; break;
            case 0xbb: player->tempo = *track->pc++ * 2; break;
            case 0xbc: track->shift = *track->pc++; break;
            case 0xbd: track->voice = *track->pc++; break;
            case 0xbe: track->volume = *track->pc++; break;
            case 0xbf: track->pan = *track->pc++ - 64; break;
            case 0xc0: track->bend = *track->pc++ - 64; break;
            case 0xc1: track->bendRange = *track->pc++; break;
            case 0xc2: track->lfoSpeed = *track->pc++; break;
            case 0xc3: track->lfoDelay = *track->pc++; break;
            case 0xc4: track->modDepth = *track->pc++; break;
            case 0xc5: track->modType = *track->pc++; break;
            case 0xc8: track->tune = *track->pc++ - 64; break;
            case 0xcd: track->pc += 2; break;
            case 0xce: {
                u8 key = track->key;
                if (*track->pc < 0x80) key = *track->pc++;
                for (i = 0; i < AUDIO_VOICES; i++)
                    if (sAudioVoices[i].track == track && sAudioVoices[i].key == key + track->shift)
                        sAudioVoices[i].phase = 3;
                break;
            }
            default:
                sAudioUnknownCommands++;
                track->pc = NULL;
            }
        }
    }
    if (limit >= 256) { sAudioUnknownCommands++; track->pc = NULL; }
}

static float AudioSample(struct AudioVoice *voice)
{
    struct WaveData *wave = voice->tone.wav;
    u32 type = voice->tone.type & 7;
    u32 index = (u32)voice->position;
    float sample;
    if (type == 0) {
        if (wave == NULL || wave->size == 0) { voice->active = FALSE; return 0; }
        if (index >= wave->size) {
            if (!(wave->status & 0xc000) || wave->loopStart >= wave->size) {
                voice->active = FALSE;
                return 0;
            }
            voice->position = wave->loopStart;
            index = wave->loopStart;
        }
        if (voice->tone.type & 0x10) index = wave->size - index - 1;
        // Samples are expanded to PCM by the build generator.
        sample = wave->data[index] / 128.0f;
    } else if (type == 3) {
        const u8 *data = (const u8 *)wave;
        u8 packed = data[(index & 31) >> 1];
        sample = ((index & 1) ? (packed & 15) : (packed >> 4)) / 7.5f - 1;
    } else if (type == 4) {
        if ((u32)(voice->position + voice->step) != index) {
            u32 bit = (voice->noise ^ (voice->noise >> 1)) & 1;
            voice->noise = (voice->noise >> 1) | (bit << 14);
        }
        sample = (voice->noise & 1) ? .5f : -.5f;
    } else {
        u32 duty = (u32)wave & 3;
        static const float duties[] = { .125f, .25f, .5f, .75f };
        sample = voice->position < duties[duty] ? .5f : -.5f;
    }
    voice->position += voice->step;
    if (type == 1 || type == 2)
        while (voice->position >= 1) voice->position -= 1;
    if (type == 3)
        while (voice->position >= 32) voice->position -= 32;
    return sample;
}

static void AudioMixFrame(void)
{
    u32 frames, i, n;
    // GBA frame duration is 280896 / 16777216 seconds.
    sAudioRemainder += AUDIO_RATE * 4389;
    frames = sAudioRemainder / 262144;
    sAudioRemainder %= 262144;
    if (sAudioSamples + frames > AUDIO_BUFFER) sAudioSamples = 0;
    memset(sAudioBuffer + sAudioSamples * 2, 0, frames * 2 * sizeof(float));
    for (i = 0; i < AUDIO_VOICES; i++) {
        struct AudioVoice *voice = &sAudioVoices[i];
        struct AudioTrack *track = voice->track;
        u32 type = voice->tone.type & 7;
        s32 pitch, pan;
        float volume, left, right;
        if (!voice->active || voice->player->paused) continue;
        pitch = (voice->key - 60) * 256 + track->bend * track->bendRange * 4 + track->tune * 4;
        pitch += track->externalPitch;
        if (track->modType == 0) pitch += track->modulation * 16;
        if (type == 0) {
            voice->step = voice->tone.wav->freq / (1024.0f * AUDIO_RATE);
            if (!(voice->tone.type & 8)) voice->step *= AudioFinePitch(pitch);
        } else {
            voice->step = 261.625565f * AudioFinePitch(pitch) / AUDIO_RATE;
            if (type == 3) voice->step *= 32;
        }
        if (voice->phase == 3) voice->envelope *= voice->tone.release / 256.0f;
        else if (voice->envelope < 1 && voice->phase == 0) {
            voice->envelope += voice->tone.attack / 256.0f;
            if (voice->envelope >= 1) { voice->envelope = 1; voice->phase = 1; }
        } else if (voice->phase == 1) {
            voice->envelope *= voice->tone.decay / 256.0f;
            if (voice->envelope <= voice->tone.sustain / 256.0f) voice->phase = 2;
        }
        if (voice->phase == 3 && voice->envelope < .001f) { voice->active = FALSE; continue; }
        volume = voice->velocity * track->volume * voice->envelope * voice->player->scale / (127.0f * 127 * 256 * 8);
        volume *= track->externalVolume / 256.0f;
        if (track->modType == 1) volume *= 1 + track->modulation / 128.0f;
        pan = track->pan + ((voice->tone.pan_sweep & 128) ? (voice->tone.pan_sweep & 127) - 64 : 0);
        pan += track->externalPan;
        if (track->modType == 2) pan += track->modulation;
        if (pan < -64) pan = -64;
        if (pan > 63) pan = 63;
        left = volume * (64 - pan) / 64;
        right = volume * (64 + pan) / 64;
        for (n = 0; n < frames && voice->active; n++) {
            float sample = AudioSample(voice);
            sAudioBuffer[(sAudioSamples + n) * 2] += sample * left;
            sAudioBuffer[(sAudioSamples + n) * 2 + 1] += sample * right;
        }
    }
    sAudioSamples += frames;
}

void m4aSoundVSync(void) {}
void m4aSoundVSyncOn(void) {}
void m4aSoundVSyncOff(void) {}
void m4aSoundMode(u32 mode) {}
void SoundInit(struct SoundInfo *info) { info->ident = ID_NUMBER; }
void m4aSoundInit(void)
{
    u32 i;
    struct MusicPlayerInfo *players[] = { &gMPlayInfo_BGM, &gMPlayInfo_SE1, &gMPlayInfo_SE2, &gMPlayInfo_SE3,
        &gPokemonCryMusicPlayers[0], &gPokemonCryMusicPlayers[1] };
    memset(sAudioPlayers, 0, sizeof(sAudioPlayers));
    memset(sAudioVoices, 0, sizeof(sAudioVoices));
    for (i = 0; i < 6; i++) {
        sAudioPlayers[i].info = players[i];
        players[i]->ident = ID_NUMBER;
        players[i]->status = 0;
    }
    SoundInit(&gSoundInfo);
    sAudioUnknownCommands = 0;
    sAudioRemainder = 0;
    WasmAudioClear();
}
void MPlayStart(struct MusicPlayerInfo *info, struct SongHeader *song)
{
    u32 i;
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player == NULL || song == NULL || song->trackCount > AUDIO_TRACKS) return;
    AudioStopVoices(player);
    memset(player, 0, sizeof(*player));
    player->info = info;
    player->song = song;
    player->tempo = 150;
    player->scale = 256;
    info->songHeader = song;
    info->status = MUSICPLAYER_STATUS_TRACK;
    for (i = 0; i < song->trackCount; i++) {
        player->tracks[i].pc = song->part[i];
        player->tracks[i].volume = 127;
        player->tracks[i].velocity = 100;
        player->tracks[i].bendRange = 2;
        player->tracks[i].externalVolume = 256;
        player->tracks[i].lfoSpeed = 22;
    }
}
void m4aSoundMain(void)
{
    u32 i, track;
    for (i = 0; i < 6; i++) {
        struct AudioPlayer *player = &sAudioPlayers[i];
        u32 active = 0;
        if (player->song == NULL || player->paused) continue;
        if (player->fadeSpeed && ++player->fadeClock >= player->fadeSpeed) {
            player->fadeClock = 0;
            player->scale = player->scale > 4 ? player->scale - 4 : 0;
            if (!player->scale) { player->paused = TRUE; AudioStopVoices(player); player->info->status = 0; continue; }
        }
        player->counter += player->tempo;
        while (player->counter >= 150) {
            player->counter -= 150;
            for (track = 0; track < player->song->trackCount; track++)
                AudioTrackTick(player, &player->tracks[track]);
        }
        for (track = 0; track < player->song->trackCount; track++)
            if (player->tracks[track].pc) active |= 1 << track;
        player->info->status = active;
    }
    AudioMixFrame();
}
void m4aSongNumStart(u16 n) { if (n < WASM_SONG_COUNT) MPlayStart(sAudioPlayers[gWasmSongInfo[n].player].info, gSongTable[n].header); }
void m4aSongNumStartOrChange(u16 n)
{
    if (n < WASM_SONG_COUNT) {
        struct AudioPlayer *player = &sAudioPlayers[gWasmSongInfo[n].player];
        if (player->song != gSongTable[n].header || player->paused || !player->info->status)
            m4aSongNumStart(n);
    }
}
void m4aSongNumStartOrContinue(u16 n)
{
    if (n >= WASM_SONG_COUNT) return;
    if (sAudioPlayers[gWasmSongInfo[n].player].song != gSongTable[n].header) m4aSongNumStart(n);
    else m4aMPlayContinue(sAudioPlayers[gWasmSongInfo[n].player].info);
}
void m4aSongNumContinue(u16 n) { if (n < WASM_SONG_COUNT) m4aMPlayContinue(sAudioPlayers[gWasmSongInfo[n].player].info); }
void m4aMPlayAllContinue(void) { u32 i; for (i = 0; i < 6; i++) m4aMPlayContinue(sAudioPlayers[i].info); }
void m4aMPlayStop(struct MusicPlayerInfo *info)
{
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) { AudioStopVoices(player); player->paused = TRUE; info->status = 0; }
}
void m4aSongNumStop(u16 n)
{
    if (n < WASM_SONG_COUNT && sAudioPlayers[gWasmSongInfo[n].player].song == gSongTable[n].header)
        m4aMPlayStop(sAudioPlayers[gWasmSongInfo[n].player].info);
}
void m4aMPlayAllStop(void) { u32 i; for (i = 0; i < 6; i++) m4aMPlayStop(sAudioPlayers[i].info); }
void m4aMPlayContinue(struct MusicPlayerInfo *info)
{
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player && player->song) { player->paused = FALSE; info->status = MUSICPLAYER_STATUS_TRACK; }
}
void MPlayContinue(struct MusicPlayerInfo *info) { m4aMPlayContinue(info); }
void m4aMPlayFadeOut(struct MusicPlayerInfo *info, u16 speed)
{
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) { player->fadeSpeed = speed ? speed : 1; player->fadeClock = 0; }
}
void MPlayFadeOut(struct MusicPlayerInfo *info, u16 speed) { m4aMPlayFadeOut(info, speed); }
void m4aMPlayFadeOutTemporarily(struct MusicPlayerInfo *info, u16 speed) { m4aMPlayFadeOut(info, speed); }
void m4aMPlayFadeIn(struct MusicPlayerInfo *info, u16 speed)
{
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) { player->scale = 256; player->fadeSpeed = 0; m4aMPlayContinue(info); }
}
void m4aMPlayTempoControl(struct MusicPlayerInfo *info, u16 tempo)
{
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) player->tempo = 150 * tempo / 256;
}
void m4aMPlayVolumeControl(struct MusicPlayerInfo *info, u16 bits, u16 volume)
{
    u32 i;
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) for (i = 0; i < AUDIO_TRACKS; i++)
        if (bits & (1 << i)) player->tracks[i].externalVolume = volume;
}
void m4aMPlayPitchControl(struct MusicPlayerInfo *info, u16 bits, s16 pitch)
{
    u32 i;
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) for (i = 0; i < AUDIO_TRACKS; i++)
        if (bits & (1 << i)) player->tracks[i].externalPitch = pitch;
}
void m4aMPlayPanpotControl(struct MusicPlayerInfo *info, u16 bits, s8 pan)
{
    u32 i;
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) for (i = 0; i < AUDIO_TRACKS; i++)
        if (bits & (1 << i)) player->tracks[i].externalPan = pan;
}
void m4aMPlayModDepthSet(struct MusicPlayerInfo *info, u16 bits, u8 value)
{
    u32 i;
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) for (i = 0; i < AUDIO_TRACKS; i++)
        if (bits & (1 << i)) player->tracks[i].modDepth = value;
}
void m4aMPlayLFOSpeedSet(struct MusicPlayerInfo *info, u16 bits, u8 value)
{
    u32 i;
    struct AudioPlayer *player = AudioPlayerFor(info);
    if (player) for (i = 0; i < AUDIO_TRACKS; i++)
        if (bits & (1 << i)) player->tracks[i].lfoSpeed = value;
}
void m4aMPlayImmInit(struct MusicPlayerInfo *info) {}
void MPlayMain(struct MusicPlayerInfo *info) {}
void MPlayOpen(struct MusicPlayerInfo *info, struct MusicPlayerTrack *tracks, u8 count) { info->ident = ID_NUMBER; info->tracks = tracks; info->trackCount = count; }
void MPlayExtender(struct CgbChannel *channels) {}
void MPlayJumpTableCopy(MPlayFunc *table) {}
void SoundMain(void) {}
void SoundMainBTM(void) {}
u32 MidiKeyToFreq(struct WaveData *wave, u8 key, u8 fine) { return wave->freq * AudioPitch(key - 60); }
void SetPokemonCryPriority(u8 value) {}
void SetPokemonCryStereo(u32 value) {}
void SetPokemonCryVolume(u8 value) { sCryVolume = value; }
void SetPokemonCryPanpot(s8 value) { sCryPan = value; }
void SetPokemonCryPitch(s16 value) { sCryPitch = value; }
void SetPokemonCryLength(u16 value) { sCryLength = value; }
void SetPokemonCryProgress(u32 value) {}
void SetPokemonCryRelease(u8 value) {}
void SetPokemonCryChorus(s8 value) {}
struct MusicPlayerInfo *SetPokemonCryTone(struct ToneData *tone)
{
    struct AudioPlayer *player = &sAudioPlayers[4];
    struct AudioTrack *track = &player->tracks[0];
    static struct SongHeader cry;
    AudioStopVoices(player);
    cry.trackCount = 1;
    cry.tone = tone;
    player->song = &cry;
    player->tempo = 150;
    player->scale = 256;
    player->paused = FALSE;
    memset(track, 0, sizeof(*track));
    track->key = sCryPitch / 256;
    track->velocity = sCryVolume;
    track->volume = 127;
    track->externalVolume = 256;
    track->pan = sCryPan;
    AudioStartNote(player, track, sCryLength);
    player->info->status = 1;
    return player->info;
}
u32 IsPokemonCryPlaying(struct MusicPlayerInfo *info)
{
    u32 i;
    for (i = 0; i < AUDIO_VOICES; i++)
        if (sAudioVoices[i].player == AudioPlayerFor(info) && sAudioVoices[i].active) return 1;
    return 0;
}
