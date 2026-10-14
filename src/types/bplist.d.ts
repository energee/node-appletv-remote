/** Minimal ambient types for the untyped bplist-creator and bplist-parser packages (Apple binary plists). */

/** Encodes a JS value as a binary plist. */
declare module 'bplist-creator' {
  function bplistCreator(obj: unknown): Buffer;
  export = bplistCreator;
}

/** Decodes binary plists; parseBuffer returns one entry per top-level object. */
declare module 'bplist-parser' {
  export function parseBuffer(buffer: Buffer): unknown[];
}
