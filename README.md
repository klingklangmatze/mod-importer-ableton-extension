# MOD Importer for Ableton Live Extensions

MOD Importer is an Ableton Live Extension for importing classic 4-channel ProTracker `.mod` files as editable MIDI/Simpler tracks.

## Download

Download the latest packaged Ableton Live Extension here:

[Download MOD Importer (.ablx)](https://github.com/klingklangmatze/mod-importer-ableton-extension/raw/main/MOD-Importer-1.0.0.ablx)

## Features

- Local `.mod` import from Ableton's extension data folder or a user-provided folder path.
- Single ModArchive URL import with `.mod` validation.
- Sample extraction to mono WAV for Simpler without normalization, dithering, fades, or Snap.
- Optional 16-bit WAV export and optional 16 kHz resampling for smoother Simpler playback.
- MIDI clip creation with adaptive channel splitting where needed to avoid single-voice sample collisions.
- Per-track Simpler voice count based on actual MIDI note overlap.
- Pattern traversal for position jumps, pattern breaks, pattern loops, pattern delays, speed, and tempo.
- Optional Limiter insertion on the Live Set Main track after import.
- Import report with source, license hints, sample information, internal MOD texts, and reported-only effects.

## Installation

1. Build or obtain the packaged `.ablx` file.
2. Open Ableton Live.
3. Install the extension through Live's Extensions handling.
4. Run the extension from a MIDI or audio track context menu.

## Local file import

The local folder field can be left empty. In that case the importer uses Ableton's extension data folder.

Typical extension data folder locations:

```text
macOS:
/Users/USERNAME/Library/Application Support/Ableton/Extensions Data/klingklangmatze.mod-importer

Windows:
C:\Users\USERNAME\AppData\Roaming\Ableton\Extensions Data\klingklangmatze.mod-importer
```

A custom folder path can also be entered in the local folder field. Press Reload after changing the folder.

## ModArchive URL import

Paste a single ModArchive module URL, for example:

```text
https://modarchive.org/module.php?213926
```

The importer resolves the module, downloads the file, and checks that it is a supported 4-channel `.mod` before importing. It does not crawl, search, or bulk-download modules.

## Copyright and licenses

The extension does not include or redistribute MOD files. It only imports files selected or requested by the user.

Copyright remains with the composer unless the module page, module text, or source states otherwise. Before using imported music or samples in releases, games, apps, sample packs, or commercial projects, check the license and contact the composer if required.

## Build from source

```bash
npm install --no-package-lock
npm run package
```

The package script creates the `.ablx` file. Generated outputs are not committed.

## Logs

Ableton's Extension Host writes extension output and uncaught exceptions to `ExtensionHost.txt`.

Typical locations:

```text
macOS:
/Users/USERNAME/Library/Preferences/Ableton/Live x.x.x/ExtensionHost.txt

Windows:
C:\Users\USERNAME\AppData\Roaming\Ableton\Live x.x.x\Preferences\ExtensionHost.txt
```

The importer writes only high-level lifecycle and error messages to the log. Routine import details are shown in the import report instead of the host log.
