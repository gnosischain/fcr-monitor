export class RpcError extends Error {
  constructor(message: string, readonly retriable = false) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}

interface RawBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

interface JsonRpcResponse<T> {
  result?: T | null;
  error?: { code: number; message: string };
}

let requestId = 0;

async function call<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RpcError(`${method} returned HTTP ${response.status}`, response.status >= 500);
    }
    const body = (await response.json()) as JsonRpcResponse<T>;
    if (body.error) {
      // Geth answers "unknown block" for safe/finalized until the paired CL has
      // sent its first forkchoice update. That is a not-ready state, not a bug.
      throw new RpcError(`${method}: ${body.error.message} (code ${body.error.code})`);
    }
    if (body.result === undefined || body.result === null) {
      throw new RpcError(`${method}: null result (tag not set by consensus client yet?)`);
    }
    return body.result;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RpcError(`${method}: timed out after ${timeoutMs}ms`, true);
    }
    throw new RpcError(`${method}: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

function toHeader(block: RawBlock): BlockHeader {
  return {
    number: Number(BigInt(block.number)),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: Number(BigInt(block.timestamp)),
  };
}

export type BlockTag = 'safe' | 'finalized' | 'latest';

export async function getBlockByTag(url: string, tag: BlockTag, timeoutMs: number): Promise<BlockHeader> {
  return toHeader(await call<RawBlock>(url, 'eth_getBlockByNumber', [tag, false], timeoutMs));
}

export async function getBlockByHash(url: string, hash: string, timeoutMs: number): Promise<BlockHeader> {
  return toHeader(await call<RawBlock>(url, 'eth_getBlockByHash', [hash, false], timeoutMs));
}

export async function getChainId(url: string, timeoutMs: number): Promise<number> {
  return Number(BigInt(await call<string>(url, 'eth_chainId', [], timeoutMs)));
}
