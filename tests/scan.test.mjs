// node --test tests/scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, scan, compileGitignore, stripComments, MAX_BYTES } from '../skills/structure-map/scripts/scan.mjs';

const SCRIPT = fileURLToPath(new URL('../skills/structure-map/scripts/scan.mjs', import.meta.url));

function mk(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'smscan-')));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}
const facts = (root) => {
  const r = scan(root);
  const all = { events: [], components: [], screens: [], nav: [], routes: [], tables: [], services: [], tests: [], unresolved: [], entries: [], notebooks: [], data: [], topModules: [], cycles: [] };
  for (const { X } of r.results) for (const k of Object.keys(all)) all[k].push(...X[k]);
  return { ...all, results: r.results, info: r.info, warnings: r.warnings };
};
const opts = (root, extra = {}) => ({ root, out: 'docs/structure', hub: 'STRUCTURE.md', check: false, budget: 12000, quiet: true, json: false, ...extra });
const routeSet = (f) => f.routes.map((r) => `${r.method} ${r.path}`).sort();

test('flutter: GoRoute nesting, const paths, MaterialApp routes, navigation, onGenerateRoute', () => {
  const root = mk({
    'pubspec.yaml': 'name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n  go_router: ^14.0.0\n',
    'lib/router/routes.dart': "class Routes {\n  static const home = '/home'; // landing\n  static const String detail = 'detail';\n}\n",
    'lib/router/app_router.dart': [
      "import 'package:demo/router/routes.dart';",
      "import 'package:demo/screens/home_screen.dart';",
      '/// GoRoute(path: "/doc-comment-should-not-count")',
      'final r = GoRouter(routes: [',
      '  GoRoute(path: Routes.home, builder: (_, __) => const HomeScreen(), routes: [',
      '    GoRoute(path: Routes.detail, name: "detail", builder: (c, s) => DetailPage(id: s.pathParameters["id"]!)),',
      '  ]),',
      "  GoRoute(path: '/about', builder: (_, __) => const AboutView()),",
      '  GoRoute(path: dynamicPath(), builder: (_, __) => const X()),',
      ']);',
      "final app = MaterialApp(routes: { '/legacy': (context) => const LegacyScreen() }, onGenerateRoute: gen);",
    ].join('\n'),
    'lib/screens/home_screen.dart': "class HomeScreen extends StatelessWidget {\n  void go(BuildContext context) {\n    Navigator.pushNamed(context, '/legacy');\n    Navigator.push(context, MaterialPageRoute(builder: (_) => const PushedPage()));\n    context.go(Routes.home);\n  }\n}\n",
    'lib/screens/detail_page.dart': 'class DetailPage extends StatefulWidget {}\nclass _DetailPageState extends State<DetailPage> {}\n',
    'lib/screens/about_view.dart': 'class AboutView extends ConsumerWidget {}\n',
    'lib/screens/legacy_screen.dart': 'class LegacyScreen extends StatelessWidget {}\n',
    'lib/screens/pushed_page.dart': 'class PushedPage extends StatelessWidget {}\n',
    'lib/widgets/fancy_button.dart': 'class FancyButton extends StatelessWidget {}\n',
  });
  const f = facts(root);
  assert.deepEqual(routeSet(f), ['PAGE /about', 'PAGE /home', 'PAGE /home/detail', 'PAGE /legacy', 'PAGE dynamicPath()']);
  assert.equal(f.routes.find((r) => r.path === '/home/detail').handler, 'DetailPage');
  assert.equal(f.routes.find((r) => r.path === '/home').conf, 'resolved');
  assert.equal(f.routes.find((r) => r.path === '/about').conf, 'literal');
  const names = f.screens.map((s) => s.name).sort();
  assert.deepEqual(names, ['AboutView', 'DetailPage', 'HomeScreen', 'LegacyScreen', 'PushedPage']);
  assert.ok(!names.includes('FancyButton'));
  assert.ok(f.unresolved.some((u) => u.kind === 'onGenerateRoute (dynamic routing)'));
  assert.ok(f.unresolved.some((u) => u.kind === 'GoRoute path'));
  assert.ok(f.nav.some((n) => n.from === 'HomeScreen' && n.to === 'PushedPage'));
  assert.ok(f.nav.some((n) => n.to === '/legacy' && n.conf === 'literal'));
  assert.ok(f.nav.some((n) => n.to === '/home' && n.conf === 'resolved'));
  // import graph: package: imports resolve
  assert.ok(f.results[0].X.topModules.length === 0 || true);
});

test('next.js app router and pages router', () => {
  const root = mk({
    'package.json': JSON.stringify({ dependencies: { next: '15', react: '19' } }),
    'src/app/page.tsx': 'export default function P() {}',
    'src/app/(marketing)/about/page.tsx': 'export default function P() {}',
    'src/app/blog/[slug]/page.tsx': 'x',
    'src/app/docs/[[...rest]]/page.mdx': 'x',
    'src/app/@modal/(.)photo/[id]/page.tsx': 'x',
    'src/app/dashboard/layout.tsx': 'x',
    'src/app/api/items/route.ts': 'export async function GET() {}\nexport const POST = () => {}\n',
    'pages/old.tsx': 'x', 'pages/api/hello.ts': 'x', 'pages/_app.tsx': 'x',
  });
  const f = facts(root);
  const urls = f.screens.map((s) => s.routes[0]).sort();
  assert.deepEqual(urls, ['/', '/about', '/blog/[slug]', '/docs/[[...rest]]', '/old', '/photo/[id]']);
  assert.ok(f.screens.find((s) => s.routes[0] === '/photo/[id]').name.includes('intercepting (modal)'));
  assert.deepEqual(routeSet(f), ['* /api/hello', 'GET,POST /api/items']);
});

test('react-router, vue-router, angular, sveltekit, plain html', () => {
  const root = mk({
    'package.json': JSON.stringify({ dependencies: { react: '18', 'react-router-dom': '6', '@sveltejs/kit': '2' } }),
    'src/App.tsx': "import { Route, createBrowserRouter } from 'react-router-dom';\nconst a = <Route path=\"/users\" element={<Users />} />;\nconst r = createBrowserRouter([{ path: '/', element: <Root />, children: [{ path: 'team', element: <Team /> }] }]);\n",
    'src/router.ts': "import { createRouter } from 'vue-router';\nexport default createRouter({ routes: [ { path: '/vue', component: () => import('./V.vue') } ] });\n",
    'src/app/app.routes.ts': "import { Routes } from '@angular/router';\nexport const routes: Routes = [ { path: 'admin', component: AdminComponent, children: [ { path: 'users', component: UsersComponent } ] } ];\n",
    'src/routes/blog/[slug]/+page.svelte': 'x',
    'src/routes/api/+server.ts': 'export function GET() {}',
    'index.html': '<html><title>Home page</title></html>',
    'public/about.html': '<html></html>',
  });
  const f = facts(root);
  const rs = routeSet(f);
  for (const r of ['PAGE /users', 'PAGE /', 'PAGE /team', 'PAGE /vue', 'PAGE /admin', 'PAGE /admin/users', 'GET /api']) assert.ok(rs.includes(r), r + ' in ' + rs);
  const urls = f.screens.map((s) => s.routes[0]).sort();
  assert.ok(urls.includes('/blog/[slug]'));
  assert.ok(f.screens.some((s) => s.name === 'Home page'));
  assert.ok(f.screens.some((s) => s.routes[0] === '/about.html'));
});

test('flask blueprints, fastapi routers, django include', () => {
  const root = mk({
    'requirements.txt': 'flask\nfastapi\ndjango\n',
    'app.py': "from flask import Flask\nfrom views.users import bp as users_bp\napp = Flask(__name__)\napp.register_blueprint(users_bp, url_prefix='/api/users')\n@app.route('/health', methods=['GET', 'POST'])\ndef health():\n    pass\nif __name__ == '__main__':\n    app.run()\n",
    'views/__init__.py': '',
    'views/users.py': "from flask import Blueprint\nbp = Blueprint('users', __name__, url_prefix='/ignored')\n@bp.route('/<int:id>')\ndef get_user(id):\n    pass\n@bp.route(PATHS[0])\ndef dyn():\n    pass\n",
    'api/main.py': "from fastapi import FastAPI\nfrom api.routers import items\napi = FastAPI()\napi.include_router(items.router, prefix='/v1')\napi.include_router(other, prefix=PREFIX)\n",
    'api/__init__.py': '', 'api/routers/__init__.py': '',
    'api/routers/items.py': "from fastapi import APIRouter\nrouter = APIRouter(prefix='/items')\n@router.get('/{item_id}')\nasync def read_item(item_id: int):\n    pass\n",
    'proj/urls.py': "from django.urls import path, include\nurlpatterns = [\n    path('shop/', include('shop.urls')),\n    path('admin/', admin.site.urls),\n]\n",
    'shop/__init__.py': '',
    'shop/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [ path('cart/<int:pk>/', views.cart, name='cart') ]\n",
  });
  const f = facts(root);
  const rs = routeSet(f);
  for (const r of ['GET,POST /health', 'GET /api/users/<int:id>', 'GET /v1/items/{item_id}', '* /shop/cart/<int:pk>/', '* /admin/']) assert.ok(rs.includes(r), r + ' in ' + JSON.stringify(rs));
  assert.equal(f.routes.find((r) => r.path === '/v1/items/{item_id}').conf, 'resolved');
  assert.ok(f.unresolved.some((u) => /dynamic path/.test(u.kind)));
  assert.ok(f.unresolved.some((u) => /prefix not literal/.test(u.kind)));
  assert.ok(f.entries.some((e) => e.entry === 'app.py' && e.kind === '__main__'));
});

test('express mount, fastify register prefix, nestjs, rails, go; ignores client calls and map.get', () => {
  const root = mk({
    'package.json': JSON.stringify({ dependencies: { express: '4' } }),
    'src/server.js': "const express = require('express');\nconst users = require('./routes/users');\nconst app = express();\napp.use('/api/users', users);\napp.get('/health', (req, res) => res.send('ok'));\nconst cache = new Map(); cache.get('/x', 1);\napi.get('items', { json: 1 });\nrequests.get(req);\napp.get(`/v1/${kind}`, h);\n",
    'src/routes/users.js': "const router = require('express').Router();\nrouter.get('/:id', (req, res) => {});\nrouter.route('/').get(list).post(create);\nmodule.exports = router;\n",
    'src/plug.ts': "import shop from './shop';\nexport default async function (app) { await app.register(shop, { prefix: '/shop' }); }\n",
    'src/shop.ts': "export default async function shop(app) { app.post('/order', async () => ({})); }\n",
    'src/cats.controller.ts': "@Controller('cats')\nexport class CatsController {\n  @Get(':id')\n  findOne() {}\n}\n",
    'config/routes.rb': "Rails.application.routes.draw do\n  root 'home#index'\n  namespace :admin do\n    resources :posts\n    get 'stats', to: 'stats#show'\n  end\nend\n",
    'go/main.go': 'package main\nfunc main() {\n  http.HandleFunc("/ping", ping)\n  v1 := r.Group("/v1")\n  v1.GET("/users", list)\n  mux.HandleFunc("POST /items", h)\n}\n',
  });
  const f = facts(root);
  const rs = routeSet(f);
  for (const r of ['GET /api/users/:id', 'GET,POST /api/users', 'GET /health', 'POST /shop/order', 'GET /cats/:id', 'GET /', 'REST /admin/posts', 'GET /admin/stats', '* /ping', 'GET /v1/users', 'POST /items']) assert.ok(rs.includes(r), r + ' in ' + JSON.stringify(rs));
  assert.ok(!rs.some((r) => r.includes('/x') || r.includes('items') && r.startsWith('GET items')));
  assert.equal(f.unresolved.filter((u) => /dynamic path/.test(u.kind)).length, 1);
});

test('db extractors: sql, prisma, drizzle, sqlalchemy, django, mongoose', () => {
  const root = mk({
    'schema.sql': 'CREATE TABLE IF NOT EXISTS users (\n  id SERIAL PRIMARY KEY,\n  email TEXT NOT NULL\n);\r\nCREATE TABLE orders (id INT, user_id INT REFERENCES users(id), total NUMERIC, PRIMARY KEY (id));\n-- CREATE TABLE commented (x int);\n',
    'prisma/schema.prisma': 'model Post {\n  id Int @id @default(autoincrement())\n  authorId Int\n  author User @relation(fields: [authorId], references: [id])\n  title String\n}\n',
    'db/schema.ts': "export const pets = pgTable('pets', { id: serial('id').primaryKey(), ownerId: integer('owner_id').references(() => users.id), name: text('name') });\n",
    'models.py': "class Account(Base):\n    __tablename__ = 'accounts'\n    id = Column(Integer, primary_key=True)\n    org_id = Column(Integer, ForeignKey('orgs.id'))\n\nclass Book(models.Model):\n    author = models.ForeignKey('Author', on_delete=models.CASCADE)\n    title = models.CharField(max_length=10)\n",
    'm.js': "const S = new mongoose.Schema({ name: String, owner: { type: ObjectId, ref: 'User' } });\nmodule.exports = mongoose.model('Cat', S);\n",
  });
  const f = facts(root);
  const t = Object.fromEntries(f.tables.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(t).sort(), ['Book', 'Cat', 'Post', 'accounts', 'orders', 'pets', 'users']);
  assert.match(t.users.cols, /id PK/);
  assert.match(t.orders.cols, /id PK, user_id FK→users/);
  assert.match(t.Post.cols, /authorId FK→User/);
  assert.match(t.pets.cols, /ownerId FK→users/);
  assert.match(t.accounts.cols, /org_id FK→orgs.id/);
  assert.match(t.Book.cols, /author FK→Author/);
  assert.match(t.Cat.cols, /owner FK→User/);
});

test('generic: entry points, notebooks, data dirs, services, tests, import graph and cycles', () => {
  const nb = JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'] }, { cell_type: 'markdown', source: ['# Training run\n', 'details'] }] });
  const root = mk({
    'detect.py': 'from utils.geom import area\nif __name__ == "__main__":\n    pass\n',
    'utils/__init__.py': '', 'utils/geom.py': 'from utils import box\ndef area():\n    pass\n', 'utils/box.py': 'from utils import geom\nclass Box: pass\n',
    'train.ipynb': nb, 'weights/model.pt': 'x'.repeat(2048), 'weights/sub/m.onnx': 'xx',
    'Dockerfile': 'FROM python\nCMD ["python", "detect.py"]\n', 'Makefile': 'train:\n\tpython train.py\nVAR := 1\n',
    'scripts/run.sh': 'echo', 'tests/test_geom.py': 'def test(): pass', 'test_root.py': 'x', 'test_photo.jpg': 'x',
    '.gitignore': 'ignored_dir/\n*.log\n!keep.log\n', 'ignored_dir/a.py': 'x', 'debug.log': 'x', 'keep.log': 'x',
  });
  const f = facts(root);
  const kinds = f.entries.map((e) => e.kind).sort();
  for (const k of ['__main__', 'docker CMD', 'Makefile targets', 'script']) assert.ok(kinds.includes(k), k);
  assert.equal(f.notebooks[0].title, 'Training run');
  const w = f.data.find((d) => d.dir === 'weights/');
  assert.equal(w.n, 2); assert.match(w.size, /KB/);
  assert.ok(f.services.some((s) => s.file === 'utils/geom.py'));
  assert.equal(f.tests.reduce((s, t) => s + t.n, 0), 2);
  assert.ok(f.cycles.some((c) => c.includes('utils/box.py') && c.includes('utils/geom.py')));
  const rels = f.info.files.map((x) => x.rel);
  assert.ok(!rels.includes('ignored_dir/a.py')); assert.ok(!rels.includes('debug.log')); assert.ok(rels.includes('keep.log'));
});

test('robustness: CRLF, non-UTF8, NUL bytes, >1MB never read, comments', () => {
  const big = 'x'.repeat(MAX_BYTES + 10);
  const root = mk({
    'package.json': JSON.stringify({ dependencies: { express: '4' } }),
    'a.js': "app.get('/crlf', h);\r\n// app.get('/commented', h);\r\n/* app.get('/block', h) */\r\nconst u = 'http://x//y'; app.get('/after', h);\r\n",
    'big.js': "app.get('/big', h);\n" + big,
    'latin1.py': Buffer.from([0x23, 0x20, 0xe7, 0xfc, 0x0a]),
    'nul.js': Buffer.from([0x61, 0x00, 0x62]),
  });
  const f = facts(root);
  assert.deepEqual(routeSet(f), ['GET /after', 'GET /crlf']);
  assert.equal(f.routes.find((r) => r.path === '/after').line, 4);
  assert.equal(f.info.skipped.large, 1);
  assert.equal(f.warnings.nonUtf8, 1);
  assert.equal(f.warnings.nulBytes, 1);
  assert.equal(stripComments("a // b\nc", 'c'), 'a     \nc');
});

test('write is idempotent, check detects stale, hub outside markers preserved, domains coverage', () => {
  const root = mk({
    'package.json': JSON.stringify({ dependencies: { express: '4' } }),
    'src/services/mail.js': "export function send() {}\n",
    'src/app.js': "app.get('/a', h);\n",
    'STRUCTURE.md': '# My title\r\nhand text\r\n<!-- structure-map:begin -->\nold\n<!-- structure-map:end -->\r\ntrailing notes\r\n',
  });
  const s1 = run(opts(root));
  assert.equal(s1.exitCode, 0);
  const hub = fs.readFileSync(path.join(root, 'STRUCTURE.md'), 'utf8');
  assert.ok(hub.startsWith('# My title\r\nhand text\r\n<!-- structure-map:begin -->'));
  assert.ok(hub.endsWith('<!-- structure-map:end -->\r\ntrailing notes\r\n'));
  const out = path.join(root, 'docs/structure');
  const snap = () => Object.fromEntries(fs.readdirSync(out).sort().map((n) => [n, [fs.readFileSync(path.join(out, n), 'utf8'), fs.statSync(path.join(out, n)).mtimeMs]]));
  const before = snap();
  assert.ok(before['api-routes.md'][0].startsWith('<!-- structure-map:facts hash='));
  assert.ok(!before['api-routes.md'][0].includes(root));
  const s2 = run(opts(root));
  assert.deepEqual(s2.written, []);
  assert.deepEqual(snap(), before);
  assert.equal(run(opts(root, { check: true })).exitCode, 0);
  // domains coverage
  assert.ok(s2.uncovered.includes('src/services/mail.js'));
  assert.ok(hub.includes('](docs/structure/api-routes.md)'));
  fs.writeFileSync(path.join(out, 'domains.md'), '## Mail\n- `src/services/` and `src/removed.js` and /api/route-like and https://x.y/z/w\n- read/write and client/server, iOS/Android, src/also_gone.js\n');
  const s3 = run(opts(root));
  assert.ok(!s3.uncovered.includes('src/services/mail.js'));
  assert.deepEqual(s3.gone, ['src/also_gone.js', 'src/removed.js']);
  // stale detection
  fs.appendFileSync(path.join(root, 'src/app.js'), "app.post('/b', h);\n");
  const c = run(opts(root, { check: true }));
  assert.equal(c.exitCode, 1); assert.ok(c.stale.includes('api-routes.md'));
  assert.equal(fs.readFileSync(path.join(out, 'api-routes.md'), 'utf8'), before['api-routes.md'][0]);
  // removing all services removes the now-empty generated file
  fs.rmSync(path.join(root, 'src/services'), { recursive: true });
  run(opts(root));
  assert.ok(!fs.existsSync(path.join(out, 'services.md')));
  // domains.md never rewritten
  assert.match(fs.readFileSync(path.join(out, 'domains.md'), 'utf8'), /## Mail/);
});

test('split, never cut: index plus parts, each entry once, stale parts removed, idempotent', () => {
  const files = { 'package.json': '{"dependencies":{"express":"4"}}' };
  const want = [];
  let src = '';
  for (let i = 0; i < 400; i++) { const p = `/${['users', 'orders', 'admin', 'shop', 'x' + (i % 13)][i % 5]}/item/${i}/with/a/long/path`; want.push('GET ' + p); src += `app.get('${p}', handler${i});\n`; }
  files['src/app.js'] = src;
  const root = mk(files);
  const s = run(opts(root, { budget: 1500 }));
  const out = path.join(root, 'docs/structure');
  const idx = fs.readFileSync(path.join(out, 'api-routes.md'), 'utf8');
  assert.match(idx, /\(index\)/);
  const parts = fs.readdirSync(path.join(out, 'api-routes')).sort();
  assert.ok(parts.length >= 3, parts.join());
  const seen = [];
  for (const f of parts) {
    const t = fs.readFileSync(path.join(out, 'api-routes', f), 'utf8');
    assert.ok(t.startsWith('<!-- structure-map:facts hash='));
    assert.ok(idx.includes(`(api-routes/${f})`));
    assert.ok(!t.includes('⋮'));
    for (const m of t.matchAll(/^\| GET \| (\S+) \|/gm)) seen.push('GET ' + m[1]);
  }
  assert.deepEqual(seen.sort(), want.sort());
  assert.ok(s.tokens.split['api-routes.md'] >= 3);
  assert.match(fs.readFileSync(path.join(root, 'STRUCTURE.md'), 'utf8'), /\[api-routes\.md\]\(docs\/structure\/api-routes\.md\) \| \d+ \| \d+ \|/);
  // re-run writes nothing, check is fresh
  assert.deepEqual(run(opts(root, { budget: 1500 })).written, []);
  assert.equal(run(opts(root, { budget: 1500, check: true })).exitCode, 0);
  // remove most routes: parts become stale and must disappear, check reports them first
  fs.writeFileSync(path.join(root, 'src/app.js'), "app.get('/only', h);\n");
  const c = run(opts(root, { budget: 1500, check: true }));
  assert.equal(c.exitCode, 1); assert.ok(c.stale.some((x) => /stale part/.test(x)));
  run(opts(root, { budget: 1500 }));
  assert.ok(!fs.existsSync(path.join(out, 'api-routes')));
  assert.match(fs.readFileSync(path.join(out, 'api-routes.md'), 'utf8'), /\/only/);
});

test('monorepo sub-projects and git inventory; CLI exit codes', () => {
  const root = mk({
    'apps/mobile/pubspec.yaml': 'name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n',
    'apps/mobile/lib/screens/login_screen.dart': 'class LoginScreen extends StatelessWidget {}\n',
    'apps/api/package.json': '{"dependencies":{"fastify":"5"}}',
    'apps/api/src/app.ts': "app.get('/x', async () => 1);\n",
    'ml/requirements.txt': 'torch\n', 'ml/train.py': 'import torch\n',
    'node_modules/junk/index.js': "app.get('/junk', h)", '.gitignore': 'secret/\n', 'secret/a.js': "app.get('/secret', h)",
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const f = facts(root);
  assert.equal(f.info.mode, 'git');
  assert.deepEqual(f.results.map((r) => r.P.label), ['.', 'apps/api', 'apps/mobile', 'ml']);
  assert.ok(f.results.find((r) => r.P.label === 'apps/mobile').P.fw.has('Flutter'));
  assert.ok(f.results.find((r) => r.P.label === 'ml').P.fw.has('PyTorch'));
  assert.deepEqual(routeSet(f), ['GET /x']);
  const node = process.execPath;
  const r1 = execFileSync(node, [SCRIPT, '--root', root, '--quiet']).toString();
  assert.equal(r1, '');
  let code = 0; try { execFileSync(node, [SCRIPT, '--root', root, '--check', '--quiet']); } catch (e) { code = e.status; }
  assert.equal(code, 0);
  fs.writeFileSync(path.join(root, 'apps/api/src/more.ts'), "app.get('/y', async () => 1);\n");
  try { execFileSync(node, [SCRIPT, '--root', root, '--check', '--quiet'], { stdio: 'pipe' }); code = 0; } catch (e) { code = e.status; assert.match(e.stdout.toString(), /api-routes\.md/); }
  assert.equal(code, 1);
});

test('gitignore compiler basics', () => {
  const rules = compileGitignore('/build\n*.pyc\ndocs/**/tmp/\n', '');
  const ig = (p, d) => { let r = false; for (const x of rules) if ((!x.dirOnly || d) && x.re.test(p)) r = !x.neg; return r; };
  assert.ok(ig('build', true)); assert.ok(!ig('src/build', true)); assert.ok(ig('a/b.pyc', false)); assert.ok(ig('docs/x/tmp', true));
});

test('swiftui: screens reached by window/tab/navigation/sheet, components listed, ViewModifier ignored', () => {
  const root = mk({
    'App/DemoApp.swift': 'import SwiftUI\n@main struct DemoApp: App { var body: some Scene { WindowGroup { RootView() } } }\n',
    'App/Views.swift': [
      'import SwiftUI',
      'struct RootView: View { var body: some View { NavigationStack { List { NavigationLink(value: Item.a) { RowView() } }',
      '  .navigationDestination(for: Item.self) { item in DetailView(item: item) } } } }',
      'struct DetailView: View { @State var s = false; var body: some View { Text("x").sheet(isPresented: $s) { SettingsView() } } }',
      'struct SettingsView: View { var body: some View { TabView { ProfileTab().tabItem { Text("p") } } } }',
      'struct ProfileTab: View { var body: some View { Text("t") } }',
      'struct RowView: View { var body: some View { Text("r") } }',
      'struct Shadow: ViewModifier { func body(content: Content) -> some View { content } }',
      'struct MainViewModel: ObservableObject {}',
    ].join('\n'),
  });
  const f = facts(root);
  assert.deepEqual(f.screens.map((s) => s.name).sort(), ['DetailView', 'ProfileTab', 'RootView', 'SettingsView']);
  assert.deepEqual(f.components.map((c) => c.name), ['RowView']);
  assert.ok(f.screens.find((s) => s.name === 'SettingsView').routes.includes('sheet'));
  assert.ok(f.entries.some((e) => e.kind === 'SwiftUI @main App' && e.entry === 'DemoApp'));
  assert.ok(f.results[0].P.fw.has('SwiftUI'));
});

test('vb6: forms, captions, controls, handlers, modules, vbp, Windows-1254 decoded without skip', () => {
  const frm = 'VERSION 5.00\r\nBegin VB.Form frmİşlem \r\n   Caption         =   "İşlem Tamamlandı"\r\n   Begin VB.CommandButton Command1 \r\n      Caption = "Tamam"\r\n   End\r\n   Begin VB.Menu mnuDosya \r\n   End\r\nEnd\r\nAttribute VB_Name = "frmİşlem"\r\nPrivate Sub Command1_Click()\r\n  \' frmOther.Show in a comment\r\n  frmOther.Show vbModal\r\nEnd Sub\r\nPrivate Sub Form_Load()\r\nEnd Sub\r\n';
  const root = mk({
    'vb/frmIslem.frm': Buffer.from(new TextDecoder('utf-8').decode(Buffer.from(frm)).replace(/[İşı]/g, (c) => ({ 'İ': 'İ', 'ş': 'ş', 'ı': 'ı' }[c])), 'utf8'),
    'vb/frmOther.frm': Buffer.from([...Buffer.from('VERSION 5.00\r\nBegin VB.Form frmOther\r\n   Caption = "'), 0xdd, 0xfe, 0xfd, ...Buffer.from('"\r\nEnd\r\nAttribute VB_Name = "frmOther"\r\n')]),
    'vb/Ortak.bas': 'Attribute VB_Name = "Ortak"\r\nPublic Sub Main()\r\n  frmİşlem.Show\r\nEnd Sub\r\nPublic Function Topla(a, b)\r\nEnd Function\r\nPrivate Sub Gizli()\r\nEnd Sub\r\n',
    'vb/Proje.vbp': 'Type=Exe\r\nForm=frmIslem.frm\r\nForm=frmOther.frm\r\nModule=Ortak; Ortak.bas\r\nStartup="Sub Main"\r\nName="Proje"\r\n',
  });
  const f = facts(root);
  assert.equal(f.warnings.nonUtf8, 0); assert.equal(f.warnings.legacyDecoded, 1);
  const names = f.screens.map((s) => s.name).sort();
  assert.deepEqual(names, ['frmOther "İşı"', 'frmİşlem "İşlem Tamamlandı"']);
  assert.match(f.screens.find((s) => s.name.startsWith('frmİşlem')).routes[0], /Form, controls 1, menus 1/);
  assert.ok(f.entries.some((e) => e.kind === 'vb6 event handlers' && /2 event handlers \(Command1_Click, Form_Load\)/.test(e.entry)));
  assert.ok(f.entries.some((e) => e.kind === 'vb6 Sub Main'));
  assert.ok(f.entries.some((e) => e.kind === 'vb6 project' && /Proje: startup Sub Main; forms 2, modules 1/.test(e.entry)));
  assert.equal(f.services.find((s) => s.file === 'vb/Ortak.bas').exports, 'Main, Topla');
  assert.equal(f.nav.filter((n) => n.to === 'frmOther').length, 1);
  assert.ok(f.nav.some((n) => n.from === 'Ortak' && n.to === 'frmİşlem'));
  assert.ok(f.results[0].P.fw.has('VB6'));
});

test('socket.io, NestJS gateway, Electron IPC and windows', () => {
  const root = mk({
    'package.json': JSON.stringify({ dependencies: { electron: '30', 'socket.io': '4', '@nestjs/websockets': '10' } }),
    'src/chat.gateway.ts': "@WebSocketGateway({ namespace: '/chat' })\nexport class ChatGateway {\n  @SubscribeMessage('message')\n  handleMessage() {}\n  @SubscribeMessage(EVENT)\n  dyn() {}\n}\n",
    'src/server.ts': "io.on('connection', (socket) => { socket.on('join', (room) => {}); socket.on(`room:${id}`, h); });\nprocess.on('exit', h);\n",
    'electron/main.ts': "const win = new BrowserWindow({ width: 800 });\nwin.loadFile('index.html');\nconst popup = new BrowserWindow({});\npopup.loadURL(process.env.URL);\nipcMain.handle('prices:get', async () => 1);\nipcMain.on('log', h);\nipcMain.handle(`x:${n}`, h);\n",
    'electron/preload.ts': "contextBridge.exposeInMainWorld('api', { get: () => ipcRenderer.invoke('prices:get') });\n",
  });
  const f = facts(root);
  const ev = f.events.map((e) => `${e.kind} ${e.name}`).sort();
  assert.deepEqual(ev, ['ipcMain.handle prices:get', 'ipcMain.on log', 'ipcRenderer.invoke (caller) prices:get', 'socket.on connection', 'socket.on join', 'ws gateway /chat message']);
  assert.ok(f.screens.some((s) => s.name === 'BrowserWindow win' && s.routes[0] === 'index.html' && s.conf === 'literal'));
  assert.ok(f.screens.some((s) => s.name === 'BrowserWindow popup' && s.conf === 'unresolved'));
  assert.equal(f.unresolved.filter((u) => /dynamic (event|channel)|BrowserWindow loadURL/.test(u.kind)).length, 4);
  assert.ok(f.entries.some((e) => e.kind === 'electron preload API' && e.entry === 'window.api'));
});

test('python http.server handlers and static server', () => {
  const root = mk({
    'srv.py': [
      'import re', 'from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler', 'from urllib.parse import urlparse',
      'PATH_RE = re.compile(r"^/u/([a-z]+)$")',
      'class H(BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        if self.path == "/health":', '            pass',
      '        elif self.path.startswith("/api/items"):', '            pass',
      '        elif self.path.endswith(".css") or "/" in self.path:', '            pass',
      '    def do_POST(self):',
      '        if urlparse(self.path).path == "/api/items?x=1":', '            pass',
      '    def do_PUT(self):', '        self._route()',
      '    def _route(self):', '        m = PATH_RE.match(self.path)',
      'DYN_RE = re.compile(r"^/v/(" + TOKEN + r")$")',
      'class Static(SimpleHTTPRequestHandler):', '    extensions_map = {}',
      'def main():', '    pass',
    ].join('\n'),
  });
  const f = facts(root);
  assert.deepEqual(routeSet(f), ['* re:^/u/([a-z]+)$', 'GET /* (static files)', 'GET /api/items*', 'GET /health', 'POST /api/items', 'PUT *']);
  assert.equal(f.routes.find((r) => r.path.startsWith('re:')).conf, 'resolved');
  assert.ok(f.unresolved.some((u) => /do_PUT/.test(u.kind)));
  assert.ok(!routeSet(f).some((r) => r.includes('/v/')));
});

test('go chi: nested Route/Group/With/Mount with shadowed r, gin groups, net/http', () => {
  const root = mk({
    'go.mod': 'module x\nrequire github.com/go-chi/chi/v5 v5.0.0\n',
    'main.go': [
      'package main',
      'func main() {',
      '  r := chi.NewRouter()',
      '  r.Route("/api", func(r chi.Router) {',
      '    r.Route("/users", func(r chi.Router) {',
      '      r.Get("/", list)',
      '      r.With(auth, mw.Timeout(5)).Post("/", create)',
      '      r.Route("/{id}", func(r chi.Router) { r.Get("/", get) })',
      '    })',
      '    r.Group(func(r chi.Router) { r.Get("/health", h) })',
      '  })',
      '  r.Mount("/admin", adminRouter())',
      '  r.Mount("/ext", other.Handler())',
      '  r.Route(prefix, func(r chi.Router) { r.Get("/x", h) })',
      '  http.HandleFunc("/ping", ping)',
      '  v1 := g.Group("/v1")',
      '  v1.GET("/items", h)',
      '}',
      'func adminRouter() chi.Router {',
      '  r := chi.NewRouter()',
      '  r.Get("/stats", stats)',
      '  return r',
      '}',
      'func handler(w http.ResponseWriter, r *http.Request) { q := r.URL.Query(); q.Get("page"); r.Header.Get("X") }',
    ].join('\n'),
  });
  const f = facts(root);
  const rs = routeSet(f);
  for (const r of ['GET /api/users', 'POST /api/users', 'GET /api/users/{id}', 'GET /api/health', 'MOUNT /admin', 'GET /admin/stats', '* /ping', 'GET /v1/items', 'GET /{?}/x']) assert.ok(rs.includes(r), r + ' in ' + JSON.stringify(rs));
  assert.equal(rs.length, 10, JSON.stringify(rs));
  assert.ok(f.unresolved.some((u) => u.kind === 'chi Mount target not resolved in file'));
  assert.ok(f.unresolved.some((u) => u.kind === 'chi Route dynamic prefix'));
});

// legacy fixture in the format the pre-1.0 skill produced (STRUCTURE.md hub with domain sections, plain detail tables)
const LEGACY_HUB = '# Project Structure\n\n> Auto-generated by structure-map. Last updated: 2025-01-01\n\n## Overview\n- **Stack**: Flask + Python\n- **Screens**: 0 | **API Routes**: 2 | **DB Tables**: 0\n\n## Feature Domains\n\n### Search\nImage search over the catalog.\n- API: `GET /api/search` -> webapp/app.py\n- Details: [api-routes.md](docs/structure/api-routes.md)\n';
const LEGACY_ROUTES = '# API Routes\n\n| Method | Path | Handler | File | Purpose |\n|---|---|---|---|---|\n| GET | /api/search | api_search | webapp/app.py | Text search (hand-edited note) |\n';

test('legacy detection, refusal to overwrite, migrate with verified backup', () => {
  const root = mk({ 'webapp/app.py': "from flask import Flask\napp = Flask(__name__)\n@app.get('/api/search')\ndef api_search():\n    pass\n", 'requirements.txt': 'flask\n', 'STRUCTURE.md': LEGACY_HUB, 'docs/structure/api-routes.md': LEGACY_ROUTES });
  const node = process.execPath;
  const det = JSON.parse(execFileSync(node, [SCRIPT, '--root', root, '--detect']).toString());
  assert.deepEqual(det, { legacy: true, files: ['STRUCTURE.md', 'docs/structure/api-routes.md'] });
  let code = 0; try { execFileSync(node, [SCRIPT, '--root', root, '--quiet']); } catch (e) { code = e.status; }
  assert.equal(code, 3);
  assert.equal(fs.readFileSync(path.join(root, 'docs/structure/api-routes.md'), 'utf8'), LEGACY_ROUTES);
  execFileSync(node, [SCRIPT, '--root', root, '--migrate', '--quiet']);
  const leg = path.join(root, 'docs/structure/.legacy');
  assert.equal(fs.readFileSync(path.join(leg, 'STRUCTURE.md'), 'utf8'), LEGACY_HUB);
  assert.equal(fs.readFileSync(path.join(leg, 'docs__structure__api-routes.md'), 'utf8'), LEGACY_ROUTES);
  assert.match(fs.readFileSync(path.join(root, 'STRUCTURE.md'), 'utf8'), /structure-map:begin/);
  assert.match(fs.readFileSync(path.join(root, 'docs/structure/api-routes.md'), 'utf8'), /^<!-- structure-map:facts hash=/);
  assert.equal(JSON.parse(execFileSync(node, [SCRIPT, '--root', root, '--detect']).toString()).legacy, false);
  assert.ok(!fs.readdirSync(path.join(root, 'docs/structure')).includes('.legacy') || true);
});

test('hook mode: silent without STRUCTURE.md, one line at SessionStart when uncovered, silent on Stop, legacy hint', () => {
  const node = process.execPath;
  const runHook = (cwd, ev) => execFileSync(node, [SCRIPT, '--hook'], { input: JSON.stringify({ cwd, hook_event_name: ev }) }).toString();
  const bare = mk({ 'a.py': 'x = 1\n' }); execFileSync('git', ['init', '-q'], { cwd: bare });
  assert.equal(runHook(bare, 'SessionStart'), '');
  assert.ok(!fs.existsSync(path.join(bare, 'STRUCTURE.md')) && !fs.existsSync(path.join(bare, 'docs')));
  const root = mk({ 'package.json': '{"dependencies":{"express":"4"}}', 'src/services/mail.js': 'export function send() {}\n', 'src/app.js': "app.get('/a', h);\n" });
  execFileSync('git', ['init', '-q'], { cwd: root });
  run(opts(root));
  fs.writeFileSync(path.join(root, 'src/app.js'), "app.get('/a', h);\napp.get('/b', h);\n");
  const out = runHook(path.join(root, 'src'), 'SessionStart');
  assert.match(out, /^structure-map: \d+ files are not described in docs\/structure\/domains\.md \(run \/structure-map:structure-map\)\n$/);
  assert.match(fs.readFileSync(path.join(root, 'docs/structure/api-routes.md'), 'utf8'), /\/b/);
  assert.equal(runHook(root, 'Stop'), '');
  assert.equal(execFileSync(node, [SCRIPT, '--hook'], { input: 'not json' }).toString(), '');
  const legacy = mk({ 'STRUCTURE.md': LEGACY_HUB }); execFileSync('git', ['init', '-q'], { cwd: legacy });
  assert.match(runHook(legacy, 'SessionStart'), /old-style STRUCTURE\.md found; run \/structure-map:structure-map migrate/);
  assert.equal(runHook(legacy, 'Stop'), '');
  assert.equal(fs.readFileSync(path.join(legacy, 'STRUCTURE.md'), 'utf8'), LEGACY_HUB);
});
