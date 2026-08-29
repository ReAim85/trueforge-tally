import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  extractBillDataFromImage,
  type ExtractedBillData,
  type VoucherPayload,
} from './gemini';
import {
  executeBillWorkflow,
  type AgentGateway,
  type BillWorkflowResult,
} from './bill-workflow';
import { parseMultipartFormData } from './multipart';

/**
 * The bridge between REST clients (Postman, your dashboard) and agents.
 *
 * Agents sit on customer PCs behind NAT, so they dial OUT and hold a WebSocket open.
 * A REST GET is forwarded down the right agent's socket, the agent answers with rows
 * pulled from Tally, and the reply becomes the HTTP response. The caller never knows
 * a NAT was involved.
 *
 *   GET  /api/agents                              who is online
 *   GET  /api/agents/:id/:entity?company&from&to  fetch rows from that agent's Tally
 *   POST /api/agents/:id/stockitems               create stock item in Tally
 *   POST /api/agents/:id/ledgers                  create ledger in Tally
 *   POST /api/agents/:id/process-bill             run full 7-step bill processing workflow
 *   POST /api/extract-bill                        extract bill data via Gemini without posting
 *
 * Every request (REST and WS alike) carries `Authorization: Bearer <API_KEY>`.
 */

export interface RpcRequest {
  id: string;
  op: 'fetch' | 'post';
  entity: string;
  company?: string;
  fromDate?: string;
  toDate?: string;
  voucher?: unknown;
  ledger?: unknown;
  stockItem?: unknown;
  stockGroup?: unknown;
  unit?: unknown;
}

export interface RpcReply {
  id: string;
  ok: boolean;
  rows?: unknown[];
  result?: unknown;
  error?: string;
}

interface Pending {
  resolve: (reply: RpcReply) => void;
  timer: NodeJS.Timeout;
}

interface AgentConn {
  agentId: string;
  ws: WebSocket;
  connectedAt: string;
  alive: boolean;
  pending: Map<string, Pending>;
}

export interface BridgeOptions {
  apiKey: string;
  geminiApiKey?: string;
  /** Milliseconds before a silent agent is dropped. Default 30s. */
  heartbeatMs?: number;
  /** Milliseconds before a pending fetch gives up. Default 180s (Tally is slow). */
  rpcTimeoutMs?: number;
}

/**
 * Factory creating an AgentGateway adapter for a connected agent.
 */
export function createAgentGateway(agent: AgentConn, agentId: string, rpcTimeoutMs: number): AgentGateway {
  return {
    async fetch(entity: string, opts: { company?: string } = {}) {
      return new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const request: RpcRequest = {
          id: crypto.randomUUID(),
          op: 'fetch',
          entity,
          company: opts.company,
        };
        const timer = setTimeout(() => {
          agent.pending.delete(request.id);
          reject(new Error(`Agent "${agentId}" timed out fetching ${entity}`));
        }, rpcTimeoutMs);

        agent.pending.set(request.id, {
          timer,
          resolve: (reply) => {
            if (reply.ok) resolve((reply.rows || []) as Record<string, unknown>[]);
            else reject(new Error(reply.error || `Failed fetching ${entity}`));
          },
        });
        agent.ws.send(JSON.stringify(request));
      });
    },

    async postLedger(ledger: Record<string, unknown>, company?: string) {
      return new Promise<{ status: string; masterId?: number; error?: string }>((resolve, reject) => {
        const request: RpcRequest = {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'ledger',
          company,
          ledger,
        };
        const timer = setTimeout(() => {
          agent.pending.delete(request.id);
          reject(new Error(`Agent "${agentId}" timed out posting ledger`));
        }, rpcTimeoutMs);

        agent.pending.set(request.id, {
          timer,
          resolve: (reply) => {
            if (reply.ok) resolve((reply.result || { status: 'created' }) as { status: string; masterId?: number });
            else resolve({ status: 'error', error: reply.error || 'Failed to post ledger' });
          },
        });
        agent.ws.send(JSON.stringify(request));
      });
    },

    async postStockItem(stockItem: Record<string, unknown>, company?: string) {
      return new Promise<{ status: string; masterId?: number; error?: string }>((resolve, reject) => {
        const request: RpcRequest = {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'stockitem',
          company,
          stockItem,
        };
        const timer = setTimeout(() => {
          agent.pending.delete(request.id);
          reject(new Error(`Agent "${agentId}" timed out posting stock item`));
        }, rpcTimeoutMs);

        agent.pending.set(request.id, {
          timer,
          resolve: (reply) => {
            if (reply.ok) resolve((reply.result || { status: 'created' }) as { status: string; masterId?: number });
            else resolve({ status: 'error', error: reply.error || 'Failed to post stock item' });
          },
        });
        agent.ws.send(JSON.stringify(request));
      });
    },

    async postVoucher(voucher: VoucherPayload, company?: string) {
      console.log(
        `[Server] Sending voucher to agent ${agentId}: type=${voucher.voucherTypeName} num=${voucher.voucherNumber} ` +
          `party=${voucher.partyLedgerName} ledgers=${voucher.ledgerEntries.length} inventory=${voucher.inventoryEntries?.length ?? 0}`,
      );
      console.log(
        `[Server] Full JSON request sent to agent ${agentId} (op=post entity=voucher):\n` +
          JSON.stringify({ op: 'post', entity: 'voucher', company, voucher }, null, 2),
      );
      return new Promise<{ status: string; voucherId?: number; error?: string }>((resolve, reject) => {
        const request: RpcRequest = {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'voucher',
          company,
          voucher,
        };
        const timer = setTimeout(() => {
          agent.pending.delete(request.id);
          reject(new Error(`Agent "${agentId}" timed out posting voucher`));
        }, rpcTimeoutMs);

        agent.pending.set(request.id, {
          timer,
          resolve: (reply) => {
            if (reply.ok) resolve((reply.result || { status: 'created' }) as { status: string; voucherId?: number });
            else resolve({ status: 'error', error: reply.error || 'Failed to post voucher' });
          },
        });
        agent.ws.send(JSON.stringify(request));
      });
    },

    async postStockGroup(stockGroup: Record<string, unknown>, company?: string) {
      return new Promise<{ status: string; masterId?: number; error?: string }>((resolve, reject) => {
        const request: RpcRequest = {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'stockgroup',
          company,
          stockGroup,
        };
        const timer = setTimeout(() => {
          agent.pending.delete(request.id);
          reject(new Error(`Agent "${agentId}" timed out posting stock group`));
        }, rpcTimeoutMs);

        agent.pending.set(request.id, {
          timer,
          resolve: (reply) => {
            if (reply.ok) resolve((reply.result || { status: 'created' }) as { status: string; masterId?: number });
            else resolve({ status: 'error', error: reply.error || 'Failed to post stock group' });
          },
        });
        agent.ws.send(JSON.stringify(request));
      });
    },

    async postUnit(unit: Record<string, unknown>, company?: string) {
      return new Promise<{ status: string; masterId?: number; error?: string }>((resolve, reject) => {
        const request: RpcRequest = {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'unit',
          company,
          unit,
        };
        const timer = setTimeout(() => {
          agent.pending.delete(request.id);
          reject(new Error(`Agent "${agentId}" timed out posting unit`));
        }, rpcTimeoutMs);

        agent.pending.set(request.id, {
          timer,
          resolve: (reply) => {
            if (reply.ok) resolve((reply.result || { status: 'created' }) as { status: string; masterId?: number });
            else resolve({ status: 'error', error: reply.error || 'Failed to post unit' });
          },
        });
        agent.ws.send(JSON.stringify(request));
      });
    },
  };
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export function createBridge(opts: BridgeOptions): http.Server {
  const agents = new Map<string, AgentConn>();
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 180_000;

  function authorized(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Constant-time comparison to avoid timing side channels on the key.
    if (token.length !== opts.apiKey.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(opts.apiKey));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health check endpoint without auth, for Railway/fly.io/k8s probes.
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, onlineAgents: agents.size }));
      return;
    }

    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: valid Bearer token required' }));
      return;
    }

    const send = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // GET /api/agents — list connected agents.
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const list = [...agents.values()].map((a) => ({
        agentId: a.agentId,
        connectedAt: a.connectedAt,
        pendingRequests: a.pending.size,
      }));
      return send(200, { agents: list });
    }

    // GET /api/agents/:id/:entity — fetch an entity or report from Tally via the agent.
    const getMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && getMatch) {
      const agentId = decodeURIComponent(getMatch[1]);
      const entity = decodeURIComponent(getMatch[2]);
      const agent = agents.get(agentId);
      if (!agent) {
        return send(404, {
          error: `Agent "${agentId}" is not connected`,
          online: [...agents.keys()],
        });
      }

      const from = url.searchParams.get('from') ?? undefined;
      const to = url.searchParams.get('to') ?? undefined;

      for (const [name, value] of [['from', from], ['to', to]] as const) {
        if (value !== undefined && !isValidIsoDate(value)) {
          return send(400, { error: `Invalid '${name}' date "${value}": use a real calendar date as YYYY-MM-DD` });
        }
      }
      if (from && to && from > to) {
        return send(400, { error: `'from' (${from}) is after 'to' (${to})` });
      }

      const request: RpcRequest = {
        id: crypto.randomUUID(),
        op: 'fetch',
        entity,
        company: url.searchParams.get('company') ?? undefined,
        fromDate: from,
        toDate: to,
      };

      const timer = setTimeout(() => {
        agent.pending.delete(request.id);
        send(504, { error: `Agent did not answer within ${rpcTimeoutMs / 1000}s` });
      }, rpcTimeoutMs);

      agent.pending.set(request.id, {
        timer,
        resolve: (reply) => {
          if (reply.ok) return send(200, { agentId, entity, rows: reply.rows });
          const code = /Unknown entity|invalid date|inverted/i.test(reply.error ?? '') ? 400 : 502;
          send(code, { error: reply.error ?? 'Agent reported an unknown failure' });
        },
      });
      agent.ws.send(JSON.stringify(request));
      return;
    }

    // POST /api/agents/:id/voucher or /vouchers — post a voucher to Tally via the agent.
    const voucherPostMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/vouchers?$/);
    if (req.method === 'POST' && voucherPostMatch) {
      const agentId = decodeURIComponent(voucherPostMatch[1]);
      const agent = agents.get(agentId);
      if (!agent) {
        return send(404, {
          error: `Agent "${agentId}" is not connected`,
          online: [...agents.keys()],
        });
      }

      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body) return send(400, { error: 'Request body must be valid JSON' });

      // Validate required fields.
      if (!body.voucherTypeName || typeof body.voucherTypeName !== 'string' || !body.voucherTypeName.trim()) {
        return send(400, { error: 'Missing required field: voucherTypeName' });
      }
      if (!body.partyLedgerName || typeof body.partyLedgerName !== 'string' || !body.partyLedgerName.trim()) {
        return send(400, { error: 'Missing required field: partyLedgerName' });
      }
      if (!Array.isArray(body.ledgerEntries) || body.ledgerEntries.length === 0) {
        return send(400, { error: 'ledgerEntries must be a non-empty array' });
      }

      const request: RpcRequest = {
        id: crypto.randomUUID(),
        op: 'post',
        entity: 'voucher',
        company: typeof body.company === 'string' ? body.company : undefined,
        voucher: body,
      };

      const timer = setTimeout(() => {
        agent.pending.delete(request.id);
        send(504, { error: `Agent did not answer within ${rpcTimeoutMs / 1000}s` });
      }, rpcTimeoutMs);

      agent.pending.set(request.id, {
        timer,
        resolve: (reply) => {
          if (reply.ok) return send(200, { agentId, ...reply.result as object });
          send(502, { error: reply.error ?? 'Agent reported an unknown failure' });
        },
      });
      agent.ws.send(JSON.stringify(request));
      return;
    }

    // POST /api/agents/:id/ledger or /ledgers — create/alter a ledger master in Tally via the agent.
    const ledgerPostMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/ledgers?$/);
    if (req.method === 'POST' && ledgerPostMatch) {
      const agentId = decodeURIComponent(ledgerPostMatch[1]);
      const agent = agents.get(agentId);
      if (!agent) {
        return send(404, {
          error: `Agent "${agentId}" is not connected`,
          online: [...agents.keys()],
        });
      }

      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body) return send(400, { error: 'Request body must be valid JSON' });

      // Validate required fields.
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return send(400, { error: 'Missing required field: name' });
      }

      const request: RpcRequest = {
        id: crypto.randomUUID(),
        op: 'post',
        entity: 'ledger',
        company: typeof body.company === 'string' ? body.company : undefined,
        ledger: body,
      };

      const timer = setTimeout(() => {
        agent.pending.delete(request.id);
        send(504, { error: `Agent did not answer within ${rpcTimeoutMs / 1000}s` });
      }, rpcTimeoutMs);

      agent.pending.set(request.id, {
        timer,
        resolve: (reply) => {
          if (reply.ok) return send(200, { agentId, ...reply.result as object });
          send(502, { error: reply.error ?? 'Agent reported an unknown failure' });
        },
      });
      agent.ws.send(JSON.stringify(request));
      return;
    }

    // POST /api/agents/:id/stockitem or /stockitems — create/alter a stock item master in Tally via the agent.
    const stockItemPostMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/stockitems?$/);
    if (req.method === 'POST' && stockItemPostMatch) {
      const agentId = decodeURIComponent(stockItemPostMatch[1]);
      const agent = agents.get(agentId);
      if (!agent) {
        return send(404, {
          error: `Agent "${agentId}" is not connected`,
          online: [...agents.keys()],
        });
      }

      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body) return send(400, { error: 'Request body must be valid JSON' });

      // Validate required fields.
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return send(400, { error: 'Missing required field: name' });
      }

      const request: RpcRequest = {
        id: crypto.randomUUID(),
        op: 'post',
        entity: 'stockitem',
        company: typeof body.company === 'string' ? body.company : undefined,
        stockItem: body,
      };

      const timer = setTimeout(() => {
        agent.pending.delete(request.id);
        send(504, { error: `Agent did not answer within ${rpcTimeoutMs / 1000}s` });
      }, rpcTimeoutMs);

      agent.pending.set(request.id, {
        timer,
        resolve: (reply) => {
          if (reply.ok) return send(200, { agentId, ...reply.result as object });
          send(502, { error: reply.error ?? 'Agent reported an unknown failure' });
        },
      });
      agent.ws.send(JSON.stringify(request));
      return;
    }

    // POST /api/agents/:id/process-bill (and aliases bill-image, bill, bills, vouchers/extract-and-post)
    // Runs the complete server-orchestrated 7-step bill processing workflow.
    const billImageMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/(?:process-bill|bill-image|bill|bills|vouchers\/extract-and-post)$/);
    if (req.method === 'POST' && billImageMatch) {
      const agentId = decodeURIComponent(billImageMatch[1]);
      const agent = agents.get(agentId);
      if (!agent) {
        return send(404, {
          error: `Agent "${agentId}" is not connected`,
          online: [...agents.keys()],
        });
      }

      const contentType = req.headers['content-type'] || '';
      let inputData: string | Buffer | ExtractedBillData | null = null;
      let mimeType: string | undefined = undefined;
      let company: string | undefined = url.searchParams.get('company') || undefined;
      let autoPost = true;
      let tolerance = 1.0;

      if (contentType.includes('multipart/form-data')) {
        const raw = await readRawBody(req);
        if (!raw || raw.length === 0) {
          return send(400, { error: 'Empty form-data payload' });
        }
        const parsed = parseMultipartFormData(raw, contentType);
        const file = parsed.files.find((f) =>
          ['file', 'image', 'bill', 'invoice', 'attachment', 'media'].includes(f.fieldName.toLowerCase()),
        ) || parsed.files[0];

        if (!file) {
          return send(400, { error: 'No file uploaded in form-data. Please add an image file with key "file" or "image".' });
        }
        inputData = file.data;
        mimeType = file.mimeType || 'image/jpeg';
        if (parsed.fields.company) company = parsed.fields.company;
        if (parsed.fields.autoPost !== undefined) autoPost = parsed.fields.autoPost !== 'false';
        if (parsed.fields.tolerance !== undefined) tolerance = Number(parsed.fields.tolerance) || 1.0;
      } else if (contentType.includes('application/json')) {
        const body = (await readJsonBody(req)) as Record<string, unknown> | null;
        if (!body) return send(400, { error: 'Request body must be valid JSON' });

        if (body.image || body.data) {
          inputData = (body.image || body.data) as string;
          mimeType = (body.mimeType as string) || undefined;
        } else if (body.vendor && body.bill) {
          // Direct structured bill data passed
          inputData = body as unknown as ExtractedBillData;
        } else {
          return send(400, { error: 'Request body must contain "image" (base64 string) or structured "vendor" and "bill" data' });
        }

        if (typeof body.company === 'string') company = body.company;
        if (typeof body.autoPost === 'boolean') autoPost = body.autoPost;
        if (typeof body.tolerance === 'number') tolerance = body.tolerance;
      } else if (contentType.startsWith('image/') || contentType === 'application/pdf') {
        const raw = await readRawBody(req);
        if (!raw || raw.length === 0) {
          return send(400, { error: 'Empty image payload' });
        }
        inputData = raw;
        mimeType = contentType.split(';')[0].trim();
      } else {
        return send(400, { error: 'Unsupported Content-Type. Use multipart/form-data, application/json with base64/data, or raw image/pdf buffer.' });
      }

      console.log(
        `[Server] Bill image received: agent=${agentId} contentType=${contentType.split(';')[0].trim()} ` +
          `input=${Buffer.isBuffer(inputData) ? inputData.length + ' bytes' : typeof inputData === 'string' ? `string(${inputData.length} chars)` : 'structured JSON'} ` +
          `mimeType=${mimeType ?? 'n/a'} company=${company ?? '(active)'} autoPost=${autoPost}`,
      );

      const gateway = createAgentGateway(agent, agentId, rpcTimeoutMs);
      const result: BillWorkflowResult = await executeBillWorkflow(inputData, gateway, {
        company,
        autoPost,
        tolerance,
        mimeType,
        geminiApiKey: opts.geminiApiKey,
      });

      if (result.status === 'review_required') {
        return send(422, {
          agentId,
          ...result,
        });
      }

      if (result.status === 'validation_error') {
        return send(400, {
          agentId,
          ...result,
        });
      }

      if (result.status === 'master_creation_error' || result.status === 'tally_error') {
        return send(502, {
          agentId,
          ...result,
        });
      }

      return send(200, {
        agentId,
        ...result,
      });
    }

    // POST /api/extract-bill — extract invoice without posting to an agent.
    if (req.method === 'POST' && url.pathname === '/api/extract-bill') {
      const contentType = req.headers['content-type'] || '';
      let imageInput: string | Buffer | null = null;
      let mimeType: string | undefined = undefined;
      let company: string | undefined = url.searchParams.get('company') || undefined;

      if (contentType.includes('multipart/form-data')) {
        const raw = await readRawBody(req);
        if (!raw || raw.length === 0) {
          return send(400, { error: 'Empty form-data payload' });
        }
        const parsed = parseMultipartFormData(raw, contentType);
        const file = parsed.files.find((f) =>
          ['file', 'image', 'bill', 'invoice', 'attachment', 'media'].includes(f.fieldName.toLowerCase()),
        ) || parsed.files[0];

        if (!file) {
          return send(400, { error: 'No file uploaded in form-data. Please add an image file with key "file" or "image".' });
        }
        imageInput = file.data;
        mimeType = file.mimeType || 'image/jpeg';
        if (parsed.fields.company) company = parsed.fields.company;
      } else if (contentType.includes('application/json')) {
        const body = (await readJsonBody(req)) as Record<string, unknown> | null;
        if (!body || (!body.image && !body.data)) {
          return send(400, { error: 'Request body must contain "image" (base64 string or data URL)' });
        }
        imageInput = (body.image || body.data) as string;
        mimeType = (body.mimeType as string) || undefined;
        if (typeof body.company === 'string') company = body.company;
      } else if (contentType.startsWith('image/') || contentType === 'application/pdf') {
        const raw = await readRawBody(req);
        if (!raw || raw.length === 0) {
          return send(400, { error: 'Empty image payload' });
        }
        imageInput = raw;
        mimeType = contentType.split(';')[0].trim();
      } else {
        return send(400, { error: 'Unsupported Content-Type. Use multipart/form-data, application/json with base64, or raw image/pdf buffer.' });
      }

      try {
        const billData = await extractBillDataFromImage(imageInput, {
          mimeType,
          company,
          apiKey: opts.geminiApiKey,
        });
        return send(200, { ok: true, bill: billData });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return send(422, { error: `Gemini extraction failed: ${error}` });
      }
    }

    send(404, { error: 'Not found' });
  });

  /** Read and JSON-parse a request body up to 25MB. Returns null on failure. */
  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const raw = await readRawBody(req);
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }

  function readBody(req: http.IncomingMessage): Promise<unknown> {
    return readJsonBody(req);
  }

  /** Read raw body buffer up to maxBytes (default 25MB). */
  function readRawBody(req: http.IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (c: Buffer) => {
        totalBytes += c.length;
        if (totalBytes > maxBytes) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
    });
  }

  const wss = new WebSocketServer({ server, path: '/agent' });

  server.on('upgrade', (req, socket) => {
    // wss handles the handshake; we only veto unauthorized ones before it does.
    if (!authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const agentId = String(req.headers['x-agent-id'] ?? '').trim();
    if (!agentId) return ws.close(4400, 'x-agent-id header required');

    // Last connection wins: a reconnecting agent replaces its stale socket.
    agents.get(agentId)?.ws.terminate();
    const conn: AgentConn = {
      agentId,
      ws,
      connectedAt: new Date().toISOString(),
      alive: true,
      pending: new Map(),
    };
    agents.set(agentId, conn);
    console.log(`agent connected: ${agentId}`);

    ws.on('pong', () => (conn.alive = true));

    ws.on('message', (data) => {
      let reply: RpcReply;
      try {
        reply = JSON.parse(data.toString());
      } catch {
        return;
      }
      const pending = conn.pending.get(reply.id);
      if (!pending) return; // late reply after timeout - drop it
      conn.pending.delete(reply.id);
      clearTimeout(pending.timer);
      pending.resolve(reply);
    });

    ws.on('close', () => {
      if (agents.get(agentId) === conn) agents.delete(agentId);
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.resolve({ id: '', ok: false, error: 'Agent disconnected mid-request' });
      }
      conn.pending.clear();
      console.log(`agent disconnected: ${agentId}`);
    });
  });

  // Dead-socket sweep: a silently vanished agent (laptop lid closed) would otherwise
  // look connected forever and swallow requests until TCP gives up.
  const sweep = setInterval(() => {
    for (const conn of agents.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, heartbeatMs);
  server.on('close', () => clearInterval(sweep));

  // http.Server.close() waits forever for upgraded sockets, so a plain close would hang
  // shutdown (Railway SIGTERM, tests alike). Terminate the agent sockets first.
  const originalClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    return originalClose(cb);
  }) as typeof server.close;

  return server;
}

// Entrypoint for Railway / local: `npm start`. Tests import createBridge instead.
if (require.main === module) {
  try {
    // Automatically load .env file if present (Node.js 20.12+ built-in)
    // @ts-ignore
    process.loadEnvFile?.();
  } catch {}

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error('API_KEY env var is required (set it in .env or environment)');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8080;
  createBridge({ apiKey, geminiApiKey: process.env.GEMINI_API_KEY }).listen(port, () =>
    console.log(`bridge listening on :${port}`),
  );
}
