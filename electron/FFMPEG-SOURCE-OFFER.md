# FFmpeg corresponding source

EsseAnalytics Desktop distributes the unmodified Windows FFmpeg binary from
`ffmpeg-static@5.3.0` / release `b6.1.1`.

## Exact binary identification

- Build: `6.1.1-essentials_build-www.gyan.dev`
- License reported by the binary: GPL v3
- FFmpeg source commit: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- Binary builder and build information: https://www.gyan.dev/ffmpeg/builds/
- Package release metadata: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1

The machine-readable source for the FFmpeg portion is available from the exact
commit above. The binary's full configure line and enabled components are
preserved in `ffmpeg.exe.README` beside the bundled binary.

## Included external components

The build reports static use of external libraries, including `x264`, `x265`,
and other libraries listed in `ffmpeg.exe.README`. Their source and license
information must be obtained from their respective upstream projects when
redistributing the complete corresponding-source bundle. The primary codec
sources are:

- x264: https://code.videolan.org/videolan/x264
- x265: https://bitbucket.org/multicoreware/x265_git

This file is a source offer and build record for the distributed binary; it is
not legal advice. Before commercial release, the project owner should verify
that the referenced sources and licenses cover the exact binary and all of its
statically linked components.

## Alternatives documented for legal review

### A. Do not bundle FFmpeg

Remove the FFmpeg binary from the installer and guide the user to download and
install a compatible copy independently. The application would need to detect
the executable, validate its version and show setup instructions.

Advantages:

- The installer would not directly redistribute the FFmpeg binary.
- The application package would be smaller.

Tradeoffs:

- The first-run experience becomes more complex and can fail if FFmpeg is not
  installed correctly.
- Version differences between user installations can produce inconsistent
  results.
- This does not automatically resolve codec-patent questions when the app uses
  H.264 or AAC.

### B. Replace it with another multimedia library or build

Use an LGPL-only FFmpeg build or another library with a license and feature set
approved for the product.

Advantages:

- It may reduce GPL distribution obligations.
- The multimedia component can be selected and documented specifically for the
  product.

Tradeoffs:

- The current Android compatibility path uses `libx264`; an LGPL build without
  GPL components would require an alternative encoder and regression testing.
- Codec support, output quality, performance and file compatibility may change.
- Another library has its own licenses, notices and possible patent concerns.

The current implementation intentionally continues bundling the known FFmpeg
build so video normalization remains predictable. These alternatives are
recorded for the legal and product decision before a commercial launch.
