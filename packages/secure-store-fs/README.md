# @forgeax/secure-store-fs

Node >=18 client for the descriptor-relative SSF1 filesystem broker.

The published package contains compiled JavaScript and declarations plus
exactly four source-derived native helpers: darwin-arm64, darwin-x64,
linux-arm64, and linux-x64. The root export is the supported consumer entry
point. The published client has no compiler or source fallback.

Release tags use `secure-store-fs-v<package version>`. The first npm release
requires a repository `NPM_TOKEN`; after the package exists, maintainers may
configure npm trusted publishing for
`ForgeaX-Games/forgeax-platform-io` and `secure-store-fs-package.yml`. The source
repository is private, so npm cannot attach public provenance attestations to
this package unless the repository visibility policy changes.
