import type { Socket } from 'node:net';
import http from 'node:http';
import type { RelayEvent, RelayRequest } from './wire-events.ts';

const LONG_POLL_TIMEOUT_MS = 25_000;

export interface GenerationTicket extends AsyncIterable<RelayEvent> {
  readonly id: number;
}

/** Minimal push-driven async queue; exactly one consumer per generation. */
class EventQueue implements AsyncIterable<RelayEvent> {
  #values: RelayEvent[] = [];
  #notify: (() => void) | null = null;
  #failure: Error | null = null;
  #closed = false;

  push(event: RelayEvent): void {
    if (this.#closed) return;
    this.#values.push(event);
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }

  close(failure?: Error): void {
    this.#closed = true;
    this.#failure = failure ?? null;
    const notify = this.#notify;
    this.#notify = null;
    notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RelayEvent> {
    while (true) {
      const value = this.#values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      if (this.#closed) {
        if (this.#failure) throw this.#failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
      });
    }
  }
}

interface Ticket {
  id: number;
  prompt: string;
  modelType?: string;
  dshSessionId?: string;
  queue: EventQueue;
}

export interface RelayHandle {
  /** Resolves once the loopback listener accepts connections. */
  ready: Promise<void>;
  actualPort: number;
  enqueue(request: RelayRequest): GenerationTicket;
  /** Direct injection point used by tests and the /event POST handler. */
  deliverEvent(id: number, event: RelayEvent): void;
  lastTicketId(): number | null;
  close(): Promise<void>;
}

export function startRelayServer(options: { port: number }): RelayHandle {
  const sockets = new Set<Socket>();
  let nextId = 1;
  const ticketsById = new Map<number, Ticket>();
  const queuedTickets: Ticket[] = [];
  const pollers: Array<(ticket: Ticket) => void> = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/next') {
      handleNext(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/event') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('error', () => res.destroy());
      req.on('end', () => {
        res.writeHead(204).end();
        ingestEventBody(Buffer.concat(chunks));
      });
      return;
    }

    res.writeHead(404).end();
  });

  function handleNext(res: http.ServerResponse): void {
    const queued = queuedTickets.shift();
    if (queued) {
      respondTicket(res, queued);
      return;
    }
    const timer = setTimeout(() => {
      const index = pollers.indexOf(resolver);
      if (index >= 0) pollers.splice(index, 1);
      res.writeHead(204).end();
    }, LONG_POLL_TIMEOUT_MS);
    const resolver = (ticket: Ticket): void => {
      clearTimeout(timer);
      respondTicket(res, ticket);
    };
    pollers.push(resolver);
  }

  function respondTicket(res: http.ServerResponse, ticket: Ticket): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: ticket.id,
      prompt: ticket.prompt,
      ...ticket.modelType === undefined ? {} : { modelType: ticket.modelType },
      ...ticket.dshSessionId === undefined ? {} : { dshSessionId: ticket.dshSessionId },
    }));
  }

  function ingestEventBody(body: Buffer): void {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { id?: unknown; event?: RelayEvent };
      if (typeof parsed.id !== 'number' || !parsed.event) return;
      deliverEvent(parsed.id, parsed.event);
    } catch {
      // Malformed bodies are dropped; the generation surfaces its own incomplete.
    }
  }

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let listeningResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    listeningResolve = resolve;
  });
  server.listen(options.port, '127.0.0.1', () => listeningResolve());

  function deliverEvent(id: number, event: RelayEvent): void {
    const ticket = ticketsById.get(id);
    if (!ticket) return;
    ticket.queue.push(event);
    if (event.t === 'finish' || event.t === 'error') {
      ticket.queue.close(event.t === 'error' ? new Error(event.message) : undefined);
      ticketsById.delete(id);
    }
  }

  return {
    get ready() {
      return ready;
    },
    get actualPort() {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('relay not listening');
      return address.port;
    },
    enqueue(request: RelayRequest): GenerationTicket {
      const ticket: Ticket = {
        id: nextId++,
        prompt: request.prompt,
        modelType: request.modelType,
        dshSessionId: request.dshSessionId,
        queue: new EventQueue(),
      };
      ticketsById.set(ticket.id, ticket);
      const poller = pollers.shift();
      if (poller) poller(ticket);
      else queuedTickets.push(ticket);

      const iterable: GenerationTicket = {
        id: ticket.id,
        async *[Symbol.asyncIterator]() {
          yield* ticket.queue;
        },
      };
      return iterable;
    },
    deliverEvent,
    lastTicketId(): number | null {
      if (ticketsById.size === 0) return null;
      let max: number | null = null;
      for (const id of ticketsById.keys()) {
        if (max === null || id > max) max = id;
      }
      return max;
    },
    close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
