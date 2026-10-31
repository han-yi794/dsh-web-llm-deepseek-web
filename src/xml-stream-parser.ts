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

/** Why one tool-call block was rejected instead of executed. */
export type ToolRejectionReason =
  | 'BROKEN_JSON'
  | 'UNKNOWN_TOOL'
  | 'NONCE_MISMATCH'
  | 'UNCLOSED_BLOCK'
  | 'OVERSIZE_BLOCK';

export interface ToolRejection {
  reason: ToolRejectionReason;
  /** Human/model-readable specifics (truncated raw fragment, offending name…). */
  detail: string;
}

/** Truncate a raw fragment for rejection details — bounded, never the whole body. */
function rejectionSnippet(raw: string, max = 200): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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
const DSML_INVOKE_OPEN_PREFIX = '<｜｜DSML｜｜ invoke';
const DSML_INVOKE_CLOSE_FULL = '</｜｜DSML｜｜ invoke>';
// Observed drift: the model also emits a `tool_calls`-suffixed envelope
// (`<｜｜DSML｜｜tool_calls>` with no space, real production sample) whose
// meaning is identical to the plain `calls` envelope.
const DSML_TOOLCALLS_OPEN_FULL = '<｜｜DSML｜｜tool_calls>';
const DSML_TOOLCALLS_CLOSE_FULL = '</｜｜DSML｜｜tool_calls>';
const DSML_CALLS_OPEN_RE = /<｜｜DSML｜｜\s*calls\s*>/;
const DSML_CALLS_CLOSE_RE = /<\/｜｜DSML｜｜\s*(?:tool_)?calls\s*>/;
// Observed drift: the model sometimes drops the `calls` wrapper and emits a
// bare invoke block. Accept an invoke opener as a DSML entry point too; its
// terminal marker is the invoke closer, not the calls closer.
const DSML_INVOKE_OPEN_RE = /<｜｜DSML｜｜\s*invoke\b[^>]*>/;
const DSML_INVOKE_NAME_RE = /<｜｜DSML｜｜\s*invoke\s+name="([^"]*)"/;
const DSML_INVOKE_CLOSE_RE = /<\/｜｜DSML｜｜\s*invoke\s*>/;
const DSML_ANY_OPEN_RE = /<｜｜DSML｜｜\s*(?:tool_)?calls\b[^>]*>|<｜｜DSML｜｜\s*invoke\b[^>]*>/;
const DSML_INVOKE_RE = /<｜｜DSML｜｜\s*invoke\s+name="([^"]*)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke\s*>/g;
const DSML_PARAM_RE = /<｜｜DSML｜｜\s*parameter\s+name="([^"]*)"(?:\s+string="[^"]*")?\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>/g;
/** Longest marker: a split marker is always fully inside the held tail. */
const DSML_TAIL_BOUND = DSML_TOOLCALLS_CLOSE_FULL.length;

// Canonical `<tool>{json}</tool>` envelope — the shape the tool instructions
// now mandate; everything else (legacy tags, DSML) stays as tolerance paths.
type EnvelopeBody = { name?: unknown; arguments?: unknown; _nonce?: unknown };
const TOOL_ENVELOPE_OPEN = '<tool>';
const TOOL_ENVELOPE_OPEN_RE = /<tool\s*>/;
const TOOL_ENVELOPE_CLOSE_RE = /<\/tool\s*>/;

function envelopeTailLength(text: string): number {
  const candidates = [TOOL_ENVELOPE_OPEN, '</tool>'];
  const limit = Math.min(text.length, Math.max(...candidates.map((c) => c.length)));
  for (let length = limit; length > 0; length -= 1) {
    const tail = text.slice(-length);
    if (candidates.some((c) => c.startsWith(tail))) return length;
  }
  return 0;
}

/** How many trailing chars to hold back for a possibly-split DSML marker. */
function dsmlTailLength(text: string): number {
  // A marker may be split mid-attributes (invoke openers carry name="…"):
  // hold from the last marker prefix until a '>' completes it — flush emits
  // the held span if it never becomes a marker, so nothing is lost.
  const lastPrefix = text.lastIndexOf('<｜｜DSML｜｜');
  if (lastPrefix >= 0) {
    const rest = text.slice(lastPrefix);
    if (!rest.includes('>')) return rest.length;
  }
  const limit = Math.min(text.length, DSML_TAIL_BOUND);
  for (let length = limit; length > 0; length -= 1) {
    const tail = text.slice(-length);
    if (DSML_OPEN_FULL.startsWith(tail) || DSML_CLOSE_FULL.startsWith(tail)
      || DSML_INVOKE_OPEN_PREFIX.startsWith(tail) || DSML_INVOKE_CLOSE_FULL.startsWith(tail)
      || DSML_TOOLCALLS_OPEN_FULL.startsWith(tail) || DSML_TOOLCALLS_CLOSE_FULL.startsWith(tail)) {
      return length;
    }
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
    const argsJson = parseDsmlParameterValues(invokeBody);
    result.tools.push({ name, argsJson });
  }
}

/**
 * Extract parameter name/value pairs from one DSML invoke body.
 *
 * Segment-scan instead of one non-greedy regex: the model occasionally
 * mis-styles the NEXT parameter's opening tag as a closing tag
 * (`</｜｜DSML｜｜ parameter name="command" ...>`), which makes a
 * non-greedy "open…close" match swallow the whole remainder into the
 * previous value. Segmenting on every `parameter name="…"` marker (opening
 * OR mis-styled closing) keeps each value bounded by the next marker.
 */
function parseDsmlParameterValues(invokeBody: string): string {
  // Normalize mis-styled closers into marker form so the segment scan sees
  // them; plain closers (no name attribute) are unaffected.
  const normalized = invokeBody.replace(/<\s*\/｜｜DSML｜｜\s*parameter\s+name="/g, '<｜｜DSML｜｜ parameter name="');
  if (process.env.DSH_DSML_DEBUG) process.stderr.write(`[dsml-dbg] normalized=${JSON.stringify(normalized)}\n`);
  const MARKER = /<｜｜DSML｜｜\s*parameter\s+name="([^"]*)"[^>]*>/g;
  type Marker = { key: string; markerStart: number; valueStart: number };
  const markers: Marker[] = [];
  let m: RegExpExecArray | null;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(normalized)) !== null) {
    markers.push({ key: m[1] ?? '', markerStart: m.index, valueStart: m.index + m[0].length });
  }
  const args: Record<string, string> = {};
  for (let i = 0; i < markers.length; i++) {
    const key = markers[i]!.key;
    if (key === '') continue;
    // Each value runs to the next parameter marker (opening OR mis-styled
    // closing, both normalized above); the last runs to the end of the body.
    const rawEnd = i + 1 < markers.length ? markers[i + 1]!.markerStart : normalized.length;
    let value = normalized.slice(markers[i]!.valueStart, rawEnd);
    // A well-formed body still carries the plain closing tag at the tail of
    // each value segment — strip exactly that trailing closer.
    value = value.replace(/<\/｜｜DSML｜｜\s*parameter[^>]*>\s*$/, '').trim();
    args[key] = value;
  }
  return JSON.stringify(args);
}

export interface StreamingXmlParser {
  append(chunk: string): StreamParseResult;
  flush(): StreamParseResult;
  /** Tool-call blocks rejected so far (dropped without executing, never leaked). */
  readonly rejections: readonly ToolRejection[];
}

export function createStreamingXmlParser(
  toolNames: ReadonlySet<string>,
  options: { nonce?: string } = {},
): StreamingXmlParser {
  return new XmlStreamingParser(toolNames, options);
}

class XmlStreamingParser implements StreamingXmlParser {
  private readonly names: ReadonlySet<string>;
  private readonly nonce: string | undefined;
  private readonly rejected: ToolRejection[] = [];
  private state: 'NORMAL' | 'SUPPRESSING' | 'SUPPRESSING_DSML' | 'SUPPRESSING_ENVELOPE' = 'NORMAL';
  private pendingText = '';
  private pendingBody = '';
  private pendingDsmlBody = '';
  private pendingEnvelopeBody = '';
  // Bare-invoke DSML mode: set when the matched DSML opener is an invoke
  // (no `calls` wrapper) — the terminal marker and body shape differ.
  private dsmlCloseIsInvoke = false;
  private dsmlInvokeName: string | null = null;
  private currentName: string | null = null;

  constructor(toolNames: ReadonlySet<string>, options: { nonce?: string } = {}) {
    this.names = toolNames;
    this.nonce = options.nonce;
  }

  get rejections(): readonly ToolRejection[] {
    return this.rejected;
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
          : this.state === 'SUPPRESSING_ENVELOPE'
            ? this.consumeEnvelope(remaining, result)
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
    if (this.state === 'SUPPRESSING_ENVELOPE') {
      this.rejected.push({
        reason: 'UNCLOSED_BLOCK',
        detail: `A <tool> block was never closed with </tool> before the reply ended; started with: ${rejectionSnippet(this.pendingEnvelopeBody)}`,
      });
    } else if (this.state === 'SUPPRESSING') {
      this.rejected.push({
        reason: 'UNCLOSED_BLOCK',
        detail: `A <${this.currentName ?? 'tool'}> block was never closed before the reply ended; started with: ${rejectionSnippet(this.pendingBody)}`,
      });
    } else if (this.state === 'SUPPRESSING_DSML') {
      this.rejected.push({
        reason: 'UNCLOSED_BLOCK',
        detail: `A DSML ${this.dsmlCloseIsInvoke ? 'invoke' : 'calls'} block was never closed before the reply ended; started with: ${rejectionSnippet(this.pendingDsmlBody)}`,
      });
    }
    this.state = 'NORMAL';
    this.pendingBody = '';
    this.pendingDsmlBody = '';
    this.pendingEnvelopeBody = '';
    this.dsmlCloseIsInvoke = false;
    this.dsmlInvokeName = null;
    this.currentName = null;
    return result;
  }

  private consumeNormal(input: string, result: StreamParseResult): string {
    const text = this.pendingText + input;
    this.pendingText = '';

    // Earliest opener wins across the three dialects: the canonical
    // `<tool>{json}</tool>` envelope, the legacy fullwidth DSML envelope, and
    // per-tool XML tags. Ranking by position (not by check order) keeps a
    // legacy opener that precedes a `<tool>` block from leaking as text.
    const envelope = TOOL_ENVELOPE_OPEN_RE.exec(text);
    const dsml = DSML_ANY_OPEN_RE.exec(text);
    const found = findFirstXmlToolTag(text, this.names, { closing: false });
    const envelopeIndex: number | undefined = envelope?.index;
    const dsmlIndex: number | undefined = dsml?.index;
    const earliest = Math.min(
      envelopeIndex ?? Number.POSITIVE_INFINITY,
      dsmlIndex ?? Number.POSITIVE_INFINITY,
      found?.index ?? Number.POSITIVE_INFINITY,
    );

    if (envelopeIndex !== undefined && envelopeIndex === earliest) {
      const opener = envelope?.[0] ?? '';
      const before = text.slice(0, envelopeIndex);
      if (before.length > 0) result.textDeltas.push(before);
      this.state = 'SUPPRESSING_ENVELOPE';
      this.pendingEnvelopeBody = '';
      return text.slice(envelopeIndex + opener.length);
    }

    if (dsml !== null && dsmlIndex !== undefined && dsmlIndex === earliest) {
      const opener = dsml[0] ?? '';
      const before = text.slice(0, dsmlIndex);
      if (before.length > 0) result.textDeltas.push(before);
      this.state = 'SUPPRESSING_DSML';
      // A bare invoke opener closes with the invoke marker and carries the
      // tool name on the opener (already consumed), so record both.
      this.dsmlCloseIsInvoke = DSML_INVOKE_OPEN_RE.test(opener);
      this.dsmlInvokeName = this.dsmlCloseIsInvoke
        ? (DSML_INVOKE_NAME_RE.exec(opener)?.[1] ?? null)
        : null;
      this.pendingDsmlBody = '';
      return text.slice(dsmlIndex + opener.length);
    }

    if (!found) {
      const tail = Math.max(
        getPartialXmlToolTagTailLength(text, this.names, { closing: false }),
        dsmlTailLength(text),
        envelopeTailLength(text),
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

  /**
   * Collect the canonical `<tool>{json}</tool>` envelope body. The body is a
   * single JSON object (`name`, `arguments`, optional `_nonce`); a mismatched
   * explicit `_nonce` marks the block as hallucinated or copy-attacked, so it
   * is dropped without executing. A parse failure also drops the block — its
   * raw JSON must never surface as visible text (pitfall C3).
   */
  private consumeEnvelope(input: string, result: StreamParseResult): string {
    const text = this.pendingEnvelopeBody + input;
    this.pendingEnvelopeBody = '';

    const close = TOOL_ENVELOPE_CLOSE_RE.exec(text);
    if (!close || close.index === undefined) {
      this.pendingEnvelopeBody = text;
      if (this.pendingEnvelopeBody.length > MAX_TOOL_BODY_CHARS) {
        this.state = 'NORMAL';
        this.pendingEnvelopeBody = '';
        // Drop the runaway body outright: re-emitting any of it would leak raw
        // envelope JSON as visible text (pitfall C3), and a held partial
        // closer is useless once the block is abandoned.
        this.rejected.push({
          reason: 'OVERSIZE_BLOCK',
          detail: `The <tool> block exceeded ${MAX_TOOL_BODY_CHARS} chars without a closing </tool>; started with: ${rejectionSnippet(text)}`,
        });
        return '';
      }
      return '';
    }

    // At least one closer is present: use the one whose body parses as JSON.
    // A literal `</tool>` inside a string value makes the first candidate cut
    // mid-JSON; the real closer comes later. Genuinely broken JSON still drops
    // (remainder after the FIRST closer flows — surrounding prose survives).
    const closeRe = new RegExp(TOOL_ENVELOPE_CLOSE_RE.source, 'g');
    let closeIndex = -1;
    let closeLength = 0;
    let parsed: EnvelopeBody | null = null;
    let m: RegExpExecArray | null;
    while ((m = closeRe.exec(text)) !== null) {
      try {
        parsed = JSON.parse(text.slice(0, m.index).trim()) as EnvelopeBody;
        closeIndex = m.index;
        closeLength = m[0]?.length ?? 0;
        break;
      } catch {
        // embedded closer inside a string value — try the next one
      }
    }

    this.state = 'NORMAL';
    this.pendingEnvelopeBody = '';

    if (closeIndex < 0 || parsed === null) {
      this.rejected.push({
        reason: 'BROKEN_JSON',
        detail: `The <tool> block body was not valid JSON (a literal "</tool>" inside a string value also triggers this). Body: ${rejectionSnippet(text.slice(0, close.index))}`,
      });
      const idx = close.index;
      return text.slice(idx + (close[0]?.length ?? 0)); // broken JSON: drop, never leak
    }
    const remainder = text.slice(closeIndex + closeLength);

    const name = typeof parsed.name === 'string' ? parsed.name : '';
    if (name === '' || !this.names.has(name)) {
      this.rejected.push({
        reason: 'UNKNOWN_TOOL',
        detail: `The "name" field was "${rejectionSnippet(name)}", which is not one of the available tools: ${[...this.names].join(', ')}.`,
      });
      return remainder;
    }
    // Nonce binding: only enforced when the model echoed a _nonce field back
    // (backward compatible with bodies produced before the binding existed).
    if (typeof parsed._nonce === 'string' && this.nonce !== undefined && parsed._nonce !== this.nonce) {
      this.rejected.push({
        reason: 'NONCE_MISMATCH',
        detail: `The echoed "_nonce" ("${rejectionSnippet(parsed._nonce, 64)}") did not match this request's binding.`,
      });
      return remainder;
    }
    const args = parsed.arguments === undefined ? {} : parsed.arguments;
    const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    result.tools.push({ name, argsJson });
    return remainder;
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
        this.rejected.push({
          reason: 'OVERSIZE_BLOCK',
          detail: `A <${this.currentName}> block exceeded ${MAX_TOOL_BODY_CHARS} chars without closing; started with: ${rejectionSnippet(text)}`,
        });
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

    const closeRe = this.dsmlCloseIsInvoke ? DSML_INVOKE_CLOSE_RE : DSML_CALLS_CLOSE_RE;
    const close = closeRe.exec(text);
    if (!close || close.index === undefined) {
      // Keep the WHOLE buffer (see consumeSuppressed): a split closer
      // completes in a later chunk; dropping the tail would lose it.
      this.pendingDsmlBody = text;
      // Oversize guard: stop buffering a runaway DSML body.
      if (this.pendingDsmlBody.length > MAX_TOOL_BODY_CHARS) {
        this.state = 'NORMAL';
        this.pendingDsmlBody = '';
        this.rejected.push({
          reason: 'OVERSIZE_BLOCK',
          detail: `A DSML ${this.dsmlCloseIsInvoke ? 'invoke' : 'calls'} block exceeded ${MAX_TOOL_BODY_CHARS} chars without closing; started with: ${rejectionSnippet(text)}`,
        });
        return text.slice(-dsmlTailLength(text));
      }
      return '';
    }

    const body = text.slice(0, close.index);
    if (this.dsmlCloseIsInvoke) {
      // Bare invoke (no `calls` wrapper): opener and closer were consumed
      // around the interior, so parse the parameter segment directly.
      const name = this.dsmlInvokeName ?? '';
      if (name !== '' && this.names.has(name)) {
        result.tools.push({ name, argsJson: parseDsmlParameterValues(body) });
      }
    } else {
      completeDsmlCalls(body, this.names, result);
    }
    this.dsmlCloseIsInvoke = false;
    this.dsmlInvokeName = null;
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