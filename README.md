# MOD Importer for Ableton Live Extensions

A compact Ableton Live Extension for importing 4-channel ProTracker `.mod` files as editable MIDI/Simpler tracks.

## Features

- Local `.mod` import from the Ableton extension data folder or a user-provided folder path.
- Single ModArchive URL import with `.mod` validation.
- Samples are converted to mono WAV files for Simpler without normalization, dithering, fades, or Snap. The default export is 8-bit source-rate WAV. Optional 16-bit export and 16 kHz resampling are available for smoother playback while preserving pitch and duration.
- Notes are imported as MIDI clips with adaptive channel splitting where needed to avoid single-voice sample collisions.
- Pattern structure is interpreted where possible: position jumps, pattern breaks, pattern loops, pattern delays, speed and tempo. Row-0 `Fxx` may set the initial timing; later `Fxx` commands affect row duration during import. Repeated song loops are stopped after one pass to avoid excessive Ableton sets.
- Import report shows source, artist/license hints, sample information, internal MOD texts, and reported effects.

## Install for users

1. Build or obtain the packaged `.ablx` file.
2. Open Ableton Live.
3. Install the extension through Live's Extensions handling.
4. Run the command from a MIDI or audio track context menu.

## Local file workflow

The local folder field can be left empty. In that case the importer uses Ableton's extension data folder.

Typical extension data folder locations:

```text
macOS:
/Users/USERNAME/Library/Application Support/Ableton/Extensions Data/klingklangmatze.mod-importer

Windows:
C:\Users\USERNAME\AppData\Roaming\Ableton\Extensions Data\klingklangmatze.mod-importer
```

You can also paste a custom folder path into the local folder field and press Reload.

## ModArchive URL workflow

Paste a single ModArchive module URL, for example:

```text
https://modarchive.org/module.php?213926
```

The importer resolves the module, downloads the file, and checks that it is a supported 4-channel `.mod` before importing.

## Copyright and licenses

The extension does not include or redistribute MOD files. It only imports files selected or requested by the user.

Copyright remains with the composer unless the module page or module comments state otherwise. Before using imported music or samples in releases, games, apps, sample packs, or commercial projects, check the module license and contact the composer if required.

## Build from source

```bash
npm install --no-package-lock
npm run package
```

The package script creates the `.ablx` file. Generated build outputs are not committed.
