/**
 * Thin wrapper around a decoded MRP ProtocolMessage, emitted by AppleTV as
 * its `message` event for every message the device sends.
 */

import { MessageType } from './mrp/messages.js';

export { MessageType };

/** A decoded MRP message; `payload` is the full decoded object, including the type-specific extension field. */
export class Message {
  readonly type: MessageType;
  readonly identifier: string;
  readonly payload: Record<string, unknown>;

  /** Missing `type` defaults to 0 and missing `identifier` to the empty string. */
  constructor(decoded: Record<string, unknown>) {
    this.type = (decoded.type as MessageType) ?? 0;
    this.identifier = (decoded.identifier as string) ?? '';
    this.payload = decoded;
  }

  /** Short form like `Message(SetState, id=...)`; unknown types render as `Unknown(n)`. */
  toString(): string {
    const typeName =
      MessageType[this.type] ?? `Unknown(${this.type})`;
    return `Message(${typeName}, id=${this.identifier})`;
  }
}
