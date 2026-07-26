# Third-party notices

EsseAnalytics Desktop includes third-party software. The notices below apply to
the distributed Electron application and its bundled resources.

## FFmpeg

This application uses the pinned `ffmpeg-static` version 5.3.0 to provide FFmpeg binaries
for local video processing. The npm package declares the GPL-3.0-or-later
license, and its binary distribution includes the applicable license and README
files. Those files are shipped with the application together with the FFmpeg
binary.

The FFmpeg project and source information are available at:

- https://ffmpeg.org/
- https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1

The Windows binary currently bundled in this checkout identifies itself as
`6.1.1-essentials_build-www.gyan.dev`, is marked `GPL v3`, and points to this
FFmpeg source commit:

- https://github.com/FFmpeg/FFmpeg/commit/e38092ef93

Its reported build configuration enables GPL and includes GPL-dependent
encoders such as `libx264` and `libx265`. The exact license and build details
are also preserved in `ffmpeg.exe.LICENSE` and `ffmpeg.exe.README` inside the
packaged `ffmpeg-static` dependency on Windows. Equivalent files from that
dependency apply to other supported platforms.

The corresponding source and build references for this exact binary are
documented in `FFMPEG-SOURCE-OFFER.md`, which is included in the application
resources.

Because this application is distributed commercially, the FFmpeg licensing
configuration and any corresponding source-code obligations must be reviewed
before release by the project owner or legal counsel. This notice is not legal
advice.

## ffprobe-static

This application uses `ffprobe-static` version 3.1.0. The package is licensed
under the MIT license; its original LICENSE and README files are included with
the packaged dependency.
