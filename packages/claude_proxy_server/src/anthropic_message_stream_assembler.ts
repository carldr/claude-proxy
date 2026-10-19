type ContentBlock = Record<string, unknown>;

export interface AssembledMessage {
  content: ContentBlock[];
  usage?: Record<string, unknown>;
  stop_reason?: string | null;
  [fieldName: string]: unknown;
}

/**
 * Rebuilds the Messages API response object from the server-sent events of a streaming response.
 * The proxy feeds it each chunk as it forwards the chunk to the client.
 */
export class AnthropicMessageStreamAssembler {
  private readonly textDecoder = new TextDecoder();
  private pendingEventText = '';
  private assembledMessage: AssembledMessage | null = null;
  private readonly partialToolInputJsonByBlockIndex = new Map<number, string>();
  private streamError: unknown = null;

  pushChunk(chunk: Uint8Array): void {
    this.pendingEventText += this.textDecoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let eventSeparatorIndex: number;
    while ((eventSeparatorIndex = this.pendingEventText.indexOf('\n\n')) !== -1) {
      const eventText = this.pendingEventText.slice(0, eventSeparatorIndex);
      this.pendingEventText = this.pendingEventText.slice(eventSeparatorIndex + 2);
      this.handleEventText(eventText);
    }
  }

  finish(): { message: AssembledMessage | null; streamError: unknown } {
    this.pendingEventText += this.textDecoder.decode();
    if (this.pendingEventText.trim() !== '') this.handleEventText(this.pendingEventText);
    this.pendingEventText = '';
    return { message: this.assembledMessage, streamError: this.streamError };
  }

  private handleEventText(eventText: string): void {
    const eventData = eventText
      .split('\n')
      .filter((eventLine) => eventLine.startsWith('data:'))
      .map((eventLine) => eventLine.slice('data:'.length).trimStart())
      .join('\n');
    if (eventData === '') return;

    let streamEvent: Record<string, any>;
    try {
      streamEvent = JSON.parse(eventData);
    } catch {
      return;
    }

    switch (streamEvent.type) {
      case 'message_start':
        this.assembledMessage = structuredClone(streamEvent.message) as AssembledMessage;
        this.assembledMessage.content ??= [];
        break;
      case 'content_block_start':
        if (this.assembledMessage) this.assembledMessage.content[streamEvent.index] = structuredClone(streamEvent.content_block);
        break;
      case 'content_block_delta':
        this.applyContentBlockDelta(streamEvent.index, streamEvent.delta);
        break;
      case 'content_block_stop':
        this.completeToolInput(streamEvent.index);
        break;
      case 'message_delta':
        if (this.assembledMessage) {
          Object.assign(this.assembledMessage, streamEvent.delta);
          this.assembledMessage.usage = { ...this.assembledMessage.usage, ...streamEvent.usage };
        }
        break;
      case 'error':
        this.streamError = streamEvent.error;
        break;
    }
  }

  private applyContentBlockDelta(blockIndex: number, delta: Record<string, any>): void {
    const contentBlock = this.assembledMessage?.content[blockIndex];
    if (!contentBlock) return;
    switch (delta.type) {
      case 'text_delta':
        contentBlock.text = String(contentBlock.text ?? '') + delta.text;
        break;
      case 'thinking_delta':
        contentBlock.thinking = String(contentBlock.thinking ?? '') + delta.thinking;
        break;
      case 'signature_delta':
        contentBlock.signature = delta.signature;
        break;
      case 'citations_delta':
        contentBlock.citations = [...((contentBlock.citations as unknown[]) ?? []), delta.citation];
        break;
      case 'input_json_delta':
        this.partialToolInputJsonByBlockIndex.set(
          blockIndex,
          (this.partialToolInputJsonByBlockIndex.get(blockIndex) ?? '') + delta.partial_json,
        );
        break;
    }
  }

  private completeToolInput(blockIndex: number): void {
    const partialToolInputJson = this.partialToolInputJsonByBlockIndex.get(blockIndex);
    const contentBlock = this.assembledMessage?.content[blockIndex];
    if (partialToolInputJson === undefined || !contentBlock) return;
    this.partialToolInputJsonByBlockIndex.delete(blockIndex);
    if (partialToolInputJson === '') return;
    try {
      contentBlock.input = JSON.parse(partialToolInputJson);
    } catch {
      contentBlock.input = { unparsed_input_json: partialToolInputJson };
    }
  }
}

/** Joins the `text` blocks of a response message. */
export function readAssembledMessageText(message: AssembledMessage | null): string {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((contentBlock) => contentBlock?.type === 'text' && typeof contentBlock.text === 'string')
    .map((contentBlock) => contentBlock.text as string)
    .join('\n');
}
