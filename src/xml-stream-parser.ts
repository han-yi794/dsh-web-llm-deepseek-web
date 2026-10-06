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

/**
 * DeepSeek web models sometimes emit tool calls in a fullwidth-delimited
 * DSML envelope instead of plain `<toolname>` tags:
 * `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="t">` +
 * `<｜｜DSML｜｜ parameter name="p">v</｜｜DSML｜｜ parameter>…` +
 * `</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`.
 * (｜ is U+FF5C FULLWIDTH VERTICAL LINE.) Without this path the raw envelope
 * leaks into visible text (pitfall C3); with it, invokes convert to the same
 * CompletedToolCall shape as standard tags.
 */
const DSML_OPEN_FULL = '<｜｜DSML｜｜ calls>';
const DSML_CLOSE_FULL = '</｜｜DSML｜｜ calls>';
const DSML_CALLS_OPEN_RE = /<｜｜DSML｜｜\s*calls\s*>/;
const DSML_CALLS_CLOSE_RE = /<\/｜｜DSML｜｜\s*calls\s*>/;
const DSML_INVOKE_RE = /<｜｜DSML｜｜\s*invoke\s+name="([^"]*)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke\s*>/g;
const DSML_PARAM_RE = /<｜｜DSML｜｜\s*parameter\s+name="([^"]*)"(?:\s+string="[^"]*")?\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>/g;
/** Longest marker: a split marker is always fully inside the held tail. */
const DSML_TAIL_BOUND = DSML_CLOSE_FULL.length;

/** How many trailing chars to hold back for a possibly-split DSML marker. */
function dsmlTailLength(text: string): number {
  const limit = Math.min(text.length, DSML_TAIL_BOUND);
  for (let length = limit; length > 0; length -= 1) {
    const tail = text.slice(-length);
    if (DSML_OPEN_FULL.startsWith(tail) || DSML_CLOSE_FULL.startsWith(tail)) return length;
  }
  return 0;
}

/** Convert one closed DSML calls-body into tool calls (known names only). */
function completeDsmlCalls(
  body: string,
  toolNames: ReadonlySet<string>,
  result: StreamParseResult,
): void {
  DSML_INVOKE_RE.lastIndex = 0;
  let invoke: RegExpExecArray | null;
  while ((invoke = DSML_INVOKE_RE.exec(body)) !== null) {
    const name = invoke[1] ?? '';
    if (name === '' || !toolNames.has(name)) continue;
    const invokeBody = invoke[2] ?? '';
    const args: Record<string, string> = {};
    DSML_PARAM_RE.lastIndex = 0;
    let param: RegExpExecArray | null;
    while ((param = DSML_PARAM_RE.exec(invokeBody)) !== null) {
      const key = param[1] ?? '';
      const value = param[2] ?? '';
      if (key !== '') args[key] = value.trim();
    }
    result.tools.push({ name, argsJson: JSON.stringify(args) });
  }
}

export interface StreamingXmlParser {
  append(chunk: string): StreamParseResult;
  flush(): StreamParseResult;
}

export function createStreamingXmlParser(toolNames: ReadonlySet<string>): StreamingXmlParser {
  return new XmlStreamingParser(toolNames);
}

class XmlStreamingParser implements StreamingXmlParser {
  private readonly names: ReadonlySet<string>;
  private state: 'NORMAL' | 'SUPPRESSING' | 'SUPPRESSING_DSML' = 'NORMAL';
  private pendingText = '';
  private pendingBody = '';
  private pendingDsmlBody = '';
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
        : this.state === 'SUPPRESSING_DSML'
          ? this.consumeDsml(remaining, result)
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
    this.pendingDsmlBody = '';
    this.currentName = null;
    return result;
  }

  private consumeNormal(input: string, result: StreamParseResult): string {
    const text = this.pendingText + input;
    this.pendingText = '';

    // A DSML envelope wins when its opener precedes any standard tool tag.
    const dsml = DSML_CALLS_OPEN_RE.exec(text);
    const dsmlIndex: number | undefined = dsml?.index;
    const found = findFirstXmlToolTag(text, this.names, { closing: false });
    if (dsml !== null && dsmlIndex !== undefined && (!found || dsmlIndex < found.index)) {
      const opener = dsml[0] ?? '';
      const before = text.slice(0, dsmlIndex);
      if (before.length > 0) result.textDeltas.push(before);
      this.state = 'SUPPRESSING_DSML';
      this.pendingDsmlBody = '';
      return text.slice(dsmlIndex + opener.length);
    }

    if (!found) {
      const tail = Math.max(
        getPartialXmlToolTagTailLength(text, this.names, { closing: false }),
        dsmlTailLength(text),
      );
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
      // Keep the WHOLE buffer: a trailing would-be closer may complete in a
      // later chunk. (Holding back and dropping the tail here would lose both
      // the tail bytes and the ability to ever match the closer.)
      this.pendingBody = text;
      // Oversize guard: stop buffering a runaway tool body.
      if (this.pendingBody.length > MAX_TOOL_BODY_CHARS) {
        const tail = getPartialXmlToolTagTailLength(text, new Set([this.currentName]), { closing: true });
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

  private consumeDsml(input: string, result: StreamParseResult): string {
    const text = this.pendingDsmlBody + input;
    this.pendingDsmlBody = '';

    const close = DSML_CALLS_CLOSE_RE.exec(text);
    if (!close || close.index === undefined) {
      // Keep the WHOLE buffer (see consumeSuppressed): a split closer
      // completes in a later chunk; dropping the tail would lose it.
      this.pendingDsmlBody = text;
      // Oversize guard: stop buffering a runaway DSML body.
      if (this.pendingDsmlBody.length > MAX_TOOL_BODY_CHARS) {
        this.state = 'NORMAL';
        this.pendingDsmlBody = '';
        return text.slice(-dsmlTailLength(text));
      }
      return '';
    }

    const body = text.slice(0, close.index);
    completeDsmlCalls(body, this.names, result);
    this.state = 'NORMAL';
    this.pendingDsmlBody = '';
    const closeText = close[0] ?? '';
    return text.slice(close.index + closeText.length);
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