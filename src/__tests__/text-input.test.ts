/**
 * AppleTV text input over Companion RTI (pyatv CompanionKeyboard). A real Apple TV 4K ignored the MRP
 * TextInputMessage; this flow set, appended and cleared YouTube search text on the same device.
 */
import { describe, expect, it, vi } from 'vitest';
import bplistCreator from 'bplist-creator';
import { AppleTV } from '../appletv.js';
import { rtiClearTextPayload, rtiInputTextPayload } from '../companion/text-input.js';
import type { OpackDict, OpackValue } from '../companion/opack.js';

const uuid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const tiD = (text: string) => bplistCreator({
  $version: 100000, $archiver: 'RTIKeyedArchiver', $top: { sessionUUID: { UID: 1 }, documentState: { UID: 2 } },
  $objects: ['$null', uuid, { docSt: { UID: 3 } }, { contextBeforeInput: { UID: 4 } }, text],
});

const device = () => new AppleTV({ name: 'TV', address: '127.0.0.1', port: 7000, deviceId: 'test', model: 'test' });

/** Companion fake: `_tiStart` answers focused with `text`, or (null) with the empty `_c` a real unfocused TV sends. */
function companion(text: string | null) {
  const atv = device();
  const sent: [string, OpackDict][] = [];
  (atv as any).companionConnection = {
    close: vi.fn(),
    sendRequest: vi.fn(async (id: string, content: OpackDict) => {
      sent.push([id, content]);
      const c = id === '_tiStart' && text !== null ? new Map<OpackValue, OpackValue>([['_tiD', tiD(text)]]) : new Map();
      return new Map<OpackValue, OpackValue>([['_c', c]]);
    }),
    sendMessage: vi.fn((id: string, content: OpackDict) => { sent.push([id, content]); }),
  };
  return { atv, sent };
}
/** The `_tiD` archives of the `_tiC` events sent; payload structure is covered in companion/__tests__/text-input.test.ts. */
const operations = (sent: [string, OpackDict][]) => sent.filter(([id]) => id === '_tiC').map(([, content]) => content.get('_tiD'));
const CLEAR = rtiClearTextPayload(uuid);

describe('Companion text input', () => {
  it('setText restarts the session, clears, then inserts, and returns the new text', async () => {
    const { atv, sent } = companion('old');
    await expect(atv.setText('apple tv')).resolves.toBe('apple tv');
    expect(sent.map(([id]) => id)).toEqual(['_tiStop', '_tiStart', '_tiC', '_tiC']);
    expect(operations(sent)).toEqual([CLEAR, rtiInputTextPayload(uuid, 'apple tv')]);
    expect(sent.find(([id]) => id === '_tiC')![1].get('_tiV')).toBe(1);
  });

  it('insertText appends to the current text without clearing', async () => {
    const { atv, sent } = companion('apple tv');
    await expect(atv.insertText(' remote')).resolves.toBe('apple tv remote');
    expect(operations(sent)).toEqual([rtiInputTextPayload(uuid, ' remote')]);
  });

  it('clearText sends only a clear and returns empty text', async () => {
    const { atv, sent } = companion('apple tv remote');
    await expect(atv.clearText()).resolves.toBe('');
    expect(operations(sent)).toEqual([CLEAR]);
  });

  it('getText reads the current text without sending an edit', async () => {
    const { atv, sent } = companion('apple tv');
    await expect(atv.getText()).resolves.toBe('apple tv');
    expect(operations(sent)).toEqual([]);
  });

  it('rejects when no text field is focused instead of reporting success', async () => {
    const { atv, sent } = companion(null);
    await expect(atv.setText('x')).rejects.toThrow('No text field is focused');
    expect(operations(sent)).toEqual([]);
  });

  it('requires a Companion connection', async () => {
    await expect(device().setText('x')).rejects.toThrow('Companion not connected');
  });
});
