import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerEngineError, socketDockerEngine } from '../../server/runners/docker-engine';

/** A Docker Engine on a temporary unix socket, answering every request with `reply`. */
async function engineAnswering(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movy-docker-'));
  const socketPath = path.join(dir, 'docker.sock');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    reply(req, res);
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  servers.push({ server, dir });
  return { engine: socketDockerEngine(socketPath), seen };
}

const servers: { server: http.Server; dir: string }[] = [];
afterEach(async () => {
  for (const { server, dir } of servers.splice(0)) {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('socketDockerEngine', () => {
  it('parses a JSON answer and encodes the label filter into the query', async () => {
    const { engine, seen } = await engineAnswering((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ Id: 'abc', Names: ['/r'], State: 'running', Labels: {}, Created: 1 }]));
    });

    const list = await engine.listContainers(['movy.runner-template=default'], true);

    expect(list[0]!.Id).toBe('abc');
    expect(seen[0]).toBe(
      `GET /v1.43/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['movy.runner-template=default'] }))}`
    );
  });

  it('resolves an empty 204 to nothing', async () => {
    const { engine } = await engineAnswering((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await expect(engine.start('abc')).resolves.toBeUndefined();
  });

  it('rejects with the engine\'s own message and status', async () => {
    const { engine } = await engineAnswering((_req, res) => {
      res.statusCode = 409;
      res.end(JSON.stringify({ message: 'Conflict. The container name "/r" is already in use.' }));
    });
    const err = await engine.create('r', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerEngineError);
    expect(err).toMatchObject({ statusCode: 409, message: 'Docker: Conflict. The container name "/r" is already in use.' });
  });

  it('rejects an error whose body is not JSON with its text', async () => {
    const { engine } = await engineAnswering((_req, res) => {
      res.statusCode = 500;
      res.end('upstream gone');
    });
    await expect(engine.inspect('abc')).rejects.toMatchObject({ statusCode: 500, message: 'Docker: upstream gone' });
  });

  it('rejects a success whose body is not JSON, rather than throwing out of the response handler', async () => {
    // Thrown inside the 'end' listener, the parse error escaped the promise as
    // an uncaught exception and took the whole console down.
    const { engine } = await engineAnswering((_req, res) => {
      res.statusCode = 200;
      res.end('<html>proxy</html>');
    });
    const err = await engine.inspect('abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerEngineError);
    expect(err).toMatchObject({ statusCode: 200 });
  });
});
