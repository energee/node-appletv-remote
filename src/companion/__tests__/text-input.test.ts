/** RTI text-input archives: payload structure matches pyatv's pre-encoded NSKeyedArchiver plists. */
import { describe, expect, it } from 'vitest';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { rtiClearTextPayload, rtiInputTextPayload, readTextSession } from '../text-input.js';

const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const decode = (archive: Buffer) => parseBuffer(archive)[0] as { $archiver: string; $top: Record<string, { UID: number }>; $objects: any[] };
const deref = (archive: ReturnType<typeof decode>, ref: { UID: number }) => archive.$objects[ref.UID];

describe('RTI payloads (pyatv plist_payloads/rti_text_operations.py)', () => {
  it('clear targets the session UUID with an empty textToAssert', () => {
    const archive = decode(rtiClearTextPayload(uuid));
    expect(archive.$archiver).toBe('RTIKeyedArchiver');
    const ops = deref(archive, archive.$top.textOperations);
    expect(deref(archive, ops.$class).$classname).toBe('RTITextOperations');
    expect(deref(archive, ops.targetSessionUUID)['NS.uuidbytes']).toEqual(uuid);
    expect(deref(archive, ops.textToAssert)).toBe('');
    expect(deref(archive, deref(archive, ops.keyboardOutput).$class).$classname).toBe('TIKeyboardOutput');
  });

  it('input carries the insertion text for the session UUID', () => {
    const archive = decode(rtiInputTextPayload(uuid, 'apple tv'));
    const ops = deref(archive, archive.$top.textOperations);
    expect(deref(archive, ops.targetSessionUUID)['NS.uuidbytes']).toEqual(uuid);
    expect(deref(archive, deref(archive, ops.keyboardOutput).insertionText)).toBe('apple tv');
  });
});

describe('readTextSession (pyatv keyed_archiver.read_archive_properties)', () => {
  // Shape of a real Apple TV 4K _tiStart _tiD archive: UID references from $top into $objects.
  const tiD = (text?: string) => bplistCreator({
    $version: 100000, $archiver: 'RTIKeyedArchiver', $top: { sessionUUID: { UID: 1 }, documentState: { UID: 2 } },
    $objects: ['$null', uuid, { docSt: { UID: 3 } }, text === undefined ? {} : { contextBeforeInput: { UID: 4 } }, ...(text === undefined ? [] : [text])],
  });

  it('reads the session UUID and current text', () => {
    expect(readTextSession(tiD('apple tv'))).toEqual({ sessionUUID: uuid, text: 'apple tv' });
  });

  it('reports empty text when the field has none', () => {
    expect(readTextSession(tiD())).toEqual({ sessionUUID: uuid, text: '' });
  });

  it('rejects an archive without a session UUID', () => {
    const broken = bplistCreator({ $version: 100000, $archiver: 'RTIKeyedArchiver', $top: {}, $objects: ['$null'] });
    expect(() => readTextSession(broken)).toThrow('session UUID');
  });
});
