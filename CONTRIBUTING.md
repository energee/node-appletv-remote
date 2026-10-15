# Contributing

```bash
npm install
npm run build        # also regenerates src/mrp/schema.ts
npm test             # or npm run test:watch
```

With pnpm, `pnpm install --frozen-lockfile` works as is: `pnpm-workspace.yaml` pre-approves the esbuild and protobufjs build scripts that pnpm 10+ otherwise blocks.

The MRP schema is compiled into `src/mrp/schema.ts`, so no `.proto` files are read at run time and the package bundles cleanly. After editing a `.proto` (or adding one to `PROTO_FILES` in `scripts/gen-proto.mjs`), run `npm run gen:proto` and commit the result.

Use `protobufjs >=8.8.1` within major 8; the manifest and pnpm lockfile exclude older vulnerable releases. Fresh npm installs and pnpm's locked installs must both pass. Patched protobufjs enforces proto2 closed enums and drops undeclared values, so `ProtocolMessage.type` is declared `int32`: every discriminator, known or not, decodes as its number (#40). `ProtocolMessage.Type` remains as the reference list; add new values there and to the TypeScript `MessageType` enum. The bare HID flush is `GENERIC_MESSAGE = 42`. `SendButtonEvent` is message type 39 with payload extension field 43, not message type 43. Independent wire fixtures test these values in addition to builder/decoder round trips.
