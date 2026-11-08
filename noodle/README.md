# Noodle

A phone sketchpad for musical ideas. Play one octave on big keys (or a 12-pad drum kit), record up to 8 bars against a metronome, quantize, export MIDI, and find takes again by meter, tempo or key.

It's a web app (PWA): one codebase for iPhone and Android, installable to the home screen, and it works offline once loaded.

## Features

- **Keys:** one-octave piano (C to C) or a 4×3 pad grid. Octave shift, multi-touch, slide between keys. Optional velocity from where you hit the key (lower = louder).
- **Sounds:** Pluck, Keys (FM electric piano), Pad, Fuzz (distorted), Bass, Bell, Drums (12 synthesized GM-mapped pieces). Each sound is synthesized live with Web Audio; there are no samples.
- **Metronome:** 40–240 BPM, tap tempo, any meter from 1–15 over /4 or /8. Accents on the downbeat, plus the dotted-quarter groups in 6/8, 9/8 and 12/8. Optional 1-bar count-in and adjustable click volume.
- **Recording:** 1, 2, 4 or 8 bars. In loop mode recording keeps cycling and layers every pass until you stop. You can record a new take each time or add onto the current one, and undo the last pass. Timing uses the audio output timestamp so device latency cancels out, and there's a manual latency slider for devices that report it wrong.
- **Quantize (non-destructive):** grids are 1/4, 1/8, 1/16, 1/32 and the triplets 1/4T, 1/8T, 1/16T. Swing runs 50–75% on 1/8 and 1/16, strength 0–100%, and note ends can optionally snap too. The grid restarts at each barline, so odd meters stay aligned. The roll shows what you actually played as an outline behind the quantized notes.
- **MIDI export:** Type-0 SMF at 480 PPQ with tempo, time signature, the estimated key signature and a GM program. Drums go on channel 10. On phones it opens the share sheet (AirDrop, Files, a DAW), and whole projects export as a .zip.
- **Projects and search:** group takes into projects, then search all takes by name, meter or BPM range, and sort by date, BPM, name or key match.
- **Backup:** export or restore everything as JSON.

## Key-similarity search

Pick a tonic and a scale (18 of them: major/minor, harmonic and melodic minor, the church modes, phrygian dominant, double harmonic, Hungarian minor, the pentatonics, blues and whole tone). Every take gets a 0–100 score:

| Part | Weight | What it measures |
|---|---|---|
| Fit | 50% | Share of the playing that falls inside the scale. Each note counts half by occurrence and half by duration (capped at 2 beats so one held note can't dominate). |
| Tonal center | 30% | How likely the searched tonic is the home note. Evidence: Krumhansl–Kessler profile correlation, notes on strong beats, the bass register, and the last and first notes. |
| Spread | 20% | A penalty for how many *different* outside notes appear. Outside notes under 4% of the playing count fractionally. |

So in a search for A minor, a take in A harmonic minor full of G#s (one outside note, right tonic) scores about 84. A take in C major stuffed with chromatic passing tones (five outside notes, wrong center) scores about 35, and plain C major scores about 70. Each result explains its score, for example "79% in key · center A likely · outside: G# 21%". The weights live in `js/theory.js` (`W`) if you want to tune them.

## Run it

Any static file server works:

```sh
cd noodle && python3 -m http.server 8000
```

To put it on your phone over HTTPS, enable GitHub Pages: in **Settings → Pages**, set **Source** to **GitHub Actions**. `.github/workflows/noodle-pages.yml` then deploys `noodle/` on every push to `master`. Open the URL in Safari and use **Share → Add to Home Screen**. On Android, open it in Chrome and choose **Install app**.

## Develop

```
noodle/
  index.html, style.css     UI shell
  js/theory.js              meter math, quantize, key analysis (pure, unit-tested)
  js/midi.js                MIDI file + zip writer (pure, unit-tested)
  js/audio.js               synth voices, drum kit, metronome click
  js/store.js               IndexedDB / claude.ai Artifact storage
  js/app.js                 transport, keyboard, roll, sheets, library
  tools/build-artifact.mjs  single-file build for a claude.ai Artifact
  test/                     node --test noodle/test/*.test.js
```

On a computer, the keys A W S E D F T G Y H U J K play C up to C, Space plays or stops, and R records.

## Known limits

- iOS Safari can drop site data after about 7 days without a visit unless the app is installed to the home screen. Install it, and use **Back up everything** now and then.
- Touch-to-sound latency depends on the device. iPhones are usually tight, while many Android phones add a noticeable delay to what you hear. Recorded timing is compensated either way.
- One sound per take. Layering drums under a melody (multi-track) isn't built yet.
