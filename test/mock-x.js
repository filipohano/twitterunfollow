// A tiny stand-in for x.com's following page: same data-testid structure the bot relies on,
// infinite scroll with cursors, a confirm dialog, and a friendships/destroy endpoint that can
// be told to fail. Lets us test the whole bot without touching the real site.
import http from 'node:http';

const APP = `<!doctype html><html><head><style>
  body{margin:0;font:14px sans-serif} .cell{height:84px;box-sizing:border-box;padding:12px;border-bottom:1px solid #ddd}
  #sheet{position:fixed;inset:0;background:#0008;display:none} #sheet.on{display:block}
  #sheet div{background:#fff;margin:200px auto;padding:20px;width:240px}
  #toast{position:fixed;bottom:10px;left:10px}
</style></head><body>
<nav><a data-testid="AppTabBar_Profile_Link" href="/__ME__">Profile</a></nav>
<div data-testid="primaryColumn" id="col"></div>
<div id="sheet"><div><button data-testid="confirmationSheetConfirm" id="yes">Unfollow</button>
<button data-testid="confirmationSheetCancel" id="no">Cancel</button></div></div>
<div id="toast"></div>
<script>
const col = document.getElementById('col'), sheet = document.getElementById('sheet');
let next = '', more = true, loading = false, pending = null;
const csrf = () => (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '';
const toast = (t) => { document.getElementById('toast').innerHTML = '<div data-testid="toast">' + t + '</div>'; };

function cell(u) {
  const el = document.createElement('div');
  el.className = 'cell'; el.setAttribute('data-testid', 'UserCell');
  el.innerHTML = '<a role="link" href="/' + u.handle + '"><img width=40 height=40 alt=""></a>' +
    '<a role="link" href="/' + u.handle + '"><span>' + u.handle + ' name</span></a>' +
    '<a role="link" href="/' + u.handle + '"><span>@' + u.handle + '</span></a>' +
    '<button role="button" data-testid="' + u.id + '-unfollow">Following</button>';
  el.querySelector('button').onclick = (e) => { pending = { u, btn: e.currentTarget }; sheet.className = 'on'; };
  return el;
}
async function loadMore() {
  if (loading || !more) return; loading = true;
  const r = await fetch('/i/api/graphql/following?cursor=' + encodeURIComponent(next));
  if (r.status !== 200) { loading = false; col.insertAdjacentHTML('beforeend', '<div>Something went wrong. Try reloading.</div>'); return; }
  const j = await r.json();
  j.users.forEach((u) => col.append(cell(u)));
  next = j.next; more = !!j.next; loading = false;
  if (innerHeight + scrollY > document.documentElement.scrollHeight - 400) loadMore();
}
addEventListener('scroll', () => { if (innerHeight + scrollY > document.documentElement.scrollHeight - 400) loadMore(); });
document.getElementById('no').onclick = () => { sheet.className = ''; pending = null; };
document.getElementById('yes').onclick = async () => {
  const { u, btn } = pending; sheet.className = ''; pending = null;
  const r = await fetch('/i/api/1.1/friendships/destroy.json', { method: 'POST', headers: { 'x-csrf-token': csrf(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'user_id=' + u.id });
  if (r.status === 200) { btn.setAttribute('data-testid', u.id + '-follow'); btn.textContent = 'Follow'; }
  else toast('Something went wrong.');
};
loadMore();
</script></body></html>`;

export async function startMockX({ count = 45, pageSize = 20, me = 'tester', destroyFault = () => null, listFault = () => null } = {}) {
  const state = {
    following: Array.from({ length: count }, (_, i) => ({ id: String(1000 + i), handle: `user${String(i).padStart(3, '0')}` })),
    destroyCalls: 0,
    destroyed: [],
    listCalls: 0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookies = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    const authed = cookies.auth_token === 'good-token';
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/i/flow/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<a data-testid="loginButton" href="/login">Log in</a>');
    }
    if (!url.pathname.startsWith('/i/api/') && !authed) {
      res.writeHead(302, { location: '/i/flow/login' });
      return res.end();
    }
    if (!url.pathname.startsWith('/i/api/') && (url.pathname === '/home' || url.pathname.endsWith('/following'))) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(APP.replace('__ME__', me));
    }
    if (url.pathname === '/i/api/graphql/following') {
      state.listCalls += 1;
      const fault = listFault(state.listCalls);
      if (fault) return json(fault.status, { errors: [] }, fault.headers);
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? state.following.findIndex((u) => u.id > cursor) : 0;
      const slice = start < 0 ? [] : state.following.slice(start, start + pageSize);
      const hasMore = start >= 0 && start + pageSize < state.following.length;
      return json(200, { users: slice, next: hasMore ? slice.at(-1).id : null });
    }
    if (url.pathname === '/i/api/1.1/friendships/destroy.json' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        state.destroyCalls += 1;
        if (!authed || req.headers['x-csrf-token'] !== 'good-ct0') return json(403, { errors: [{ code: 353 }] });
        const fault = destroyFault(state.destroyCalls);
        if (fault) return json(fault.status, { errors: [{ code: fault.code }] }, fault.headers);
        const id = new URLSearchParams(body).get('user_id');
        const idx = state.following.findIndex((u) => u.id === id);
        if (idx >= 0) state.destroyed.push(...state.following.splice(idx, 1).map((u) => u.handle));
        return json(200, { id });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
