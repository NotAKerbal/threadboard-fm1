# Third-party components

Threadboard's bridge, firmware app and simulator are MIT licensed. The compiled
firmware also contains these components with their original notices retained:

- [fm1-base](https://github.com/charlesvestal/fm1-base), Charles Vestal,
  revision `934e40d846d84e76e9c428d37b74bccb6192c823`, MPL-2.0, with some MIT files.
  License and provenance: `vendor/fm1-base/LICENSING.md`, `LICENSE`, `CREDITS.md`.
- [felucca-bsp](https://github.com/hugelton/felucca-bsp), Leo Kuroshita,
  Hügelton Instruments and contributors, revision
  `2cd696a2b94341077303e9132bb4be3d0a87ebcf`, MPL-2.0.
  License and notices: `vendor/fm1-base/bsp/LICENSE`, `NOTICE`, `LICENSING.md`.
- Terminus bitmap fonts, SIL Open Font License 1.1. The original notice is
  `vendor/fm1-base/assets/fonts/Terminus-LICENSE.txt`.
- JieLi AC79 SDK boot and packaging files, Apache-2.0. The exact revision and
  SHA-256 hashes are recorded in `scripts/bootstrap.sh`. No radio libraries are
  linked into this USB-only firmware.

The SDK, compiler and stock recovery firmware are downloaded locally. They are
not part of Threadboard's source. Before distributing firmware, include the
platform source, license notices, and the SDK's applicable notices with it.
