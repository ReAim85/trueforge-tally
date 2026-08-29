// proxy that patches trueforge requests for cerebras compatibility
// strips reasoning_content, converts file blocks, captures images for tools

import http from 'node:http';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CEREBRAS_URL = 'https://api.cerebras.ai';
const PORT = Number(process.env.PROXY_PORT) || 9100;

// store captured images so the mcp server can access them
const IMAGE_DIR = join(import.meta.dirname, 'captured-images');
if (!existsSync(IMAGE_DIR)) mkdirSync(IMAGE_DIR, { recursive: true });

// track the latest captured image for easy access
let latestImageId = null;

const server = http.createServer(async (req, res) => {
  // serve captured images
  if (req.method === 'GET' && req.url?.startsWith('/images/')) {
    const filename = req.url.split('/').pop();
    const filepath = join(IMAGE_DIR, filename);
    if (existsSync(filepath)) {
      const ext = filename.split('.').pop();
      const mime = ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
      res.writeHead(200, { 'content-type': mime });
      res.end(readFileSync(filepath));
      return;
    }
    res.writeHead(404);
    res.end('not found');
    return;
  }

  // return the latest image as base64 for the mcp tool
  if (req.method === 'GET' && req.url === '/latest-image') {
    if (latestImageId) {
      const files = ['png', 'jpg', 'jpeg', 'pdf'].map(ext => join(IMAGE_DIR, `${latestImageId}.${ext}`));
      const found = files.find(f => existsSync(f));
      if (found) {
        const data = readFileSync(found);
        const ext = found.split('.').pop();
        const mime = ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: latestImageId,
          base64: data.toString('base64'),
          mimeType: mime,
        }));
        return;
      }
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'no image captured yet' }));
    return;
  }

  const target = `${CEREBRAS_URL}${req.url}`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks).toString();

  if (req.url?.includes('/chat/completions') && body) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          delete msg.reasoning_content;

          if (Array.isArray(msg.content)) {
            msg.content = msg.content.map(block => {
              // convert file blocks to image_url
              if (block.type === 'file' && block.file?.url) {
                return { type: 'image_url', image_url: { url: block.file.url } };
              }
              if (block.type === 'file' && block.file?.data) {
                const mime = block.file.mime_type || 'image/jpeg';
                return { type: 'image_url', image_url: { url: `data:${mime};base64,${block.file.data}` } };
              }

              // capture data uri images from user messages so mcp tools can access them
              if (block.type === 'image_url' && msg.role === 'user') {
                const url = block.image_url?.url || '';
                const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
                if (dataMatch) {
                  const mime = dataMatch[1];
                  const b64 = dataMatch[2];
                  const ext = mime.includes('png') ? 'png' : mime.includes('pdf') ? 'pdf' : 'jpg';
                  const id = randomUUID().slice(0, 8);
                  latestImageId = id;
                  const filepath = join(IMAGE_DIR, `${id}.${ext}`);
                  writeFileSync(filepath, Buffer.from(b64, 'base64'));
                  console.log(`captured image: ${id}.${ext} (${(b64.length * 0.75 / 1024).toFixed(0)}kb)`);
                }
              }

              return block;
            });
          }
        }
      }
      body = JSON.stringify(parsed);
    } catch {}
  }

  const headers = { ...req.headers, host: 'api.cerebras.ai', 'content-length': Buffer.byteLength(body).toString() };

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method !== 'GET' ? body : undefined,
    });

    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));

    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    } else {
      res.end(await upstream.text());
    }
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`cerebras proxy running on port ${PORT}`);
  console.log(`forwarding to ${CEREBRAS_URL}`);
  console.log(`latest image endpoint: http://localhost:${PORT}/latest-image`);
  console.log(`use http://localhost:${PORT}/v1 as your base url in trueforge`);
});
