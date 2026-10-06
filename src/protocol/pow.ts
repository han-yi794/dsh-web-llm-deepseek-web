// Ported from deepseek-pp `core/deepseek/pow.ts`
// (https://github.com/zhu1090093659/deepseek-pp @ 0a02c72b135bf2936e11aa78fd6136931ed65908).
// Upstream is Apache-2.0 — see NOTICE.md in this repository.
// Local modification: the solver accepts an explicit WASM source (URL or
// already-loaded exports) so tests can instantiate the module from raw bytes
// without chrome.runtime.getURL.

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  expireAt: number;
  expireAfter?: number;
}

export interface PowAnswer {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
}

const SUPPORTED_ALGORITHM = 'DeepSeekHashV1';
export const DEEPSEEK_POW_WASM_PATH = 'deepseek/sha3_wasm_bg.wasm';

interface DeepSeekPowWasmExports {
  memory: WebAssembly.Memory;
  wasm_solve(
    retPtr: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ): void;
  __wbindgen_add_to_stack_pointer(offset: number): number;
  __wbindgen_export_0(size: number, align: number): number;
}

export type DeepSeekPowWasmSource =
  | { kind: 'url'; url: string }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'exports'; exports: DeepSeekPowWasmExports };

interface WasmStringAllocation {
  ptr: number;
  len: number;
}

let powWasm: DeepSeekPowWasmExports | null = null;
interface PowWasmLoad {
  controller: AbortController;
  promise: Promise<DeepSeekPowWasmExports>;
  waiters: number;
}

let powWasmLoad: PowWasmLoad | null = null;
const textEncoder = new TextEncoder();

export async function solvePowChallengeLocally(
  challenge: PowChallenge,
  wasmSource?: DeepSeekPowWasmSource,
  signal?: AbortSignal,
): Promise<PowAnswer> {
  validatePowChallenge(challenge);
  throwIfPowAborted(signal);

  const prefix = `${challenge.salt}_${challenge.expireAt}_`;
  const answer = solvePowWithWasm(
    await loadDeepSeekPowWasm(wasmSource, signal),
    challenge.challenge.toLowerCase(),
    prefix,
    challenge.difficulty,
  );
  throwIfPowAborted(signal);

  return {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
  };
}

function validatePowChallenge(challenge: PowChallenge) {
  if (challenge.algorithm !== SUPPORTED_ALGORITHM) {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${challenge.algorithm}`);
  }

  if (!/^[0-9a-f]{64}$/i.test(challenge.challenge)) {
    throw new Error('Invalid DeepSeek PoW challenge digest.');
  }

  if (!Number.isSafeInteger(challenge.difficulty) || challenge.difficulty <= 0) {
    throw new Error(`Invalid DeepSeek PoW difficulty: ${challenge.difficulty}`);
  }

  if (!Number.isFinite(challenge.expireAt) || challenge.expireAt <= 0) {
    throw new Error(`Invalid DeepSeek PoW expireAt: ${challenge.expireAt}`);
  }
}

function solvePowWithWasm(
  wasm: DeepSeekPowWasmExports,
  target: string,
  prefix: string,
  difficulty: number,
): number {
  const retPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
  const challengeAllocation = writeWasmString(wasm, target);
  const prefixAllocation = writeWasmString(wasm, prefix);
  // wasm_solve is generated from owned Rust String parameters; the callee releases these inputs.

  try {
    wasm.wasm_solve(
      retPtr,
      challengeAllocation.ptr,
      challengeAllocation.len,
      prefixAllocation.ptr,
      prefixAllocation.len,
      difficulty,
    );

    const view = new DataView(wasm.memory.buffer);
    const status = view.getInt32(retPtr, true);
    const answer = view.getFloat64(retPtr + 8, true);
    if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
      throw new Error(`No DeepSeek PoW solution found before difficulty ${difficulty}.`);
    }

    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

async function loadDeepSeekPowWasm(
  wasmSource?: DeepSeekPowWasmSource,
  signal?: AbortSignal,
): Promise<DeepSeekPowWasmExports> {
  if (wasmSource?.kind === 'exports') return wasmSource.exports;
  if (powWasm && wasmSource?.kind !== 'bytes') return powWasm;
  throwIfPowAborted(signal);

  const currentLoad = powWasmLoad;
  const load = !currentLoad || currentLoad.controller.signal.aborted
    ? startDeepSeekPowWasmLoad(wasmSource)
    : currentLoad;
  return waitForDeepSeekPowWasm(load, signal);
}

function startDeepSeekPowWasmLoad(wasmSource?: DeepSeekPowWasmSource): PowWasmLoad {
  const load: PowWasmLoad = {
    controller: new AbortController(),
    promise: Promise.resolve(null as unknown as DeepSeekPowWasmExports),
    waiters: 0,
  };
  load.promise = instantiateDeepSeekPowWasm(wasmSource, load.controller.signal)
    .then((loaded) => {
      powWasm = loaded;
      return loaded;
    })
    .finally(() => {
      if (powWasmLoad === load) powWasmLoad = null;
    });
  powWasmLoad = load;
  return load;
}

async function waitForDeepSeekPowWasm(
  load: PowWasmLoad,
  signal?: AbortSignal,
): Promise<DeepSeekPowWasmExports> {
  load.waiters += 1;
  if (!signal) {
    try {
      return await load.promise;
    } finally {
      load.waiters -= 1;
    }
  }

  return new Promise<DeepSeekPowWasmExports>((resolve, reject) => {
    let settled = false;
    const release = () => {
      load.waiters -= 1;
      return load.waiters === 0;
    };
    const rejectForAbort = async () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (release() && !powWasm) {
        load.controller.abort(signal.reason);
        try {
          await load.promise;
        } catch {
          // The caller receives its own cancellation reason after the shared load has stopped.
        }
      }
      reject(getPowAbortReason(signal));
    };
    const onAbort = () => {
      void rejectForAbort();
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      void rejectForAbort();
      return;
    }

    load.promise.then(
      (loaded) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        release();
        resolve(loaded);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        release();
        reject(error);
      },
    );
  });
}

async function instantiateDeepSeekPowWasm(
  wasmSource: DeepSeekPowWasmSource | undefined,
  signal?: AbortSignal,
): Promise<DeepSeekPowWasmExports> {
  let bytes: Uint8Array;
  if (wasmSource?.kind === 'bytes') {
    bytes = wasmSource.bytes;
  } else {
    const url = wasmSource?.kind === 'url' ? wasmSource.url : getDefaultWasmUrl();
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to load DeepSeek PoW WASM: ${response.status} ${response.statusText}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }

    // Defensive: a Uint8Array view over a pooled/foreign Buffer would expose
    // foreign bytes at offset 0 through .buffer (live-observed '#!/u' shebang).
    const aligned =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    console.error(
      '[pow-debug] len=' + bytes.length,
      'head=' + Array.from(bytes.subarray(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' '),
      'aligned-offset=' + (aligned === bytes.buffer ? 0 : bytes.byteOffset),
    );
    const instantiated = (await WebAssembly.instantiate(aligned, {})) as unknown as {
      instance: WebAssembly.Instance;
    };
    return instantiated.instance.exports as unknown as DeepSeekPowWasmExports;
  }

function throwIfPowAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw getPowAbortReason(signal);
}

function getPowAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('DeepSeek PoW was aborted.', 'AbortError');
}

function getDefaultWasmUrl(): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(DEEPSEEK_POW_WASM_PATH);
  }

  throw new Error('Chrome runtime URL resolver is unavailable for DeepSeek PoW WASM.');
}

function writeWasmString(wasm: DeepSeekPowWasmExports, value: string): WasmStringAllocation {
  const bytes = textEncoder.encode(value);
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1);
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}
