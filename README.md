# EarFour

**Play your chords on anything. Get a real band on exactly those chords.**

You can play the chords. Getting them into a track is where it dies: typing chord names, drawing MIDI, guessing what you just strummed. EarFour listens instead.

1. Set your BPM (or pick a groove).
2. Press **● Record**. After a one-bar count-in, play **one chord per bar for 4 bars** on a guitar or piano into your mic, a MIDI keyboard, or the on-screen and computer keys.
3. EarFour **hears** each bar (FFT chroma + chord template matching; MIDI/keys notes are read exactly), writes the chords into the 4-chord entry and seats a real sampled band on them. Press **B**.

Every loop pass while recording is a **new take**: the chords it heard plus your dry audio. Each take can loop or stay silent, can be muted, can hand its chords to the band ("Use chords"), and exports on its own.

## What it exports
- Band WAV: 48 kHz, 24-bit stereo, downbeat at sample 0, exact bar length (92 BPM × 8 bars = 1,001,739 samples), tail folded onto the start, peak −1.1 dBFS. Named `earfour-<recipe>-<bpm>bpm-<key>.wav`.
- MIDI: type 1 with tempo, 4/4 and chord-name markers on every bar; bass, piano, pad and kit tracks, plus one "heard chords" track per take.
- Take stems: each take's dry audio as its own 4-bar WAV, or all of them in a .zip.

## Sound
Live samples only, pinned to commit SHAs on jsDelivr. No synths and no AI audio.
- FluidR3_GM (gleitz/midi-js-soundfonts @044fab8e): acoustic grand piano, finger bass, string ensemble.
- Virtuosity Drums (CC0, sfzinstruments/virtuosity_drums @9f04cf9a): kick, snare, closed hat.

## Mic handling
- Live AudioContext runs at your device's default rate; exports render offline at 48 kHz.
- getUserMedia gets only your chosen deviceId, with echo cancellation, noise suppression and auto gain all OFF.
- Input trim −24 to +12 dB (smoothed), clip light, optional noise gate, monitoring on by default, latency compensation from output + input latency plus a manual "Latency fix" slider.

## Pricing
$19 one-time via Lemon Squeezy (license keys). The free demo includes the ear, recording, every take, playback, MIDI export, take WAVs, MIDI I/O and a 4-bar band WAV. The license unlocks 8 and 16-bar band WAVs. Checkout settings live in the `LEMON` object at the top of the license section in `app.js`; until they are filled in the button reads "Checkout opening soon" and no key unlocks anything.

## Run
Static site. `npm run build` copies the three files into `dist/`. Or open `index.html` through any static server.

MIT © WorkinWithAI
