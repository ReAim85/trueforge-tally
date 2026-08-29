import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
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
import { isValidIsoDate, type BridgeOptions, type RpcReply, type RpcRequest } from './server';

/**
 * The same bridge as server.ts, written with Express - side-by-side comparison copy.
 *
 * Behaviour is identical (the e2e suite runs against both implementations).
 */

interface AgentConn {
  agentId: string;
  ws: WebSocket;
  connectedAt: string;
  alive: boolean;
  pending: Map<string, { resolve: (reply: RpcReply) => void; timer: NodeJS.Timeout }>;
}

/** Thrown by askAgent when the agent never answers; the route maps it to a 504. */
class AgentTimeoutError extends Error {}

/**
 * Send one request down an agent's socket and wait for the matching reply.
 */
function askAgent(conn: AgentConn, request: RpcRequest, timeoutMs: number): Promise<RpcReply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(request.id);
      reject(new AgentTimeoutError(`Agent did not answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    conn.pending.set(request.id, { resolve, timer });
    conn.ws.send(JSON.stringify(request));
  });
}

function makeExpressAgentGateway(conn: AgentConn, agentId: string, timeoutMs: number): AgentGateway {
  return {
    async fetch(entity: string, opts: { company?: string } = {}) {
      const reply = await askAgent(
        conn,
        {
          id: crypto.randomUUID(),
          op: 'fetch',
          entity,
          company: opts.company,
        },
        timeoutMs,
      );
      if (reply.ok) return (reply.rows || []) as Record<string, unknown>[];
      throw new Error(reply.error || `Failed fetching ${entity}`);
    },

    async postLedger(ledger: Record<string, unknown>, company?: string) {
      const reply = await askAgent(
        conn,
        {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'ledger',
          company,
          ledger,
        },
        timeoutMs,
      );
      if (reply.ok) return (reply.result || { status: 'created' }) as { status: string; masterId?: number };
      return { status: 'error', error: reply.error || 'Failed to post ledger' };
    },

    async postStockItem(stockItem: Record<string, unknown>, company?: string) {
      const reply = await askAgent(
        conn,
        {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'stockitem',
          company,
          stockItem,
        },
        timeoutMs,
      );
      if (reply.ok) return (reply.result || { status: 'created' }) as { status: string; masterId?: number };
      return { status: 'error', error: reply.error || 'Failed to post stock item' };
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
      const reply = await askAgent(
        conn,
        {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'voucher',
          company,
          voucher,
        },
        timeoutMs,
      );
      if (reply.ok) return (reply.result || { status: 'created' }) as { status: string; voucherId?: number };
      return { status: 'error', error: reply.error || 'Failed to post voucher' };
    },

    async postStockGroup(stockGroup: Record<string, unknown>, company?: string) {
      const reply = await askAgent(
        conn,
        {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'stockgroup',
          company,
          stockGroup,
        },
        timeoutMs,
      );
      if (reply.ok) return (reply.result || { status: 'created' }) as { status: string; masterId?: number };
      return { status: 'error', error: reply.error || 'Failed to post stock group' };
    },

    async postUnit(unit: Record<string, unknown>, company?: string) {
      const reply = await askAgent(
        conn,
        {
          id: crypto.randomUUID(),
          op: 'post',
          entity: 'unit',
          company,
          unit,
        },
        timeoutMs,
      );
      if (reply.ok) return (reply.result || { status: 'created' }) as { status: string; masterId?: number };
      return { status: 'error', error: reply.error || 'Failed to post unit' };
    },
  };
}

export function createExpressBridge(opts: BridgeOptions): http.Server {
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 120_000;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const agents = new Map<string, AgentConn>();

  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use(express.raw({ limit: '25mb', type: ['image/*', 'application/pdf', 'multipart/form-data'] }));

  // Health probe first - hosting platforms call it without our API key.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, agents: agents.size });
  });

  // Everything below requires the bearer key.
  app.use((req, res, next) => {
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      res.status(401).json({ error: 'Bad or missing Authorization header' });
      return;
    }
    next();
  });

  app.get('/api/agents', (_req, res) => {
    res.json([...agents.values()].map((a) => ({ agentId: a.agentId, connectedAt: a.connectedAt })));
  });

  app.get('/api/agents/:agentId/:entity', async (req, res) => {
    const { agentId, entity } = req.params;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const company = typeof req.query.company === 'string' ? req.query.company : undefined;

    // Reject bad dates loudly.
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && !isValidIsoDate(value)) {
        res.status(400).json({ error: `Invalid '${name}' date "${value}": use a real calendar date as YYYY-MM-DD` });
        return;
      }
    }
    if (from && to && from > to) {
      res.status(400).json({ error: `'from' (${from}) is after 'to' (${to})` });
      return;
    }

    const conn = agents.get(agentId);
    if (!conn) {
      res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
      return;
    }

    try {
      const reply = await askAgent(
        conn,
        { id: crypto.randomUUID(), op: 'fetch', entity, company, fromDate: from, toDate: to },
        rpcTimeoutMs,
      );
      if (reply.ok) {
        res.json({ agentId, entity, rowCount: reply.rows?.length ?? 0, rows: reply.rows ?? [] });
        return;
      }
      const status = /unknown entity/i.test(reply.error ?? '') ? 400 : 502;
      res.status(status).json({ error: reply.error ?? 'Agent reported an unknown failure' });
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        res.status(504).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /api/agents/:agentId/voucher or /vouchers — post a voucher to Tally via the agent.
  app.post(['/api/agents/:agentId/voucher', '/api/agents/:agentId/vouchers'], async (req, res) => {
    const agentId = String(req.params.agentId);
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Request body must be valid JSON' });
      return;
    }

    // Validate required fields.
    if (!body.voucherTypeName || typeof body.voucherTypeName !== 'string') {
      res.status(400).json({ error: 'Missing required field: voucherTypeName' });
      return;
    }
    if (!body.partyLedgerName || typeof body.partyLedgerName !== 'string') {
      res.status(400).json({ error: 'Missing required field: partyLedgerName' });
      return;
    }
    if (!Array.isArray(body.ledgerEntries) || body.ledgerEntries.length === 0) {
      res.status(400).json({ error: 'Missing required field: ledgerEntries (must be a non-empty array)' });
      return;
    }

    const conn = agents.get(agentId);
    if (!conn) {
      res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
      return;
    }

    const company = typeof body.company === 'string' ? body.company : undefined;

    try {
      const reply = await askAgent(
        conn,
        { id: crypto.randomUUID(), op: 'post', entity: 'voucher', company, voucher: body },
        rpcTimeoutMs,
      );
      if (reply.ok) {
        res.json({ agentId, ...reply.result as object });
        return;
      }
      res.status(502).json({ error: reply.error ?? 'Agent reported an unknown failure' });
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        res.status(504).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /api/agents/:agentId/ledger or /ledgers — create/alter a ledger master in Tally via the agent.
  app.post(['/api/agents/:agentId/ledger', '/api/agents/:agentId/ledgers'], async (req, res) => {
    const agentId = String(req.params.agentId);
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Request body must be valid JSON' });
      return;
    }

    // Validate required fields.
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }

    const conn = agents.get(agentId);
    if (!conn) {
      res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
      return;
    }

    const company = typeof body.company === 'string' ? body.company : undefined;

    try {
      const reply = await askAgent(
        conn,
        { id: crypto.randomUUID(), op: 'post', entity: 'ledger', company, ledger: body },
        rpcTimeoutMs,
      );
      if (reply.ok) {
        res.json({ agentId, ...reply.result as object });
        return;
      }
      res.status(502).json({ error: reply.error ?? 'Agent reported an unknown failure' });
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        res.status(504).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /api/agents/:agentId/stockitem or /stockitems — create/alter a stock item master in Tally via the agent.
  app.post(['/api/agents/:agentId/stockitem', '/api/agents/:agentId/stockitems'], async (req, res) => {
    const agentId = String(req.params.agentId);
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Request body must be valid JSON' });
      return;
    }

    // Validate required fields.
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }

    const conn = agents.get(agentId);
    if (!conn) {
      res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
      return;
    }

    const company = typeof body.company === 'string' ? body.company : undefined;

    try {
      const reply = await askAgent(
        conn,
        { id: crypto.randomUUID(), op: 'post', entity: 'stockitem', company, stockItem: body },
        rpcTimeoutMs,
      );
      if (reply.ok) {
        res.json({ agentId, ...reply.result as object });
        return;
      }
      res.status(502).json({ error: reply.error ?? 'Agent reported an unknown failure' });
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        res.status(504).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // post stock group to tally
  app.post(['/api/agents/:agentId/stockgroup', '/api/agents/:agentId/stockgroups'], async (req, res) => {
    const agentId = String(req.params.agentId);
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Request body must be valid JSON' });
      return;
    }

    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }

    const conn = agents.get(agentId);
    if (!conn) {
      res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
      return;
    }

    const company = typeof body.company === 'string' ? body.company : undefined;

    try {
      const reply = await askAgent(
        conn,
        { id: crypto.randomUUID(), op: 'post', entity: 'stockgroup', company, stockGroup: body },
        rpcTimeoutMs,
      );
      if (reply.ok) {
        res.json({ agentId, ...reply.result as object });
        return;
      }
      res.status(502).json({ error: reply.error ?? 'Agent reported an unknown failure' });
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        res.status(504).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // post unit to tally
  app.post(['/api/agents/:agentId/unit', '/api/agents/:agentId/units'], async (req, res) => {
    const agentId = String(req.params.agentId);
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Request body must be valid JSON' });
      return;
    }

    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }

    const conn = agents.get(agentId);
    if (!conn) {
      res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
      return;
    }

    const company = typeof body.company === 'string' ? body.company : undefined;

    try {
      const reply = await askAgent(
        conn,
        { id: crypto.randomUUID(), op: 'post', entity: 'unit', company, unit: body },
        rpcTimeoutMs,
      );
      if (reply.ok) {
        res.json({ agentId, ...reply.result as object });
        return;
      }
      res.status(502).json({ error: reply.error ?? 'Agent reported an unknown failure' });
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        res.status(504).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // runs the complete server-orchestrated 7-step bill processing workflow
  app.post(
    [
      '/api/agents/:agentId/process-bill',
      '/api/agents/:agentId/bill-image',
      '/api/agents/:agentId/bill',
      '/api/agents/:agentId/bills',
      '/api/agents/:agentId/vouchers/extract-and-post',
    ],
    async (req, res) => {
      const agentId = String(req.params.agentId);
      const conn = agents.get(agentId);
      if (!conn) {
        res.status(404).json({ error: `Agent "${agentId}" is not connected`, online: [...agents.keys()] });
        return;
      }

      let inputData: string | Buffer | ExtractedBillData | null = null;
      let mimeType: string | undefined = undefined;
      let company = typeof req.query.company === 'string' ? req.query.company : undefined;
      let autoPost = true;
      let tolerance = 1.0;

      const contentType = req.headers['content-type'] || '';

      if (contentType.includes('multipart/form-data') && Buffer.isBuffer(req.body)) {
        const parsed = parseMultipartFormData(req.body, contentType);
        const file = parsed.files.find((f) =>
          ['file', 'image', 'bill', 'invoice', 'attachment', 'media'].includes(f.fieldName.toLowerCase()),
        ) || parsed.files[0];

        if (!file) {
          res.status(400).json({ error: 'No file uploaded in form-data. Please add an image file with key "file" or "image".' });
          return;
        }
        inputData = file.data;
        mimeType = file.mimeType || 'image/jpeg';
        if (parsed.fields.company) company = parsed.fields.company;
        if (parsed.fields.autoPost !== undefined) autoPost = parsed.fields.autoPost !== 'false';
        if (parsed.fields.tolerance !== undefined) tolerance = Number(parsed.fields.tolerance) || 1.0;
      } else if (Buffer.isBuffer(req.body)) {
        inputData = req.body;
        const ct = req.headers['content-type'] || 'image/jpeg';
        mimeType = ct.split(';')[0].trim();
      } else if (req.body && typeof req.body === 'object') {
        const body = req.body as Record<string, unknown>;
        if (body.image || body.data) {
          inputData = (body.image || body.data) as string;
          mimeType = typeof body.mimeType === 'string' ? body.mimeType : undefined;
        } else if (body.vendor && body.bill) {
          inputData = body as unknown as ExtractedBillData;
        } else {
          res.status(400).json({ error: 'Request body must contain "image" (base64 string) or structured "vendor" and "bill" data' });
          return;
        }
        if (typeof body.company === 'string') company = body.company;
        if (typeof body.autoPost === 'boolean') autoPost = body.autoPost;
        if (typeof body.tolerance === 'number') tolerance = body.tolerance;
      } else {
        res.status(400).json({ error: 'Unsupported payload: send form-data, JSON with base64 image, or binary image/pdf buffer' });
        return;
      }

      console.log(
        `[Server] Bill image received: agent=${agentId} contentType=${(req.headers['content-type'] || '').split(';')[0].trim()} ` +
          `input=${Buffer.isBuffer(inputData) ? inputData.length + ' bytes' : typeof inputData === 'string' ? `string(${inputData.length} chars)` : 'structured JSON'} ` +
          `mimeType=${mimeType ?? 'n/a'} company=${company ?? '(active)'} autoPost=${autoPost}`,
      );

      const gateway = makeExpressAgentGateway(conn, agentId, rpcTimeoutMs);
      const result: BillWorkflowResult = await executeBillWorkflow(inputData, gateway, {
        company,
        autoPost,
        tolerance,
        mimeType,
        geminiApiKey: opts.geminiApiKey,
      });

      if (result.status === 'review_required') {
        res.status(422).json({
          agentId,
          ...result,
        });
        return;
      }

      if (result.status === 'validation_error') {
        res.status(400).json({
          agentId,
          ...result,
        });
        return;
      }

      if (result.status === 'master_creation_error' || result.status === 'tally_error') {
        res.status(502).json({
          agentId,
          ...result,
        });
        return;
      }

      res.status(200).json({
        agentId,
        ...result,
      });
    },
  );

  // POST /api/extract-bill — extract invoice without posting to an agent.
  app.post('/api/extract-bill', async (req, res) => {
    let imageInput: string | Buffer | null = null;
    let mimeType: string | undefined = undefined;
    let company = typeof req.query.company === 'string' ? req.query.company : undefined;

    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data') && Buffer.isBuffer(req.body)) {
      const parsed = parseMultipartFormData(req.body, contentType);
      const file = parsed.files.find((f) =>
        ['file', 'image', 'bill', 'invoice', 'attachment', 'media'].includes(f.fieldName.toLowerCase()),
      ) || parsed.files[0];

      if (!file) {
        res.status(400).json({ error: 'No file uploaded in form-data. Please add an image file with key "file" or "image".' });
        return;
      }
      imageInput = file.data;
      mimeType = file.mimeType || 'image/jpeg';
      if (parsed.fields.company) company = parsed.fields.company;
    } else if (Buffer.isBuffer(req.body)) {
      imageInput = req.body;
      const ct = req.headers['content-type'] || 'image/jpeg';
      mimeType = ct.split(';')[0].trim();
    } else if (req.body && typeof req.body === 'object') {
      const body = req.body as Record<string, unknown>;
      if (!body.image && !body.data) {
        res.status(400).json({ error: 'Request body must contain "image" (base64 string or data URL)' });
        return;
      }
      imageInput = (body.image || body.data) as string;
      mimeType = typeof body.mimeType === 'string' ? body.mimeType : undefined;
      if (typeof body.company === 'string') company = body.company;
    } else {
      res.status(400).json({ error: 'Unsupported payload: send form-data, JSON with base64 image, or binary image buffer' });
      return;
    }

    try {
      const billData = await extractBillDataFromImage(imageInput, {
        mimeType,
        company,
        apiKey: opts.geminiApiKey,
      });
      res.json({ ok: true, bill: billData });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: `Gemini extraction failed: ${error}` });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/agent' });

  server.on('upgrade', (req, socket) => {
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const agentId = String(req.headers['x-agent-id'] ?? '').trim();
    if (!agentId) return ws.close(4400, 'x-agent-id header required');

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
      if (!pending) return;
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

  const originalClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    return originalClose(cb);
  }) as typeof server.close;

  return server;
}

if (require.main === module) {
  try {
    // @ts-ignore
    process.loadEnvFile?.();
  } catch {}

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error('API_KEY env var is required (set it in .env or environment)');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 8080;
  createExpressBridge({ apiKey, geminiApiKey: process.env.GEMINI_API_KEY }).listen(port, () =>
    console.log(`express bridge listening on :${port}`),
  );
}
