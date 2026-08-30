/**
 * Streaming XML tool-call parser for the deepseek-web adapter.
 *
 * Ported patterns from deepseek-pp `core/interceptor/streaming-tool-call-parser.ts`
 * (Apache-2.0) — linear-time tag scanning (excluding the artifact
 * externalization machinery we do not ship) so tool calls are detected while
 * the stream is in flight instead of after a full response is buffered.
 * Raw tool XML never leaks into text deltas (pitfall C3): a detected tool
 * block suppresses its raw body and surfaces a completed tool call only when
 * its closing tag arrives.
 */

import {
  findFirstXmlToolTag,
  getPartialXmlToolTagTailLength,
} from './xml-tools.ts';

export interface CompletedToolCall {
  name: string;
  argsJson: string;
}

export interface StreamParseResult {
  /** Clean user-visible text to emit as text-delta, in arrival order. */
  textDeltas: string[];
  /** Completed tool calls, in arrival order. */
  tools: CompletedToolCall[];
}

const MAX_TOOL_BODY_CHARS = 1_048_576;

export interface StreamingXmlParser {
  append(chunk: string): StreamParseResult;
  flush(): StreamParseResult;
}

export function createStreamingXmlParser(toolNames: ReadonlySet<string>): StreamingXmlParser {
  return new XmlStreamingParser(toolNames);
}

class XmlStreamingParser implements StreamingXmlParser {
  private readonly names: ReadonlySet<string>;
  private state: 'NORMAL' | 'SUPPRESSING' = 'NORMAL';
  private pendingText = '';
  private pendingBody = '';
  private currentName: string | null = null;

  constructor(toolNames: ReadonlySet<string>) {
    this.names = toolNames;
  }

  append(chunk: string): StreamParseResult {
    const result: StreamParseResult = { textDeltas: [], tools: [] };
    if (!chunk || this.names.size === 0) {
      if (chunk) result.textDeltas.push(chunk);
      return result;
    }

    let remaining = chunk;
    while (remaining.length > 0) {
      remaining = this.state === 'SUPPRESSING'
        ? this.consumeSuppressed(remaining, result)
        : this.consumeNormal(remaining, result);
    }
    return result;
  }

  flush(): StreamParseResult {
    const result: StreamParseResult = { textDeltas: [], tools: [] };
    if (this.state === 'NORMAL') {
      if (this.pendingText) result.textDeltas.push(this.pendingText);
      this.pendingText = '';
      return result;
    }
    // An unterminated tool block at EOF: the XML is not executed, and its raw
    // body must not surface (C3). Drop it as a unit.
    this.state = 'NORMAL';
    this.pendingBody = '';
    this.currentName = null;
    return result;
  }

  private consumeNormal(input: string, result: StreamParseResult): string {
    const text = this.pendingText + input;
    this.pendingText = '';

    const found = findFirstXmlToolTag(text, this.names, { closing: false });
    if (!found) {
      const tail = getPartialXmlToolTagTailLength(text, this.names, { closing: false });
      const emitLength = text.length - tail;
      if (emitLength > 0) result.textDeltas.push(text.slice(0, emitLength));
      this.pendingText = tail > 0 ? text.slice(-tail) : '';
      return '';
    }

    // Everything before the tool tag is clean text.
    const before = text.slice(0, found.index);
    if (before.length > 0) result.textDeltas.push(before);
    // Enter suppressing state; scan for the closing tag in later chunks.
    this.state = 'SUPPRESSING';
    this.pendingBody = '';
    this.currentName = found.name;
    return text.slice(found.endIndex);
  }

  private consumeSuppressed(input: string, result: StreamParseResult): string {
    if (this.currentName === null) {
      this.state = 'NORMAL';
      return input;
    }

    const text = this.pendingBody + input;
    this.pendingBody = '';

    const close = findFirstXmlToolTag(text, new Set([this.currentName]), { closing: true });
    if (!close) {
      const tail = getPartialXmlToolTagTailLength(text, new Set([this.currentName]), { closing: true });
      this.pendingBody = text.slice(0, text.length - tail);
      // Oversize guard: stop buffering a runaway tool body.
      if (this.pendingBody.length > MAX_TOOL_BODY_CHARS) {
        this.abortCurrentTool();
        return text.slice(-tail);
      }
      return '';
    }

    const body = text.slice(0, close.index).trim();
    this.completeTool(body, result);
    this.state = 'NORMAL';
    this.currentName = null;
    return text.slice(close.endIndex);
  }

  private completeTool(body: string, result: StreamParseResult): void {
    if (!this.currentName) return;
    result.tools.push({ name: this.currentName, argsJson: body });
  }

  private abortCurrentTool(): void {
    this.state = 'NORMAL';
    this.pendingBody = '';
    this.currentName = null;
  }
}