# MOD effect handling

This importer focuses on stable editable MIDI/Simpler output. Effects that need continuous pitch bend, MIDI CC, MPE, or clip automation are reported but not recreated exactly because the current Extensions SDK path only exposes note-based MIDI clip creation and static device parameter setting.

## Implemented

| Effect | Handling |
| --- | --- |
| `Bxx` Position jump | Interpreted during pattern traversal. |
| `Dxx` Pattern break | Interpreted during pattern traversal. |
| `E6x` Pattern loop | Interpreted with safeguards against infinite loops. |
| Song restart / backward order jumps | A repeated order/row is treated as a song loop and import stops after one pass. |
| `EEx` Pattern delay | Interpreted during timing calculation. |
| `Fxx` Speed / tempo | Interpreted for row timing. Row-0 Fxx can set the initial speed/tempo; later Fxx commands change row duration during traversal. |
| `Cxx` Set volume | Applied as note velocity for newly started notes. |
| `Axy` Volume slide | Applied conservatively through channel volume state. |
| `EAx` / `EBx` Fine volume slide | Applied through channel volume state. |
| `ECx` Note cut | Applied by shortening the note. |
| `EDx` Note delay | Applied by delaying the note start within the row. |

## Approximated or metadata-based

| Feature | Handling |
| --- | --- |
| Sample header volume | Mapped to Simpler Volume with `64` as `-12 dB`; lower values are scaled down logarithmically. |
| Sample header finetune | Mapped to Simpler Detune. Runtime `E5x` finetune is reported-only. |
| Sample loops | Sanitized before setting Simpler loop parameters. Invalid loops are disabled or clamped. |
| Internal MOD texts | Extracted from title and sample names and displayed in the import report. |
| Adaptive track splitting | Most samples use one Ableton track. If one sample would cause single-voice collisions across MOD channels, that sample is split into channel-specific tracks. Offset variants may also create separate parts when required by the sample-start strategy. |
| Simpler Voices | Set per generated track from actual maximum MIDI-note overlap. Monophonic tracks stay at `Voices = 1`; only tracks with real overlap get more voices. |

## Reported-only

| Effect | Reason |
| --- | --- |
| `0xy` Arpeggio | Tick effect; fake micro-notes were removed because they caused musical artifacts. |
| `1xx` / `2xx` Pitch slides | Requires pitch bend or automation. |
| `3xx` Tone portamento | Requires pitch bend or automation. |
| `4xy` Vibrato | Requires pitch modulation. |
| `5xy` / `6xy` pitch/modulation part | Volume part is handled; pitch/modulation part is reported-only. |
| `7xy` Tremolo | Needs volume automation for exact playback. |
| `8xx` / `E8x` Panning | Disabled because automatic panning caused one-sided sample output in Ableton. |
| `9xx` Sample offset | Reported unless handled by the current sample-start strategy. Large offset fan-out is avoided. |
| `E0x` LED filter | Reported; static filter changes are not reliable for row-level playback. |
| `E1x` / `E2x` Fine pitch slides | Requires pitch bend or automation. |
| `E3x` Glissando control | Only meaningful together with exact portamento. |
| `E4x` / `E7x` Waveform control | Only meaningful together with exact vibrato/tremolo. |
| `EFx` Invert loop | Not implemented. |

## Design policy

The importer avoids fake pitch bend, fake vibrato, and tick-level micro-note replacement where those approaches make the MIDI output harder to edit or produce audible artifacts. Exact tracker playback would require audio rendering or SDK access to pitch bend and automation data.
