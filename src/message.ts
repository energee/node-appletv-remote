import { MessageType } from './mrp/messages.js';

export { MessageType };

export class Message {
  readonly type: MessageType;
  readonly identifier: string;
  readonly payload: Record<string, unknown>;

  constructor(decoded: Record<string, unknown>) {
    this.type = (decoded.type as MessageType) ?? 0;
    this.identifier = (decoded.identifier as string) ?? '';
    this.payload = decoded;
  }

  toString(): string {
    const typeName =
      MessageType[this.type] ?? `Unknown(${this.type})`;
    return `Message(${typeName}, id=${this.identifier})`;
  }
}
