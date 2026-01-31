declare module 'bplist-creator' {
  function bplistCreator(obj: unknown): Buffer;
  export = bplistCreator;
}

declare module 'bplist-parser' {
  export function parseBuffer(buffer: Buffer): unknown[];
}
