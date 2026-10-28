# Changelog

## 0.4.1

### Maintenance

- Publish using the committed pnpm lockfile instead of a fresh npm dependency resolution, which can fail on Vitest's peer dependencies.
- Authenticate publishing through npm's GitHub Actions trusted publisher (OIDC), using Node 24 and npm 11 without a stored publishing token.
- No library source, public API, CLI behavior, or dependency declarations changed from 0.4.0. The new features and breaking changes prepared for 0.5.0 are not included.
