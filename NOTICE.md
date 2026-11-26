# Third-party notices

ImmuneVault is MIT licensed (see [LICENSE](LICENSE)). It builds on the open-source projects below. None of
their code is copied into this repository: forge-std is a git submodule that keeps its own LICENSE files,
the JavaScript packages are installed from npm, and liboqs is linked from a local build by the optional
cross-check tool.

ImmuneVault is **not** based on the Aevum Starter Kit: the contract, the agent, the sentinel, the console and
the sandbox were written from scratch during the build window. The kit's README was read on 26 Nov 2026 to
check our assumptions about the network.

| Project | Version | License | Used in | Source |
|---|---|---|---|---|
| forge-std | v1.9.7 | MIT or Apache-2.0 | `test/` (submodule in `lib/`) | https://github.com/foundry-rs/forge-std |
| viem | 2.58.4 | MIT | `agent/`, `web/` | https://github.com/wevm/viem |
| @noble/post-quantum | 0.7.1 | MIT | `agent/`, `web/` (ML-DSA-65) | https://github.com/paulmillr/noble-post-quantum |
| @noble/hashes | 2.4.0 | MIT | `agent/` (SHA3-256) | https://github.com/paulmillr/noble-hashes |
| @anthropic-ai/sdk | 1.12.0 | Apache-2.0 | `agent/` (real-model brain) | https://github.com/anthropics/anthropic-sdk-typescript |
| zod | 4.6.7 | MIT | `agent/` (structured outputs) | https://github.com/colinhacks/zod |
| esbuild | 0.28.2 | MIT | build of `web/*.bundle.js` (dev) | https://github.com/evanw/esbuild |
| liboqs | 0.15.0 | MIT | `tools/verify_liboqs.c` (optional cross-check, not vendored) | https://github.com/open-quantum-safe/liboqs |

The two bundles in `web/` (`app.bundle.js`, `sandbox.bundle.js`) contain minified copies of viem and
@noble/post-quantum, under their MIT licenses (the Anthropic SDK is used on the server side only). Their own dependencies carry their own licenses; to list them
all, run `npm ls --all` in `agent/`.
