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
<div id="sheet" role="dialog"><div><p id="sheet-text"></p><button data-testid="confirmationSheetConfirm" id="yes">Unfollow</button>
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
    (u.bio ? '<div data-testid="UserDescription">' + u.bio + '</div>' : '') +
    '<button role="button" data-testid="' + u.id + '-unfollow">Following</button>';
  el.querySelector('button').onclick = (e) => {
    pending = { u, btn: e.currentTarget };
    document.getElementById('sheet-text').textContent = 'Unfollow @' + (u.sheetName || u.handle) + '?';
    sheet.className = 'on';
  };
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
  if (r.headers.get('x-wedge')) { for (;;) {} } // simulate a renderer that hangs
  if (r.status === 200) { btn.setAttribute('data-testid', u.id + '-follow'); btn.textContent = 'Follow'; }
  else toast('Something went wrong.');
};
if (!document.body.dataset.nolist) loadMore();
</script></body></html>`;

// Options (all optional):
//   destroyFault(callNo, user) -> {status, code, headers}|null   fail an unfollow call
//   destroyWedge(callNo) -> bool      after answering, make the page hang in an endless loop (wedged renderer)
//   destroyGhost(user) -> bool        answer 200 but keep the user in the list (stale list / ignored action)
//   listFault(callNo) -> {status, headers}|{hang:true}|{empty:true}|null
//   homeFault(callNo) -> bool         drop the connection for /home
//   bios {handle: html}               bio markup inside that user's cell (e.g. an @mention link)
//   sheetNames {handle: name}         what the confirmation sheet claims to unfollow
//   profileCount() -> number|undefined  override the "N Following" shown on the profile
//   followingRedirect: path           302 the following page somewhere else (consent flow, etc.)
export async function startMockX({
  count = 45,
  pageSize = 20,
  me = 'tester',
  destroyFault = () => null,
  destroyGhost = () => false,
  destroyWedge = () => false,
  listFault = () => null,
  homeFault = () => false,
  bios = {},
  sheetNames = {},
  profileCount = () => undefined,
  followingRedirect = null,
  host = '127.0.0.1',
} = {}) {
  const state = {
    following: Array.from({ length: count }, (_, i) => {
      const handle = `user${String(i).padStart(3, '0')}`;
      return { id: String(1000 + i), handle, bio: bios[handle], sheetName: sheetNames[handle] };
    }),
    destroyCalls: 0,
    destroyed: [],
    listCalls: 0,
    homeCalls: 0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookies = Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    const authed = cookies.auth_token === 'good-token';
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith('/i/flow/') && url.pathname !== '/i/flow/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<main><p>Please verify it is you.</p></main>');
    }
    if (url.pathname === '/i/flow/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<a data-testid="loginButton" href="/login">Log in</a>');
    }
    if (!url.pathname.startsWith('/i/api/') && !authed) {
      res.writeHead(302, { location: '/i/flow/login' });
      return res.end();
    }
    if (url.pathname === '/home') {
      state.homeCalls += 1;
      if (homeFault(state.homeCalls)) return req.socket.destroy(); // simulate a dropped connection
    }
    if (followingRedirect && url.pathname.endsWith('/following') && !url.pathname.startsWith('/i/api/')) {
      res.writeHead(302, { location: followingRedirect });
      return res.end();
    }
    if (!url.pathname.startsWith('/i/api/') && (url.pathname === '/home' || url.pathname.endsWith('/following'))) {
      res.writeHead(200, { 'content-type': 'text/html' });
      const html = APP.replace('__ME__', me);
      return res.end(url.pathname === '/home' ? html.replace('<body>', '<body data-nolist="1">') : html);
    }
    if (url.pathname === `/${me}`) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<main><a href="/${me}/following" role="link"><span>${(profileCount() ?? state.following.length).toLocaleString('en-US')}</span> <span>Following</span></a></main>`);
    }
    if (url.pathname === '/i/api/graphql/following') {
      state.listCalls += 1;
      const fault = listFault(state.listCalls);
      if (fault?.hang) return; // never answer
      if (fault?.empty) return json(200, { users: [], next: null });
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
        const id = new URLSearchParams(body).get('user_id');
        const idx = state.following.findIndex((u) => u.id === id);
        const user = idx >= 0 ? state.following[idx] : null;
        const fault = destroyFault(state.destroyCalls, user);
        if (fault) return json(fault.status, { errors: [{ code: fault.code }] }, fault.headers);
        if (user) {
          state.destroyed.push(user.handle);
          if (!destroyGhost(user)) state.following.splice(idx, 1);
        }
        return json(200, { id }, destroyWedge(state.destroyCalls) ? { 'x-wedge': '1' } : {});
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, host, resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
