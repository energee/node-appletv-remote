/** Minimal ambient types for the untyped bplist-creator package (bplist-parser >= 0.5 ships its own). */

/** Encodes a JS value as a binary plist. */
declare module 'bplist-creator' {
  function bplistCreator(obj: unknown): Buffer;
  export = bplistCreator;
}
