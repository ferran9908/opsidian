// A stand-in for GitHub, for driving the app's GitHub screens in a test: the device sign-in,
// the few API calls Opsidian makes, and real git over HTTP through `git http-backend`, which
// accepts only the token the sign-in handed out.
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const TOKEN = 'gho_test_token';
const USER = { login: 'tester', id: 4242, name: 'Test Person' };

function fakeGitHub(root) {
  mkdirSync(join(root, USER.login), { recursive: true });
  let polls = 0;
  const repository = (name) => {
    const path = join(root, USER.login, `${name}.git`);
    if (!existsSync(path)) return undefined;
    const empty = !execFileSync('git', ['--git-dir', path, 'for-each-ref'], {
      encoding: 'utf8',
    }).trim();
    return {
      full_name: `${USER.login}/${name}`,
      private: true,
      clone_url: `${server.url}/${USER.login}/${name}.git`,
      size: empty ? 0 : 1,
      created_at: '2026-01-01T00:00:00Z',
      pushed_at: empty ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z',
      permissions: { push: true },
    };
  };
  const create = (name) => {
    const path = join(root, USER.login, `${name}.git`);
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', path]);
    execFileSync('git', ['--git-dir', path, 'config', 'http.receivepack', 'true']);
    return path;
  };
  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const body = (request) =>
    new Promise((resolve) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (path === '/login/device/code' && request.method === 'POST') {
      server.signIns++;
      return send(response, 200, {
        device_code: 'device-123',
        user_code: 'WDJB-MJHT',
        verification_uri: `${server.url}/login/device`,
        expires_in: 900,
        interval: 1,
      });
    }
    if (path === '/login/oauth/access_token' && request.method === 'POST') {
      // Approved on the second look, as when a person takes a moment to paste the code.
      polls++;
      return send(
        response,
        200,
        polls % 2
          ? { error: 'authorization_pending' }
          : { access_token: TOKEN, token_type: 'bearer' },
      );
    }
    // git over HTTP: /owner/name.git/…
    const git = path.match(/^\/([\w.-]+)\/([\w.-]+\.git)(\/.*)$/);
    if (git) {
      const basic = (request.headers.authorization ?? '').replace(/^Basic /, '');
      const password = Buffer.from(basic, 'base64').toString('utf8').split(':')[1];
      if (password !== TOKEN) {
        server.refusedGit++;
        response.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
        return response.end();
      }
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: `/${git[1]}/${git[2]}${git[3]}`,
          REQUEST_METHOD: request.method,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          REMOTE_USER: USER.login,
          REMOTE_ADDR: '127.0.0.1',
          ...(request.headers['content-encoding']
            ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] }
            : {}),
          ...(request.headers['git-protocol']
            ? { GIT_PROTOCOL: request.headers['git-protocol'] }
            : {}),
        },
      });
      request.pipe(child.stdin);
      let head = Buffer.alloc(0);
      let started = false;
      child.stdout.on('data', (chunk) => {
        if (started) return response.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        started = true;
        let status = 200;
        const headers = {};
        for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
          const at = line.indexOf(':');
          const name = line.slice(0, at).trim();
          const value = line.slice(at + 1).trim();
          if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
          else headers[name] = value;
        }
        response.writeHead(status, headers);
        response.write(head.subarray(end + 4));
      });
      child.on('close', () => response.end());
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`)
      return send(response, 401, { message: 'Bad credentials' });
    if (path === '/user') return send(response, 200, USER);
    if (path === '/user/repos' && request.method === 'GET') {
      const names = readdirSync(join(root, USER.login))
        .filter((name) => name.endsWith('.git'))
        .map((name) => name.slice(0, -4));
      return send(response, 200, names.map(repository));
    }
    if (path === '/user/repos' && request.method === 'POST') {
      const { name } = await body(request);
      if (repository(name))
        return send(response, 422, {
          message: 'Repository creation failed.',
          errors: [{ message: 'name already exists on this account' }],
        });
      create(name);
      return send(response, 201, repository(name));
    }
    const repo = path.match(/^\/repos\/([\w.-]+)\/([\w.-]+)$/);
    if (repo && repo[1] === USER.login && repository(repo[2]))
      return send(response, 200, repository(repo[2]));
    return send(response, 404, { message: 'Not Found' });
  });
  server.signIns = 0;
  server.refusedGit = 0;
  server.create = create;
  server.start = () =>
    new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        server.url = `http://127.0.0.1:${server.address().port}`;
        resolve(server.url);
      }),
    );
  return server;
}

module.exports = { fakeGitHub, TOKEN, USER };
