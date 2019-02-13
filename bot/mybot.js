// ===== import =====

const http = require('http');
const https = require('https');

// ===== config =====

const DOCKER_SOCK = '/run/docker.sock';
const DOCKER_API_VERSION = 'v1.38';
const REGISTRY_USER = process.env['REGISTRY_USER'];
const REGISTRY_PASS = process.env['REGISTRY_PASS'];
const TELEGRAM_TOKEN = process.env['TELEGRAM_TOKEN'];
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'];


// ===== helper =====

function _do_req(req, body) {
  return new Promise((ok, fail) => {
    req
      .on('error', fail)
      .on('response', res => {
        let body = '';
        res
          .on('error', fail)
          .setEncoding('utf8')
          .on('data', data => body += data)
          .on('end', () => ok({
            code: res.statusCode,
            headers: res.headers,
            body: body,
          }));
      })
      .end(body, 'utf8');
  });
}

function httpreq_unix(socket, method, path, headers, body) {
  return _do_req(http.request({
    socketPath: socket,
    method: method,
    path: path,
    headers: headers,
  }), body);
}

function httpsreq_tcp(method, url, headers, body) {
  url = new URL(url);
  return _do_req(https.request({
    host: url.hostname,
    port: url.port,
    method: method,
    path: url.pathname + url.search,
    headers: headers,
  }), body);
}

function read_all(stream) {
  return new Promise((ok, fail) => {
    let buffer = '';
    stream
      .once('error', fail)
      .on('data', data => buffer += data)
      .once('end', () => ok(buffer));
  });
}


// ===== docker =====

async function list_container(show_all) {
  if (show_all) show_all = 'true';
  else show_all = 'false';
  let { code, _, body } = await httpreq_unix(DOCKER_SOCK,
    'GET', `/${DOCKER_API_VERSION}/containers/json?all=${show_all}`, {}, '',
  );
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return JSON.parse(body);
}

async function container_exists(id) {
  let filters = JSON.stringify({ id: [id] });
  let { code, _, body } = await httpreq_unix(DOCKER_SOCK,
    'GET', `/${DOCKER_API_VERSION}/containers/json?all=true&filters=${encodeURIComponent(filters)}`, {}, '',
  );
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return JSON.parse(body).length > 0;
}

async function create_container(name, image, net) {
  let { code, _, body } = await httpreq_unix(DOCKER_SOCK,
    'POST', `/${DOCKER_API_VERSION}/containers/create?name=${encodeURIComponent(name)}`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({
      Image: image,
      HostConfig: {
        NetworkMode: net,
      },
    }),
  );
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return JSON.parse(body).Id;
}

async function _container_operation(id, operation) {
  return await httpreq_unix(DOCKER_SOCK,
    'POST', `/${DOCKER_API_VERSION}/containers/${id}/${operation}`, {}, '',
  );
}

async function start_container(id) {
  let { code, _, body } = await _container_operation(id, 'start');
  if (code == 304) { // already started
    return false;
  }
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return true;
}

async function stop_container(id) {
  let { code, _, body } = await _container_operation(id, 'stop');
  if (code == 304) { // already stopped
    return false;
  }
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return true;
}

async function kill_container(id) {
  let { code, _, body } = await _container_operation(id, 'kill');
  if (code == 409) { // container not running
    return false;
  }
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return true;
}

async function remove_container(id) {
  let { code, _, body } = await httpreq_unix(DOCKER_SOCK,
    'DELETE', `/${DOCKER_API_VERSION}/containers/${id}?force=true`, {}, '',
  );
  if (code == 404) { // container already removed
    return false;
  }
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
  return true;
}

async function pull_image(image, username, password) {
  let serveraddress = image.split('/', 1)[0];
  let { code, _, body } = await httpreq_unix(DOCKER_SOCK,
    'POST', `/${DOCKER_API_VERSION}/images/create?fromImage=${encodeURIComponent(image)}`,
    {
      'X-Registry-Auth': Buffer.from(JSON.stringify({
        username: username,
        password: password,
        serveraddress: serveraddress,
      })).toString('base64'),
    },
    '',
  );
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
}


// ===== telegram =====

async function send_telegram_msg(msg, command, data) {
  let payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: msg,
  };
  if (command && data) {
    payload.reply_markup = {
      inline_keyboard: [[{
        text: command,
        callback_data: data,
      }]],
    };
  }

  let { code, _, body } = await httpsreq_tcp(
    'POST', `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { 'Content-Type': 'application/json' },
    JSON.stringify(payload),
  );
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
}

async function answer_telegram_callback(id) {
  let { code, _, body } = await httpsreq_tcp(
    'GET', `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery?callback_query_id=${encodeURIComponent(id)}`, {}, '',
  );
  if (!(200 <= code && code < 300)) {
    throw new Error(`got http code ${code}, expected [200,300), the body:\n${body}`);
  }
}


// ===== main =====

http.createServer()
  .on('error', err => console.error(`server error: ${err.message}`))
  .on('listening', () => console.log('bot is running'))
  .listen({ port: 8080 })
  .on('request', (req, res) => {
    (async () => {
      req.setEncoding('utf8');
      if (req.url == '/a0362dc339959f93451937ae76b5e7e6/registry') {
        await on_registry_event(req, res);
      } else if (req.url == '/a0362dc339959f93451937ae76b5e7e6/telegram') {
        await on_telegram_event(req, res);
      } else {
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(404);
        res.end('404 Not Found');
      }
    })().catch(err => {
      console.error(`Handling error: ${err.message}\n${err.stack}`);
      res.socket.destroy();
    });
  });

async function on_registry_event(req, res) {
  let data = JSON.parse(await read_all(req)).events.filter(ev => {
    try {
      return ev.action == 'push' &&
        ev.target.mediaType == 'application/vnd.docker.distribution.manifest.v2+json' &&
        ev.target.repository == 'myapp' &&
        typeof ev.target.repository == 'string';
    } catch (_) {
      return false;
    }
  });

  for (let ev of data) {
    console.log(`got registry event: pushed: ${ev.target.tag}`);
    send_telegram_msg(
      `New image pushed: ${ev.target.tag}`,
      'Deploy',
      JSON.stringify({ command: 'deploy', tag: ev.target.tag }),
    ).catch(err => {
      console.error(`Error send_telegram_msg: ${err.message}\n${err.stack}`);
    });
  }

  res.end('OK');
}

async function on_telegram_event(req, res) {
  let data = null;
  try {
    data = JSON.parse(await read_all(req)).callback_query;
  } catch (_) { }
  if (data) {
    await answer_telegram_callback(data.id);
    if (data.message.chat.username != 'kurnia_d_win') {
      console.log('got telegram event: but with wrong sender');
    } else {
      do_deploy(data.data);
    }
  }

  res.end('OK');
}

let on_progres = false;

function do_deploy(payload) {
  try {
    payload = JSON.parse(payload);
  } catch (_) {
    payload = {};
  }
  if (payload.command != 'deploy') return;
  setImmediate(() => {
    (async () => {
      let tag = payload.tag;
      let name = 'myapp';
      let image = `registry.demo-docker.kurniadwin.to/myapp:${tag}`;
      console.log(`got telegram event: deploy: ${tag}`);
      if (on_progres) {
        console.log('warning: already on_progress, ignoring');
      } else {
        on_progres = true;
        await send_telegram_msg(`Deploying: ${tag}`);
        await pull_image(image, REGISTRY_USER, REGISTRY_PASS);
        await remove_container(name);
        await create_container(name, image, 'net0');
        await start_container(name);
        await send_telegram_msg(`Deployed: ${tag}`);
        on_progres = false;
      }
    })().catch(err => {
      console.error(`do_deploy error: ${err.message}\n${err.stack}`);
      on_progres = false;
    });
  });
}
