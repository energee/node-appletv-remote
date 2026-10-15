/**
 * Companion RTI text input: the NSKeyedArchiver plists carried in `_tiD`.
 * The payloads are pre-encoded in the absence of a general NSKeyedArchiver; object order is kept.
 */
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';

type UID = { UID: number };
const uid = (n: number): UID => ({ UID: n });
const objcClass = (name: string) => ({ $classname: name, $classes: [name, 'NSObject'] });
const archive = (objects: unknown[]) =>
  bplistCreator({ $version: 100000, $archiver: 'RTIKeyedArchiver', $top: { textOperations: uid(1) }, $objects: objects });

/** `_tiC` payload that clears the text of the session `sessionUUID`. */
export function rtiClearTextPayload(sessionUUID: Buffer): Buffer {
  return archive([
    '$null',
    { $class: uid(7), targetSessionUUID: uid(5), keyboardOutput: uid(2), textToAssert: uid(4) },
    { $class: uid(3) },
    objcClass('TIKeyboardOutput'),
    '',
    { 'NS.uuidbytes': sessionUUID, $class: uid(6) },
    objcClass('NSUUID'),
    objcClass('RTITextOperations'),
  ]);
}

/** `_tiC` payload that inserts `text` at the cursor of the session `sessionUUID`. */
export function rtiInputTextPayload(sessionUUID: Buffer, text: string): Buffer {
  return archive([
    '$null',
    { keyboardOutput: uid(2), $class: uid(7), targetSessionUUID: uid(5) },
    { insertionText: uid(3), $class: uid(4) },
    text,
    objcClass('TIKeyboardOutput'),
    { 'NS.uuidbytes': sessionUUID, $class: uid(6) },
    objcClass('NSUUID'),
    objcClass('RTITextOperations'),
  ]);
}

/** Session UUID and current text from a `_tiStart` reply's `_tiD` archive. */
export function readTextSession(tiD: Buffer): { sessionUUID: Buffer; text: string } {
  const { $top, $objects } = parseBuffer(tiD)[0] as { $top: Record<string, unknown>; $objects: unknown[] };
  // Follow UID references from $top.
  const read = (path: string[]) => path.reduce<unknown>((node, key) => {
    const next = (node as Record<string, unknown> | undefined)?.[key];
    return next && typeof next === 'object' && 'UID' in next ? $objects[(next as UID).UID] : next;
  }, $top);
  const sessionUUID = read(['sessionUUID']);
  if (!Buffer.isBuffer(sessionUUID)) throw new Error('Text input reply has no session UUID');
  const text = read(['documentState', 'docSt', 'contextBeforeInput']);
  return { sessionUUID, text: typeof text === 'string' ? text : '' };
}
