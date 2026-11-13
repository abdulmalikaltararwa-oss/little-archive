import http from 'node:http';
import {createHash} from 'node:crypto';

// Every import mutation goes to the real FastAPI application. Fault modes can
// drop a batch response after commit, or deliberately rewrite only protocol
// discovery metadata to exercise older/unsupported server declarations.
export async function createFaultProxy(baseURL) {
  const upstream=new URL(baseURL);
  if (upstream.protocol!=='http:' || !['127.0.0.1','localhost'].includes(upstream.hostname)) {
    throw new Error('Extension CI requires the disposable loopback server harness.');
  }
  let dropBatchResponses=false;
  let statusMode='real';
  const attempts=[];
  const sockets=new Set();
  const server=http.createServer(async (request,response) => {
    if (!request.url?.startsWith('/api/extension/')) {
      response.writeHead(404,{'Content-Type':'application/json'});
      response.end('{"detail":"Test relay exposes extension endpoints only."}');
      return;
    }
    try {
      const chunks=[];
      let size=0;
      for await (const chunk of request) {
        size+=chunk.length;
        if (size>256*1024) throw new Error('Batch exceeds the production request limit.');
        chunks.push(chunk);
      }
      const body=Buffer.concat(chunks);
      const isBatch=request.method==='POST' && /\/batches$/.test(request.url);
      const observation=isBatch ? {
        body:JSON.parse(body.toString('utf8')),
        bytes:body.length,
        digest:createHash('sha256').update(body).digest('hex'),
        protocol:request.headers['x-little-archive-protocol'] ?? null,
        status:null,
        replayed:null,
        responseDropped:false,
      } : null;
      if (observation) attempts.push(observation);
      const remote=http.request(new URL(request.url,upstream), {
        method:request.method,
        headers:{...request.headers, host:upstream.host, connection:'close'},
      }, result => {
        const responseChunks=[];
        result.on('data', chunk => responseChunks.push(chunk));
        result.on('end', () => {
          let bytes=Buffer.concat(responseChunks);
          if (observation) {
            observation.status=result.statusCode;
            try { observation.replayed=JSON.parse(bytes.toString('utf8')).replayed ?? null; } catch { /* Keep status for diagnostics. */ }
          }
          if (observation && result.statusCode===200 && dropBatchResponses) {
            observation.responseDropped=true;
            // The real server has already committed. The browser sees a
            // failed request and must retain precisely the original batch.
            response.destroy();
            return;
          }
          if (request.method==='GET' && request.url==='/api/extension/status' && result.statusCode===200 && statusMode!=='real') {
            const status=JSON.parse(bytes.toString('utf8'));
            if (statusMode==='legacy') {
              status.version='0.1.0';
              delete status.extension_protocol;
            } else {
              status.extension_protocol={name:'little-archive.extension',versions:{'2':{}}};
            }
            bytes=Buffer.from(JSON.stringify(status));
          }
          const headers={...result.headers,'Content-Length':String(bytes.length)};
          delete headers['transfer-encoding'];
          delete headers['content-length'];
          response.writeHead(result.statusCode || 502,headers);
          response.end(bytes);
        });
        result.on('error', () => response.destroy());
      });
      remote.setTimeout(10_000, () => remote.destroy(new Error('Local test server timeout.')));
      remote.on('error', () => {
        if (!response.headersSent) response.writeHead(502,{'Content-Type':'application/json'});
        response.end('{"detail":"Local test relay could not reach the server."}');
      });
      remote.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(400,{'Content-Type':'application/json'});
      response.end('{"detail":"Invalid test relay request."}');
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  return {
    origin:`http://127.0.0.1:${server.address().port}`,
    attempts,
    setDropBatchResponses(value) { dropBatchResponses=Boolean(value); },
    setStatusMode(value) {
      if (!['real','legacy','unsupported'].includes(value)) throw new Error('Unknown synthetic compatibility fault.');
      statusMode=value;
    },
    async close() {
      const closed=new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
