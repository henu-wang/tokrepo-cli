#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');
const readline = require('readline');

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const CONFIG_DIR = path.join(os.homedir(), '.tokrepo');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PROJECT_CONFIG = '.tokrepo.json';
const DEFAULT_API = 'https://api.tokrepo.com';
const CLI_VERSION = '3.13.0';
const VERSION_CHECK_FILE = path.join(os.homedir(), '.tokrepo', '.version-check');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const CODEX_TOKREPO_DIR = path.join(CODEX_DIR, 'tokrepo');
const CODEX_MANIFEST_FILE = path.join(CODEX_TOKREPO_DIR, 'install-manifest.json');
const CODEX_SESSIONS_DIR = path.join(CODEX_TOKREPO_DIR, 'sessions');
const SUPPORTED_INSTALL_TARGETS = ['gemini', 'codex'];

// ─── Helpers ───

function wantsJson(argv = process.argv) {
  return argv.includes('--json') || argv.some(arg => arg.startsWith('--json=') && arg !== '--json=false');
}

function log(msg) { console.log(msg); }
function success(msg) { log(`${C.green}✓${C.reset} ${msg}`); }
function error(msg) {
  if (wantsJson()) {
    console.error(JSON.stringify({ error: msg }, null, 2));
  } else {
    log(`${C.red}✗${C.reset} ${msg}`);
  }
  process.exit(1);
}
function warn(msg) { log(`${C.yellow}!${C.reset} ${msg}`); }
function info(msg) { log(`${C.cyan}→${C.reset} ${msg}`); }

function outputJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function readConfig() {
  // P0: TOKREPO_TOKEN env var takes priority (enables Agent automation)
  const envToken = process.env.TOKREPO_TOKEN;
  if (envToken) {
    return { token: envToken, api: process.env.TOKREPO_API || DEFAULT_API };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// Check npm registry for newer version (non-blocking, max once per day)
async function checkForUpdate() {
  try {
    // Only check once per 24 hours
    if (fs.existsSync(VERSION_CHECK_FILE)) {
      const stat = fs.statSync(VERSION_CHECK_FILE);
      const hoursSinceCheck = (Date.now() - stat.mtimeMs) / 3600000;
      if (hoursSinceCheck < 24) return;
    }
    // Touch the file to mark check time
    if (!fs.existsSync(path.dirname(VERSION_CHECK_FILE))) {
      fs.mkdirSync(path.dirname(VERSION_CHECK_FILE), { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(VERSION_CHECK_FILE, '', { mode: 0o600 });

    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://registry.npmjs.org/tokrepo/latest', {
        headers: { 'Accept': 'application/json' },
        timeout: 3000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(); });
    });

    const latest = data.version;
    if (latest && latest !== CLI_VERSION) {
      const cmp = compareVersions(latest, CLI_VERSION);
      if (cmp > 0) {
        log('');
        log(`${C.yellow}!${C.reset} Update available: ${C.dim}${CLI_VERSION}${C.reset} → ${C.green}${latest}${C.reset}`);
        log(`  Run: ${C.cyan}npm install -g tokrepo${C.reset}`);
        log('');
      }
    }
  } catch {
    // Silent fail — update check is best-effort
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function readProjectConfig(baseDir = process.cwd()) {
  const configPath = path.join(baseDir, PROJECT_CONFIG);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${C.cyan}?${C.reset} ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fetchCurrentUser(config) {
  return apiRequest('GET', '/api/v1/tokenboard/auth/me', null, config.token, config.api);
}

function apiRequest(method, urlPath, body, token, apiBase) {
  return new Promise((resolve, reject) => {
    const base = apiBase || DEFAULT_API;
    const url = new URL(urlPath, base);
    // Force HTTPS to prevent token transmission over plain HTTP
    if (url.protocol === 'http:' && !url.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
      url.protocol = 'https:';
    }
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': `tokrepo-cli/${CLI_VERSION}`,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 200) {
            resolve(json.data);
          } else {
            reject(new Error(json.message || `API error: ${json.code}`));
          }
        } catch {
          reject(new Error(`Invalid response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function telemetryDisabled() {
  const value = String(process.env.TOKREPO_TELEMETRY || '').toLowerCase();
  return ['0', 'false', 'off', 'no'].includes(value);
}

function trackAgentEvent(event, fields = {}, apiBase = DEFAULT_API) {
  if (telemetryDisabled()) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/v1/tokenboard/agent/events', apiBase || DEFAULT_API);
      if (url.protocol === 'http:' && !url.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
        url.protocol = 'https:';
      }
      const body = JSON.stringify({
        event,
        source: 'cli',
        version: CLI_VERSION,
        ...fields,
      });
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        timeout: 700,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': `tokrepo-cli/${CLI_VERSION}`,
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ─── File type detection (auto from extension) ───

function detectFileType(filename) {
  const lower = filename.toLowerCase();
  // Skills
  if (lower.endsWith('.skill.md') || lower === 'skill.md') return 'skill';
  // Prompts
  if (lower.endsWith('.prompt') || lower.endsWith('.prompt.md')) return 'prompt';
  // Configs
  if (lower === 'claude.md' || lower === '.claude.md' || lower === 'agents.md' || lower === '.agents.md') return 'config';
  if (lower === 'gemini.md' || lower === '.gemini.md') return 'config';
  if (lower === '.cursorrules' || lower === '.windsurfrules') return 'config';
  if (lower.endsWith('.mcp.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) return 'config';
  if (lower.endsWith('.json') && !lower.endsWith('package.json') && !lower.endsWith('package-lock.json')) return 'config';
  // Scripts
  if (/\.(sh|py|js|mjs|ts|rb|go|rs|lua)$/.test(lower)) return 'script';
  // Markdown defaults to other (content)
  if (lower.endsWith('.md')) return 'other';
  return 'other';
}

// Guess tag from file type
function guessTag(fileType) {
  const map = { skill: 'Skills', prompt: 'Prompts', script: 'Scripts', config: 'Configs' };
  return map[fileType] || null;
}

function parseCsvList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(parseCsvList);
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

// ─── Glob matching ───

function matchGlob(pattern, filename) {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(filename);
}

function findFiles(patterns, baseDir) {
  const results = new Set();
  const seen = new Set();

  function walk(dir, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        for (const pattern of patterns) {
          if (matchGlob(pattern, relPath) || matchGlob(pattern, entry.name)) {
            if (!seen.has(relPath)) {
              seen.add(relPath);
              results.add({ path: fullPath, relPath });
            }
          }
        }
      }
    }
  }

  walk(baseDir, '');
  return Array.from(results);
}

// ─── Parse CLI args ───

function parseArgs(argv) {
  const args = { flags: {}, positional: [] };
  let i = 2; // skip node and script
  // skip command name
  if (argv[i] && !argv[i].startsWith('-')) {
    args.command = argv[i];
    i++;
  }

  const valueFlags = new Set([
    'title', 'desc', 'tag', 'target', 'targets', 'keyword', 'query', 'types',
    'kind', 'install-mode', 'install_mode', 'entrypoint', 'asset-kind', 'asset_kind',
    'version', 'uuid',
    'task', 'limit',
    'policy', 'session',
    'page', 'page-size', 'page_size', 'sort-by', 'sort_by',
    'time-window', 'time_window',
  ]);

  const assignFlag = (rawName, value = true) => {
    const name = rawName.replace(/^--?/, '');
    const normalized = name.replace(/-/g, '_');
    if (normalized === 'tag') {
      if (!args.flags.tags) args.flags.tags = [];
      args.flags.tags.push(value);
      return;
    }
    if (normalized === 'page_size') {
      args.flags.pageSize = value;
    } else if (normalized === 'sort_by') {
      args.flags.sortBy = value;
    } else if (normalized === 'time_window') {
      args.flags.timeWindow = value;
    } else if (normalized === 'dry_run') {
      args.flags.dryRun = value;
    } else if (normalized === 'approve_mcp') {
      args.flags.approveMcp = value;
    } else if (normalized === 'install_mode') {
      args.flags.installMode = value;
    } else if (normalized === 'asset_kind') {
      args.flags.assetKind = value;
    }
    args.flags[normalized] = value;
  };

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.flags.help = true;
    } else if (arg === '-y' || arg === '--yes') {
      args.flags.yes = true;
    } else if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        const name = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        assignFlag(name, value);
      } else {
        const name = arg.slice(2);
        if (valueFlags.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          assignFlag(name, argv[++i]);
        } else {
          assignFlag(name, true);
        }
      }
    } else if (!arg.startsWith('-')) {
      args.positional.push(arg);
    }
    i++;
  }
  return args;
}

// ─── Collect files from paths ───

function collectFiles(paths, baseDir) {
  const files = [];
  const DEFAULT_PATTERNS = [
    '*.md', '*.skill.md', '*.prompt', '*.prompt.md',
    '*.sh', '*.py', '*.js', '*.mjs', '*.ts',
    '*.json', '*.yaml', '*.yml', '*.toml',
  ];
  // Skip binary/irrelevant files
  const SKIP = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db', '.gitignore', '.npmignore',
  ]);
  const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', '__pycache__', '.venv', 'venv']);

  for (const p of paths) {
    const resolved = path.resolve(baseDir, p);
    if (!fs.existsSync(resolved)) {
      warn(`Not found: ${p}`);
      continue;
    }

    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      // Direct file
      if (SKIP.has(path.basename(resolved))) continue;
      files.push({ path: resolved, relPath: path.basename(resolved) });
    } else if (stat.isDirectory()) {
      // Scan directory
      function walk(dir, relBase) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || SKIP.has(entry.name)) continue;
          const fullPath = path.join(dir, entry.name);
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(fullPath, relPath);
          } else if (entry.isFile()) {
            // Check extension matches
            const ext = path.extname(entry.name).toLowerCase();
            const validExts = ['.md', '.sh', '.py', '.js', '.mjs', '.ts', '.json', '.yaml', '.yml', '.toml', '.prompt', '.rb', '.go', '.rs'];
            if (validExts.includes(ext) || entry.name === '.cursorrules' || entry.name === '.windsurfrules') {
              if (!SKIP.has(entry.name)) {
                files.push({ path: fullPath, relPath });
              }
            }
          }
        }
      }
      walk(resolved, '');
    }
  }
  return files;
}

// ─── Guess title from directory or README ───

function guessTitle(files, baseDir) {
  // Try README first line
  const readme = files.find(f => /^readme\.md$/i.test(path.basename(f.relPath)));
  if (readme) {
    const content = fs.readFileSync(readme.path, 'utf8');
    const firstHeading = content.match(/^#\s+(.+)$/m);
    if (firstHeading) return firstHeading[1].trim();
  }
  // Fall back to directory name
  return path.basename(baseDir);
}

// ─── Commands ───

async function cmdLogin() {
  log(`\n${C.bold}tokrepo login${C.reset}\n`);

  // Check for --token flag for manual token entry
  const args = process.argv.slice(2);
  const useToken = args.includes('--token') || args.includes('-t');

  if (useToken) {
    // Manual token flow
    info('Paste your API key (from https://tokrepo.com/en/my/settings)');
    log('');
    const token = await ask('API Key:');
    if (!token) error('API key is required');
    return await saveAndVerifyToken(token);
  }

  // Browser OAuth flow (default)
  info('Opening browser for authentication...');
  log(`  ${C.dim}(Use ${C.cyan}tokrepo login --token${C.dim} to paste a token manually)${C.reset}`);
  log('');

  const token = await browserAuthFlow();
  if (!token) error('Authentication failed or was cancelled');
  return await saveAndVerifyToken(token);
}

async function saveAndVerifyToken(token) {
  writeConfig({ token, api: DEFAULT_API });
  success(`Config saved to ${CONFIG_FILE}`);
  try {
    const config = readConfig();
    const data = await fetchCurrentUser(config);
    success(`Logged in as ${C.bold}${data.nickname}${C.reset} (${data.email})`);
  } catch (e) {
    warn(`Token saved but verification failed: ${e.message}`);
  }
}

function browserAuthFlow() {
  return new Promise((resolve) => {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      // CORS headers for browser fetch
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/callback') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (!data.token || data.state !== state) {
              res.writeHead(403);
              res.end('Invalid authorization state');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            server.close();
            clearTimeout(timeout);
            resolve(data.token);
          } catch {
            res.writeHead(400);
            res.end('Invalid request');
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    // Listen on random port
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const authUrl = `https://tokrepo.com/en/cli-auth?port=${port}&state=${state}`;

      info(`Listening on http://127.0.0.1:${port}`);
      log(`  ${C.dim}If browser doesn't open, visit:${C.reset}`);
      log(`  ${C.cyan}${authUrl}${C.reset}`);
      log('');
      info('Waiting for authorization...');

      // Open browser
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open';
      require('child_process').exec(`${opener} "${authUrl}"`);
    });

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      log('');
      warn('Authorization timed out (5 minutes). Try again or use --token flag.');
      resolve(null);
    }, 5 * 60 * 1000);
  });
}

function inferAssetKindFromPushFiles(files = []) {
  const normalized = files.map(file => ({
    ...file,
    lowerName: String(file.name || '').toLowerCase(),
    content: String(file.content || ''),
  }));
  if (normalized.some(file => /"mcpServers"\s*:/.test(file.content) || /\bmcpServers\s*:/.test(file.content))) return 'mcp_config';
  if (normalized.some(file => file.type === 'script' || /\.(sh|py|js|mjs|ts|rb|go|rs|lua)$/.test(file.lowerName) || /^#!\//.test(file.content))) return 'script';
  if (normalized.some(file => file.lowerName === 'package.json' && /"bin"\s*:/.test(file.content))) return 'cli_tool';
  if (normalized.some(file => file.type === 'skill' || isCodexSkillDocument(file))) return 'skill';
  if (normalized.some(file => file.type === 'prompt')) return 'prompt';
  if (normalized.some(file => file.type === 'config')) return 'config';
  if (normalized.some(file => file.lowerName.endsWith('.md'))) return 'knowledge';
  return 'other';
}

function analyzePushMetadataQuality(files = [], metadata = {}) {
  const issues = [];
  const add = (severity, code, message, fix = '') => {
    issues.push({ severity, code, message, fix });
  };

  const normalizedKind = normalizeToolName(metadata.kind || '');
  const inferredKind = inferAssetKindFromPushFiles(files);
  const targetTools = parseCsvList(metadata.targetTools).map(normalizeToolName);
  const installMode = normalizeCodexInstallMode(metadata.installMode);
  const rawInstallMode = String(metadata.installMode || '').trim();
  const entrypoint = String(metadata.entrypoint || '').trim();
  const fileNames = new Set(files.map(file => String(file.name || '').replace(/\\/g, '/')));
  const lowerFileNames = new Set(Array.from(fileNames).map(name => name.toLowerCase()));
  const multiFile = files.length > 1;
  const riskFlags = Array.from(new Set(files.flatMap(file => analyzeInstallRisks(file.name, file.content, file.type))));
  const containsCodex = targetTools.includes('codex');

  if (!normalizedKind) {
    add('warning', 'missing_asset_kind', `No asset_kind was provided; inferred "${inferredKind}".`, `Recommended: --kind ${inferredKind}`);
  } else if (!['skill', 'prompt', 'knowledge', 'mcp_config', 'script', 'cli_tool', 'config', 'pack', 'other'].includes(normalizedKind)) {
    add('warning', 'unknown_asset_kind', `Unknown asset_kind "${metadata.kind}".`, 'Recommended: use skill, prompt, knowledge, mcp_config, script, cli_tool, config, or pack.');
  }

  if (targetTools.length === 0) {
    add('warning', 'missing_target_tools', 'No target_tools metadata was provided.', 'Recommended: --target codex or --targets codex,claude_code,gemini_cli.');
  }

  const invalidTargets = targetTools.filter(tool => !['codex', 'claude_code', 'gemini_cli', 'cursor', 'windsurf', 'opencode'].includes(tool));
  if (invalidTargets.length > 0) {
    add('info', 'unknown_target_tool', `Unknown target tool(s): ${invalidTargets.join(', ')}.`, 'Use stable ids when possible: codex, claude_code, gemini_cli, cursor, windsurf.');
  }

  if (rawInstallMode && !installMode) {
    add('warning', 'unknown_install_mode', `Unknown install_mode "${metadata.installMode}".`, 'Recommended: single, bundle, split, or stage_only.');
  } else if (!rawInstallMode && (multiFile || containsCodex)) {
    add('warning', 'missing_install_mode', `No install_mode was provided for ${multiFile ? 'a multi-file asset' : 'a Codex-targeted asset'}.`, `Recommended: --install-mode ${multiFile ? 'bundle' : 'single'}.`);
  }

  if (entrypoint && !fileNames.has(entrypoint) && !lowerFileNames.has(entrypoint.toLowerCase())) {
    add('warning', 'entrypoint_missing', `Entrypoint "${entrypoint}" is not included in the pushed files.`, 'Recommended: set --entrypoint to an included file, usually SKILL.md.');
  }

  if (!entrypoint && (installMode === 'single' || installMode === 'bundle' || containsCodex)) {
    add('warning', 'missing_entrypoint', 'No entrypoint metadata was provided.', 'Recommended: --entrypoint SKILL.md or the main markdown file.');
  }

  const effectiveKind = normalizedKind || inferredKind;
  if (containsCodex && ['script', 'cli_tool', 'mcp_config'].includes(effectiveKind) && installMode !== 'stage_only') {
    add('warning', 'high_risk_codex_activation', `${effectiveKind} assets targeted at Codex should stage by default.`, 'Recommended: --install-mode stage_only or publish a markdown skill wrapper.');
  }
  if (riskFlags.includes('executable')) {
    add('warning', 'executes_code_detected', 'Executable code was detected in the asset files.', 'Recommended: declare script/cli_tool or use stage_only for agent installs.');
  }
  if (riskFlags.includes('mcp')) {
    add('warning', 'mcp_config_detected', 'MCP config content was detected.', 'Recommended: --kind mcp_config --install-mode stage_only.');
  }
  if (riskFlags.includes('env')) {
    add('info', 'secret_or_env_mentions', 'Environment variable or secret-like words were mentioned.', 'Check this is documentation only and no real secret is included.');
  }
  if (riskFlags.includes('absolute-path')) {
    add('warning', 'absolute_path_detected', 'Absolute local paths were detected.', 'Recommended: replace machine-specific paths with placeholders.');
  }

  if (containsCodex && effectiveKind === 'skill') {
    const skillDocs = files.filter(file => isCodexSkillDocument(file));
    if (installMode === 'split' && skillDocs.length !== files.length) {
      add('warning', 'split_requires_skill_docs', 'install_mode=split works best when every markdown file has skill frontmatter.', 'Recommended: use bundle or add name/description frontmatter to each split skill.');
    }
    if (skillDocs.length === 0) {
      add('warning', 'missing_codex_skill_frontmatter', 'No Codex skill frontmatter was found.', 'Recommended: add YAML frontmatter with name and description.');
    }
  }

  const severityPenalty = issues.reduce((sum, issue) => {
    if (issue.severity === 'warning') return sum + 10;
    return sum + 2;
  }, 0);
  const score = Math.max(0, 100 - severityPenalty);
  const status = issues.some(issue => issue.severity === 'warning') ? 'warn' : 'pass';

  return {
    score,
    status,
    inferredAssetKind: inferredKind,
    assetKind: normalizedKind || '',
    targetTools,
    installMode: installMode || '',
    entrypoint,
    riskFlags,
    issueCount: issues.length,
    issues,
  };
}

function formatMetadataQualityLabel(report) {
  const color = report.status === 'pass' ? C.green : C.yellow;
  return `${color}${report.status}${C.reset} ${C.bold}${report.score}/100${C.reset}`;
}

function printMetadataQualityReport(report, opts = {}) {
  const compact = Boolean(opts.compact);
  if (!compact) {
    log(`\n${C.bold}Agent metadata quality${C.reset}`);
    log(`  Status: ${formatMetadataQualityLabel(report)}`);
    log(`  Inferred kind: ${report.inferredAssetKind}`);
    if (report.targetTools.length) log(`  Targets: ${report.targetTools.join(', ')}`);
    if (report.installMode) log(`  Install mode: ${report.installMode}`);
    if (report.riskFlags.length) log(`  Risk flags: ${report.riskFlags.join(', ')}`);
  } else {
    log(`${C.bold}Agent metadata quality suggestions:${C.reset}`);
  }

  if (report.issues.length === 0) {
    if (!compact) success('Metadata is agent-ready.');
    return;
  }
  for (const issue of report.issues.slice(0, compact ? 8 : report.issues.length)) {
    const color = issue.severity === 'warning' ? C.yellow : C.dim;
    log(`  ${color}${issue.severity.toUpperCase()}${C.reset} ${issue.code}: ${issue.message}`);
    if (issue.fix) log(`    ${C.dim}${issue.fix}${C.reset}`);
  }
  if (compact && report.issues.length > 8) {
    log(`  ${C.dim}...and ${report.issues.length - 8} more suggestion(s). Run --metadata-report for full detail.${C.reset}`);
  }
  if (!compact) log('');
}

async function cmdPush() {
  const args = parseArgs(process.argv);

  const projectConfig = readProjectConfig();
  const baseDir = process.cwd();

  // Determine what to push
  let filesToPush;
  let title;
  let description;
  let visibility;
  let tags;

  if (args.positional.length > 0) {
    // Direct mode: tokrepo push [files/dirs...] --public --title "..."
    filesToPush = collectFiles(args.positional, baseDir);
  } else if (projectConfig) {
    // Config mode: use .tokrepo.json
    const patterns = projectConfig.files || ['*.md'];
    filesToPush = findFiles(patterns, baseDir);
    title = projectConfig.title;
    description = projectConfig.description;
    tags = projectConfig.tags;
  } else {
    // No config, no files specified: push current directory
    filesToPush = collectFiles(['.'], baseDir);
  }

  if (filesToPush.length === 0) {
    error('No pushable files found. Specify files or run in a directory with .md/.py/.js/.sh files.');
  }

  // Flags override config
  title = args.flags.title || title || guessTitle(filesToPush, baseDir);
  description = args.flags.desc || description || '';
  visibility = args.flags.public ? 1 : (args.flags.private ? 0 : (projectConfig?.visibility ?? 0));
  tags = args.flags.tags || tags || [];
  const kind = args.flags.kind || args.flags.assetKind || projectConfig?.kind || projectConfig?.asset_kind || '';
  const targetTools = parseCsvList(args.flags.targets || args.flags.target || projectConfig?.target_tools || projectConfig?.targetTools);
  const installMode = args.flags.installMode || projectConfig?.install_mode || projectConfig?.installMode || '';
  const entrypoint = args.flags.entrypoint || projectConfig?.entrypoint || '';

  // Read files and detect types
  const pushFiles = [];
  const detectedTags = new Set(tags);

  for (const f of filesToPush) {
    let content;
    try {
      content = fs.readFileSync(f.path, 'utf8');
    } catch {
      warn(`Cannot read: ${f.relPath} (binary or unreadable, skipping)`);
      continue;
    }
    // Skip empty files
    if (!content.trim()) continue;

    const fileType = detectFileType(f.relPath);
    const tag = guessTag(fileType);
    if (tag) detectedTags.add(tag);

    pushFiles.push({
      name: f.relPath,
      content,
      type: fileType,
    });
  }

  if (pushFiles.length === 0) {
    error('No readable text files found to push.');
  }

  const metadataQuality = analyzePushMetadataQuality(pushFiles, {
    kind,
    targetTools,
    installMode,
    entrypoint,
    title,
    description,
  });

  if (args.flags.metadata_report || args.flags.metadataReport) {
    if (args.flags.json) {
      outputJson({ schemaVersion: 1, metadataQuality, files: pushFiles.map(file => ({ name: file.name, type: file.type, bytes: Buffer.byteLength(file.content || '') })) });
    } else {
      printMetadataQualityReport(metadataQuality);
    }
    return;
  }

  // Public registry policy: quality gates advise by default and never block user uploads.
  // TokRepo-owned CI can opt into strict mode with TOKREPO_METADATA_STRICT=1.
  if (process.env.TOKREPO_METADATA_STRICT === '1' && metadataQuality.issues.length > 0 && !args.flags.force) {
    if (!args.flags.json) printMetadataQualityReport(metadataQuality);
    error(`Internal metadata quality gate failed. Fix the issues or re-run with --force to push anyway.`);
  }

  // Show summary
  log(`\n${C.bold}tokrepo push${C.reset}\n`);
  log(`  ${C.bold}Title:${C.reset}      ${title}`);
  log(`  ${C.bold}Visibility:${C.reset} ${visibility === 1 ? `${C.green}public${C.reset} (visible to everyone)` : `${C.yellow}private${C.reset} (only you can see)`}`);
  log(`  ${C.bold}Files:${C.reset}      ${pushFiles.length} (only these files will be uploaded)`);
  if (detectedTags.size > 0) {
    log(`  ${C.bold}Tags:${C.reset}       ${Array.from(detectedTags).join(', ')}`);
  }
  const metadataSummary = [
    kind ? `kind=${kind}` : '',
    targetTools.length ? `target_tools=${targetTools.join(',')}` : '',
    installMode ? `install_mode=${installMode}` : '',
    entrypoint ? `entrypoint=${entrypoint}` : '',
  ].filter(Boolean);
  if (metadataSummary.length > 0) {
    log(`  ${C.bold}Agent meta:${C.reset} ${metadataSummary.join(' · ')}`);
  }
  log(`  ${C.bold}Agent quality:${C.reset} ${formatMetadataQualityLabel(metadataQuality)}`);
  log('');

  for (const f of pushFiles) {
    const sizeKb = (Buffer.byteLength(f.content) / 1024).toFixed(1);
    log(`  ${C.dim}•${C.reset} ${f.name} ${C.dim}(${f.type}, ${sizeKb}KB)${C.reset}`);
  }
  log('');

  const totalChars = pushFiles.reduce((sum, f) => sum + f.content.length, 0);

  if (metadataQuality.issues.length > 0) {
    printMetadataQualityReport(metadataQuality, { compact: true });
  }

  // Push
  info('Pushing...');

  const config = readConfig();
  if (!config || !config.token) {
    error(`Not logged in. Run: ${C.cyan}tokrepo login${C.reset}`);
  }

  try {
    const data = await apiRequest('POST', '/api/v1/tokenboard/push/upsert', {
      title,
      description,
      files: pushFiles,
      tags: Array.from(detectedTags),
      token_cost: String(Math.round(totalChars / 4)),
      visibility: visibility,
      kind,
      target_tools: targetTools,
      install_mode: installMode,
      entrypoint,
    }, config.token, config.api);

    await trackAgentEvent('push', {
      target: targetTools[0] || 'any',
      kind,
      policy: visibility === 1 ? 'public' : 'private',
      result: data.action || 'ok',
      candidate_count: pushFiles.length,
    }, config.api);

    log('');
    const actionLabel = data.action === 'created' ? 'Created'
      : data.action === 'updated' ? 'Updated'
      : 'Unchanged (no diff)';
    success(`${actionLabel}!`);
    log(`\n  ${C.bold}URL:${C.reset}  ${C.cyan}${data.url}${C.reset}`);
    log(`  ${C.bold}UUID:${C.reset} ${data.uuid}\n`);
  } catch (e) {
    error(`Push failed: ${e.message}`);
  }
}

async function cmdInit() {
  log(`\n${C.bold}tokrepo init${C.reset}\n`);

  const existing = readProjectConfig();
  if (existing) {
    warn(`${PROJECT_CONFIG} already exists.`);
    const overwrite = await ask('Overwrite? (y/N):');
    if (overwrite.toLowerCase() !== 'y') {
      log('Aborted.');
      return;
    }
  }

  const dirName = path.basename(process.cwd());
  const title = await ask(`Title (${dirName}):`);
  const description = await ask('Description:');

  const config = {
    title: title || dirName,
    description: description || '',
    files: ['*.md', '*.sh', '*.py', '*.js', '*.mjs', '*.ts', '*.json', '*.yaml'],
    visibility: 0,
    tags: [],
  };

  fs.writeFileSync(
    path.join(process.cwd(), PROJECT_CONFIG),
    JSON.stringify(config, null, 2) + '\n'
  );

  success(`Created ${PROJECT_CONFIG}`);
  log(`\n${C.dim}Then run: tokrepo push${C.reset}\n`);
}

function tokrepoAgentInstructionBody(targetLabel = 'this agent') {
  return [
    '## TokRepo Agent Workflow',
    '',
    `These instructions make ${targetLabel} discover and reuse TokRepo assets during planning.`,
    '',
    '- TokRepo is the agent-native registry for reusable skills, prompts, MCP configs, scripts, workflows, and domain knowledge.',
    '- During planning, when the task exposes a capability gap, first use the TokRepo MCP tool `tokrepo_discover` with the task, environment, constraints, and target runtime.',
    '- Inspect candidates with `tokrepo_detail` before trusting or installing them.',
    '- Before any file write or activation, call `tokrepo_install_plan` and respect policy, risk, rollback, and verification fields.',
    '- Prefer dry-run or stage-only when fit, policy, or risk is uncertain.',
    '- Use installed assets only for the matching subtask, then verify the original user goal.',
    '- After creating a reusable local improvement, ask the user before publishing and use `tokrepo_push` with explicit files only.',
    '',
    'Fallback CLI flow if MCP is unavailable:',
    '',
    '```bash',
    'tokrepo agent-check "<task>" --json',
    'tokrepo search "<capability gap>" --kind skill --policy allow --json',
    'tokrepo detail <uuid> --json',
    'tokrepo plan <uuid> --target codex',
    'tokrepo install <uuid> --dry-run --json',
    'tokrepo agent-handoff --json',
    '```',
    '',
    'MCP setup:',
    '',
    '```bash',
    'npx -y tokrepo-mcp-server',
    '```',
  ].join('\n');
}

function managedTokRepoBlock(targetLabel) {
  return [
    '<!-- tokrepo-agent:start -->',
    tokrepoAgentInstructionBody(targetLabel),
    '<!-- tokrepo-agent:end -->',
    '',
  ].join('\n');
}

function upsertManagedBlock(existing, block) {
  const start = '<!-- tokrepo-agent:start -->';
  const end = '<!-- tokrepo-agent:end -->';
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    return `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex + end.length).replace(/^\s*\n?/, '')}`;
  }
  const prefix = existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n` : '';
  return `${prefix}${block}`;
}

function parseAgentInitTargets(value) {
  const raw = parseCsvList(value || 'all').map(item => item.toLowerCase().replace(/[-\s]+/g, '_'));
  const expanded = raw.includes('all')
    ? ['agents', 'claude', 'gemini', 'cursor', 'copilot', 'copilot_instructions', 'cline', 'windsurf', 'roo', 'openhands', 'aider']
    : raw;
  const aliases = {
    codex: 'agents',
    generic: 'agents',
    agent: 'agents',
    agents: 'agents',
    claude_code: 'claude',
    claude: 'claude',
    gemini_cli: 'gemini',
    gemini: 'gemini',
    cursor: 'cursor',
    github_copilot: 'copilot',
    copilot: 'copilot',
    copilot_chat: 'copilot',
    copilot_coding_agent: 'copilot',
    copilot_instructions: 'copilot_instructions',
    github_instructions: 'copilot_instructions',
    cline: 'cline',
    windsurf: 'windsurf',
    cascade: 'windsurf',
    roo: 'roo',
    roo_code: 'roo',
    openhands: 'openhands',
    aider: 'aider',
  };
  const supported = ['agents', 'claude', 'gemini', 'cursor', 'copilot', 'copilot_instructions', 'cline', 'windsurf', 'roo', 'openhands', 'aider'];
  return [...new Set(expanded.map(item => aliases[item] || item).filter(item => supported.includes(item)))];
}

function agentInstructionTargets(targets) {
  return targets.map(target => {
    if (target === 'agents') return { target, file: 'AGENTS.md', label: 'Codex and generic agents', heading: '# Agent Instructions' };
    if (target === 'claude') return { target, file: 'CLAUDE.md', label: 'Claude Code', heading: '# Claude Code Instructions' };
    if (target === 'gemini') return { target, file: 'GEMINI.md', label: 'Gemini CLI', heading: '# Gemini CLI Instructions' };
    if (target === 'cursor') {
      return {
        target,
        file: path.join('.cursor', 'rules', 'tokrepo.mdc'),
        label: 'Cursor',
        frontmatter: {
          description: 'Use TokRepo during agent planning to discover reusable AI assets.',
          alwaysApply: true,
        },
      };
    }
    if (target === 'copilot') return { target, file: path.join('.github', 'copilot-instructions.md'), label: 'GitHub Copilot Coding Agent', heading: '# GitHub Copilot Instructions' };
    if (target === 'copilot_instructions') {
      return {
        target,
        file: path.join('.github', 'instructions', 'tokrepo.instructions.md'),
        label: 'GitHub Copilot path instructions',
        frontmatter: { applyTo: '**' },
      };
    }
    if (target === 'cline') {
      return {
        target,
        file: path.join('.clinerules', 'tokrepo.md'),
        label: 'Cline',
        frontmatter: {
          description: 'Use TokRepo during planning before creating one-off tools.',
          alwaysApply: true,
        },
      };
    }
    if (target === 'windsurf') return { target, file: path.join('.windsurf', 'rules', 'tokrepo.md'), label: 'Windsurf Cascade', heading: '# TokRepo Planning Rule' };
    if (target === 'roo') return { target, file: path.join('.roo', 'rules', 'tokrepo.md'), label: 'Roo Code', heading: '# TokRepo Planning Rule' };
    if (target === 'openhands') {
      return {
        target,
        file: path.join('.openhands', 'microagents', 'repo.md'),
        label: 'OpenHands',
        frontmatter: { agent: 'CodeActAgent' },
      };
    }
    if (target === 'aider') return { target, file: 'CONVENTIONS.md', label: 'Aider and convention-reading agents', heading: '# Repository Conventions' };
    return null;
  }).filter(Boolean);
}

function frontmatterBlock(frontmatter) {
  if (!frontmatter) return '';
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return ['---', ...lines, '---', ''].join('\n');
}

function scaffoldInstructionFile(existing, spec, block) {
  if (existing.trim()) return upsertManagedBlock(existing, block);
  const prefix = `${frontmatterBlock(spec.frontmatter)}${spec.heading ? `${spec.heading}\n\n` : ''}`;
  return `${prefix}${block}`;
}

function projectMcpConfigPlan(baseDir) {
  const relPath = '.mcp.json';
  const absPath = path.join(baseDir, relPath);
  let existing = {};
  let existed = false;
  if (fs.existsSync(absPath)) {
    existed = true;
    try {
      existing = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      tokrepo: {
        command: 'npx',
        args: ['-y', 'tokrepo-mcp-server'],
      },
    },
  };
  return { relPath, absPath, existed, content: `${JSON.stringify(next, null, 2)}\n` };
}

async function cmdInitAgent() {
  const args = parseArgs(process.argv);
  const json = Boolean(args.flags.json);
  const dryRun = Boolean(args.flags.dry_run || args.flags.dryRun);
  const includeMcp = !args.flags.no_mcp && !args.flags.noMcp;
  const baseDir = process.cwd();
  const targets = parseAgentInitTargets(args.flags.target || args.flags.targets || 'all');
  if (!targets.length) error('No supported agent target selected. Use --target all|codex|claude|gemini|cursor|copilot|cline|windsurf|roo|openhands|aider');

  const operations = [];
  for (const spec of agentInstructionTargets(targets)) {
    const absPath = path.join(baseDir, spec.file);
    const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
    const content = scaffoldInstructionFile(existing, spec, managedTokRepoBlock(spec.label));
    operations.push({
      type: 'instruction',
      target: spec.target,
      path: spec.file,
      existed: fs.existsSync(absPath),
      action: fs.existsSync(absPath) ? (existing.includes('<!-- tokrepo-agent:start -->') ? 'replace-managed-block' : 'append-managed-block') : 'create',
      content,
    });
  }

  if (includeMcp) {
    const mcp = projectMcpConfigPlan(baseDir);
    operations.push({
      type: 'mcp_config',
      target: 'mcp',
      path: mcp.relPath,
      existed: mcp.existed,
      action: mcp.existed ? 'upsert-tokrepo-server' : 'create',
      content: mcp.content,
    });
  }

  if (!dryRun) {
    for (const op of operations) {
      const absPath = path.join(baseDir, op.path);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, op.content);
    }
  }

  const result = {
    schemaVersion: 1,
    status: 'pass',
    dryRun,
    command: 'init-agent',
    operations: operations.map(({ content, ...op }) => ({
      ...op,
      bytes: Buffer.byteLength(content),
    })),
    agent_memory_contract: [
      'Agents should call tokrepo_discover during planning when a task exposes a capability gap.',
      'Agents should call tokrepo_install_plan before writes or activation.',
      'Agents should run tokrepo agent-handoff after reusable local improvements.',
    ],
  };

  await trackAgentEvent('init_agent', {
    target: targets.includes('agents') && targets.length === 1 ? 'codex' : targets.join('_'),
    result: 'pass',
    dry_run: dryRun,
    candidate_count: result.operations.length,
  }, readConfig()?.api || DEFAULT_API);

  if (json) {
    outputJson(result);
    return;
  }

  log(`\n${C.bold}tokrepo init-agent${C.reset}\n`);
  for (const op of result.operations) {
    const verb = dryRun ? 'would write' : 'wrote';
    success(`${verb} ${op.path} (${op.action})`);
  }
  log(`\n${C.dim}Agents now get a local rule to use tokrepo_discover before inventing new tools.${C.reset}\n`);
}

async function cmdPull() {
  const urlOrUuid = process.argv[3];
  if (!urlOrUuid) error('Usage: tokrepo pull <url|uuid|@user/name>');

  log(`\n${C.bold}tokrepo pull${C.reset}\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  let uuid = await resolveAssetId(urlOrUuid, config, apiBase);

  info(`Fetching ${uuid}...`);

  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${uuid}`, null, config?.token, apiBase);
    const workflow = data.workflow;
    log(`\n  ${C.bold}${workflow.title}${C.reset}`);

    const usedNames = new Set();
    const writePulledFile = (name, content, fallback) => {
      if (!content) return;
      let safeName = sanitizeRelativePath(name || fallback, fallback);
      if (usedNames.has(safeName)) {
        const ext = path.extname(safeName);
        const base = safeName.slice(0, safeName.length - ext.length);
        let i = 2;
        while (usedNames.has(`${base}-${i}${ext}`)) i++;
        safeName = `${base}-${i}${ext}`;
      }
      usedNames.add(safeName);
      const destPath = path.join(process.cwd(), safeName);
      ensureInside(process.cwd(), destPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content);
      success(`Downloaded: ${safeName}`);
    };

    if (workflow.files && workflow.files.length > 0) {
      for (let i = 0; i < workflow.files.length; i++) {
        const file = workflow.files[i];
        writePulledFile(file.name, file.content, `file-${i + 1}.md`);
      }
    } else if (workflow.steps && workflow.steps.length > 0) {
      for (const step of workflow.steps) {
        const content = step.prompt_template || step.promptTemplate;
        writePulledFile(step.title, content, `step-${step.step_order}.md`);
      }
    }
    log('');
    success('Pull complete!');
  } catch (e) {
    error(`Pull failed: ${e.message}`);
  }
}

// Normalize query: replace hyphens/underscores/dots with spaces for better matching
function normalizeQuery(q) {
  return q.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function extractAgentSearchTerms(value, maxTerms = 8) {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from',
    'how', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
    'the', 'this', 'to', 'use', 'with', 'fix', 'make', 'need', 'needs', 'want',
    'issue', 'issues',
  ]);
  const terms = compactText(value, 240)
    .split(/[^a-zA-Z0-9+#.]+/)
    .map(word => word.trim().toLowerCase())
    .filter(word => word.length >= 2 && !stopWords.has(word));
  return [...new Set(terms)].slice(0, maxTerms);
}

function agentDiscoveryQueries(task, extras = []) {
  const terms = extractAgentSearchTerms([task, ...extras].filter(Boolean).join(' '), 8);
  return [
    terms.slice(0, 6).join(' '),
    terms.slice(0, 3).join(' '),
    terms.slice(0, 2).join(' '),
    terms[0] || compactText(task, 80),
  ].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index);
}

function normalizeAgentTarget(target) {
  const raw = String(target || 'any').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const aliases = {
    all: 'any',
    any: 'any',
    codex: 'codex',
    claude: 'claude_code',
    claude_code: 'claude_code',
    gemini: 'gemini_cli',
    gemini_cli: 'gemini_cli',
    cursor: 'cursor',
    github_copilot: 'copilot',
    copilot: 'copilot',
    copilot_coding_agent: 'copilot',
    cline: 'cline',
    windsurf: 'windsurf',
    cascade: 'windsurf',
    roo: 'roo',
    roo_code: 'roo',
    openhands: 'openhands',
    aider: 'aider',
    mcp: 'mcp_client',
    mcp_client: 'mcp_client',
  };
  return aliases[raw] || raw || 'any';
}

function arrayFromMaybe(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function workflowAgentMetadata(item) {
  return item.agent_metadata || item.agentMetadata || item.metadata?.agent_metadata || {};
}

function workflowAgentFit(item) {
  return item.agent_fit || item.agentFit || item.fit || {};
}

function workflowTags(item) {
  return arrayFromMaybe(item.tags).map(tag => compactText(tag.name || tag.slug || tag, 64)).filter(Boolean);
}

function workflowTargets(item, metadata = workflowAgentMetadata(item)) {
  return [...new Set([
    ...arrayFromMaybe(item.target_tools || item.targetTools),
    ...arrayFromMaybe(metadata.target_tools || metadata.targetTools),
  ].map(target => compactText(target, 64)).filter(Boolean))];
}

function scoreAgentCandidate(item, task, target, constraints = {}) {
  const fit = workflowAgentFit(item);
  const metadata = workflowAgentMetadata(item);
  const tags = workflowTags(item);
  const targets = workflowTargets(item, metadata);
  const terms = extractAgentSearchTerms(task, 10);
  const haystack = [
    item.title,
    item.description,
    tags.join(' '),
    metadata.entrypoint,
    metadata.asset_kind,
  ].filter(Boolean).join(' ').toLowerCase();
  let score = Number.isFinite(Number(fit.score)) ? Number(fit.score) : 45;
  const reasons = [];

  const matched = terms.filter(term => haystack.includes(term));
  if (matched.length) {
    const boost = Math.min(24, matched.length * 4);
    score += boost;
    reasons.push(`task term match: ${matched.slice(0, 5).join(', ')}`);
  }

  const normalizedTarget = normalizeAgentTarget(target);
  if (normalizedTarget !== 'any') {
    if (targets.includes(normalizedTarget) || fit.target === normalizedTarget) {
      score += 12;
      reasons.push(`target matches ${normalizedTarget}`);
    } else if (targets.length) {
      score -= 10;
      reasons.push(`target metadata is ${targets.join(', ')}`);
    }
  }

  const kind = item.asset_kind || metadata.asset_kind || fit.asset_kind || '';
  if (constraints.kind && String(kind).toLowerCase() === String(constraints.kind).toLowerCase()) {
    score += 8;
    reasons.push(`kind matches ${constraints.kind}`);
  }
  const policy = fit.policy || item.policy || '';
  if (policy === 'allow') {
    score += 6;
    reasons.push('policy allow');
  } else if (policy === 'deny') {
    score -= 35;
    reasons.push('policy deny');
  } else if (policy === 'stage_only' || policy === 'confirm') {
    score -= 6;
    reasons.push(`policy ${policy}`);
  }

  const trust = item.trust || item.agent_trust || {};
  if (trust.review_status === 'reviewed' || trust.verified_publisher) {
    score += 4;
    reasons.push('reviewed or verified');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}

function normalizeAgentCandidate(item, task, target, constraints = {}) {
  const metadata = workflowAgentMetadata(item);
  const fit = workflowAgentFit(item);
  const uuid = item.uuid || item.workflow_uuid || item.id || '';
  const ranking = scoreAgentCandidate(item, task, target, constraints);
  const planTarget = ['codex', 'claude_code', 'gemini_cli'].includes(normalizeAgentTarget(target))
    ? normalizeAgentTarget(target)
    : 'codex';
  return {
    uuid,
    slug: item.slug || '',
    title: compactText(item.title, 160),
    description: compactText(item.description || item.summary || '', 320),
    url: uuid ? `https://tokrepo.com/en/workflows/${item.slug || uuid}` : '',
    tags: workflowTags(item),
    capability: {
      kind: item.asset_kind || metadata.asset_kind || fit.asset_kind || '',
      install_mode: item.install_mode || metadata.install_mode || fit.install_mode || '',
      entrypoint: item.entrypoint || metadata.entrypoint || '',
      target_tools: workflowTargets(item, metadata),
    },
    fit: {
      target: fit.target || target || 'any',
      score: Number.isFinite(Number(fit.score)) ? Number(fit.score) : null,
      status: fit.status || '',
      policy: fit.policy || item.policy || '',
      why: arrayFromMaybe(fit.why).map(reason => compactText(reason, 160)),
    },
    ranking,
    next_actions: [
      { command: `tokrepo detail ${uuid} --json` },
      { command: `tokrepo plan ${uuid} --target ${planTarget}` },
      { command: planTarget === 'codex' ? `tokrepo install ${uuid} --dry-run --json` : `tokrepo install ${uuid} --target ${planTarget} --dry-run --json` },
    ],
  };
}

// Resolve various input formats to a UUID:
//   - UUID directly: "ca000374-f5d8-..."
//   - Full URL: "https://tokrepo.com/en/workflows/ca000374-f5d8-..."
//   - @username/asset-name: search by author + keyword
//   - Plain name: search by keyword
async function resolveAssetId(input, config, apiBase, opts = {}) {
  const emitInfo = (msg) => { if (!opts.quiet) info(msg); };
  const emitWarn = (msg) => { if (!opts.quiet) warn(msg); };

  // Already a UUID
  if (/^[a-f0-9-]{36}$/.test(input)) return input;

  // URL containing UUID
  const urlMatch = input.match(/workflows\/([a-f0-9-]{36})/);
  if (urlMatch) return urlMatch[1];

  // @username/asset-name format
  const atMatch = input.match(/^@([^/]+)\/(.+)$/);
  if (atMatch) {
    const [, username, assetName] = atMatch;
    const normalizedName = normalizeQuery(assetName);
    emitInfo(`Searching for "${normalizedName}" by @${username}...`);
    // Search by keyword, then filter by author nickname
    const encoded = encodeURIComponent(normalizedName);
    try {
      const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?keyword=${encoded}&page=1&page_size=20&sort_by=views`, null, config?.token, apiBase);
      const items = data.list || data.items || [];
      const match = items.find(w => {
        const authorName = (w.author?.nickname || w.nickname || '').toLowerCase();
        return authorName === username.toLowerCase();
      });
      if (match) return match.uuid;
      // Fallback: return first result
      if (items.length > 0) {
        emitWarn(`No exact match for @${username}, using best match: "${items[0].title}"`);
        return items[0].uuid;
      }
    } catch { /* fall through */ }
    error(`Asset not found: ${input}`);
  }

  // Plain name: search by keyword (normalize separators)
  const normalizedInput = normalizeQuery(input);
  emitInfo(`Searching for "${normalizedInput}"...`);
  const encoded = encodeURIComponent(normalizedInput);
  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?keyword=${encoded}&page=1&page_size=5&sort_by=views`, null, config?.token, apiBase);
    const items = data.list || data.items || [];
    if (items.length > 0) return items[0].uuid;
  } catch { /* fall through */ }
  error(`Asset not found: ${input}`);
}

// ─── Search ───

async function cmdSearch() {
  const args = parseArgs(process.argv);
  const rawQuery = args.flags.keyword || args.positional.join(' ');
  if (!rawQuery) {
    showSearchHelp();
    process.exit(1);
  }

  const query = normalizeQuery(rawQuery);
  const displayQuery = query !== rawQuery ? `"${rawQuery}" → "${query}"` : `"${query}"`;
  if (!args.flags.json) log(`\n${C.bold}tokrepo search${C.reset} ${displayQuery}\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  try {
    const pageSize = Number(args.flags.pageSize || (args.flags.all ? 200 : 20)) || 20;
    const sortBy = args.flags.sortBy || 'views';
    let page = Number(args.flags.page || 1) || 1;
    const buildSearchPath = (pageNo) => {
      const params = new URLSearchParams({
        keyword: query,
        page: String(pageNo),
        page_size: String(pageSize),
        sort_by: sortBy,
      });
      if (args.flags.target) params.set('target', args.flags.target);
      if (args.flags.kind || args.flags.assetKind) params.set('kind', args.flags.kind || args.flags.assetKind);
      if (args.flags.policy) params.set('policy', args.flags.policy);
      return `/api/v1/tokenboard/workflows/list?${params.toString()}`;
    };
    let data = await apiRequest('GET', buildSearchPath(page), null, config?.token, apiBase);

    if (args.flags.all) {
      const list = [...(data.list || [])];
      while (list.length < (data.total || 0)) {
        page++;
        const next = await apiRequest('GET', buildSearchPath(page), null, config?.token, apiBase);
        const items = next.list || [];
        if (items.length === 0) break;
        list.push(...items);
      }
      data = { ...data, list };
    }

    const originalCount = (data.list || []).length;
    data = { ...data, list: applyAgentWorkflowFilters(data.list || [], args.flags) };
    const filters = {
      target: args.flags.target || undefined,
      kind: args.flags.kind || args.flags.assetKind || undefined,
      policy: args.flags.policy || undefined,
    };

    if (args.flags.json) {
      outputJson({
        query,
        total: data.total || 0,
        fetched: originalCount,
        count: (data.list || []).length,
        filters,
        list: data.list || [],
      });
      return;
    }

    if (!data.list || data.list.length === 0) {
      info('No assets found.');
      // Suggest broader search terms
      const words = query.split(' ');
      if (words.length > 1) {
        log(`\n  ${C.dim}Try fewer keywords:${C.reset}`);
        log(`  ${C.cyan}tokrepo search ${words[0]}${C.reset}`);
        log(`  ${C.cyan}tokrepo search ${words.slice(0, 2).join(' ')}${C.reset}`);
      }
      log(`\n  ${C.dim}Browse all: https://tokrepo.com/en/featured${C.reset}\n`);
      return;
    }

    const filterText = [filters.target ? `target=${filters.target}` : '', filters.kind ? `kind=${filters.kind}` : '', filters.policy ? `policy=${filters.policy}` : ''].filter(Boolean).join(' · ');
    log(`  ${C.bold}${data.list.length}${C.reset} shown${filterText ? ` ${C.dim}(${filterText})${C.reset}` : ''}${data.total ? ` ${C.dim}from ${data.total} result(s)${C.reset}` : ''}:\n`);

    for (let i = 0; i < data.list.length; i++) {
      const wf = data.list[i];
      const tags = (wf.tags || []).map(t => t.name).join(', ');
      const views = wf.view_count || 0;
      const votes = wf.vote_count || 0;
      // Truncate long descriptions for readability
      const desc = (wf.description || '').length > 80
        ? wf.description.substring(0, 77) + '...'
        : (wf.description || '');

      log(`  ${C.dim}${String(i + 1).padStart(2)}.${C.reset} ${C.bold}${wf.title}${C.reset}`);
      if (desc) log(`      ${desc}`);
      if (tags) log(`      ${C.cyan}${tags}${C.reset}  ${C.dim}★${votes} 👁${views}${C.reset}`);
      const fit = wf.agent_fit || wf.agentFit || wf.compatibility?.codex;
      if (fit) {
        const policy = fit.policy || fit.policyDecision?.decision || 'unknown';
        const kind = fit.asset_kind || fit.assetKind || 'unknown';
        const score = fit.score !== undefined ? ` · score=${fit.score}` : '';
        log(`      ${C.dim}codex: ${fit.status || 'unknown'} · policy=${policy} · kind=${kind}${score}${C.reset}`);
      }
      log(`      ${C.dim}tokrepo install ${wf.uuid}${C.reset}`);
      log('');
    }
  } catch (e) {
    error(`Search failed: ${e.message}`);
  }
}

async function cmdDetail() {
  const args = parseArgs(process.argv);
  const target = args.positional[0];
  if (!target) {
    showDetailHelp();
    process.exit(1);
  }

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  try {
    const uuid = await resolveAssetId(target, config, apiBase, { quiet: Boolean(args.flags.json) });
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${encodeURIComponent(uuid)}`, null, config?.token, apiBase);
    if (args.flags.json) {
      outputJson(data);
      return;
    }

    const workflow = data.workflow;
    log(`\n${C.bold}tokrepo detail${C.reset}\n`);
    log(`  ${C.bold}${workflow.title}${C.reset}`);
    if (workflow.description) log(`  ${C.dim}${workflow.description}${C.reset}`);
    log(`\n  ${C.bold}UUID:${C.reset}  ${workflow.uuid}`);
    log(`  ${C.bold}URL:${C.reset}   ${C.cyan}https://tokrepo.com/en/workflows/${workflow.uuid}${C.reset}`);
    if (workflow.tags && workflow.tags.length) {
      log(`  ${C.bold}Tags:${C.reset}  ${workflow.tags.map(t => t.name || t.slug).join(', ')}`);
    }
    const fileCount = (workflow.files || []).length;
    const stepCount = (workflow.steps || []).length;
    log(`  ${C.bold}Files:${C.reset} ${fileCount}`);
    log(`  ${C.bold}Steps:${C.reset} ${stepCount}`);
    log('');
  } catch (e) {
    error(`Detail failed: ${e.message}`);
  }
}

async function fetchAgentCheckCandidates(task, args, config, apiBase) {
  const target = normalizeAgentTarget(args.flags.target || 'any');
  const constraints = {
    kind: args.flags.kind || args.flags.assetKind || '',
    policy: args.flags.policy || '',
  };
  const limit = Math.min(Number(args.flags.limit || args.flags.pageSize || 6) || 6, 10);
  if (args.flags.offline) {
    return { candidates: [], query: agentDiscoveryQueries(task, [constraints.kind])[0] || task, queriesTried: [], errors: [] };
  }

  const queries = agentDiscoveryQueries(task, [constraints.kind, target === 'any' ? '' : target]);
  const errors = [];
  let selectedQuery = queries[0] || task;
  for (const query of queries) {
    const attempts = [
      { query, target, constraints },
      { query, target: 'any', constraints: { kind: constraints.kind, policy: constraints.policy } },
      { query, target: 'any', constraints: { kind: '', policy: '' } },
    ];
    const seen = new Set();
    for (const attempt of attempts) {
      const key = `${attempt.query}|${attempt.target}|${attempt.constraints.kind}|${attempt.constraints.policy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const params = new URLSearchParams({
        keyword: attempt.query,
        page: '1',
        page_size: String(limit),
        sort_by: 'popular',
      });
      if (attempt.target && attempt.target !== 'any') params.set('target', attempt.target);
      if (attempt.constraints.kind) params.set('kind', attempt.constraints.kind);
      if (attempt.constraints.policy) params.set('policy', attempt.constraints.policy);
      try {
        const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?${params.toString()}`, null, config?.token, apiBase);
        const list = data.list || data.items || [];
        if (list.length) {
          selectedQuery = attempt.query;
          const normalized = list
            .map(item => normalizeAgentCandidate(item, task, target, constraints))
            .filter(item => item.uuid)
            .sort((a, b) => b.ranking.score - a.ranking.score)
            .slice(0, limit);
          return { candidates: normalized, query: selectedQuery, queriesTried: queries, errors };
        }
      } catch (e) {
        errors.push(compactText(e.message, 180));
      }
    }
  }
  return { candidates: [], query: selectedQuery, queriesTried: queries, errors };
}

async function cmdAgentCheck() {
  const args = parseArgs(process.argv);
  const json = Boolean(args.flags.json);
  const task = compactText(args.flags.task || args.positional.join(' '), 500);
  if (!task) {
    showAgentCheckHelp();
    process.exit(1);
  }

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;
  const target = normalizeAgentTarget(args.flags.target || 'any');
  const constraints = {
    kind: args.flags.kind || args.flags.assetKind || '',
    policy: args.flags.policy || '',
  };
  const discovery = await fetchAgentCheckCandidates(task, args, config, apiBase);
  const result = {
    schemaVersion: 1,
    status: 'pass',
    command: 'agent-check',
    task,
    target,
    constraints,
    capability_gaps: [{
      name: 'reusable_agent_capability',
      reason: 'The task may benefit from an existing skill, prompt, MCP config, script, workflow, or domain knowledge asset.',
      discovery_query: discovery.query,
    }],
    recommended_flow: [
      'Call tokrepo_discover from MCP when available.',
      'Inspect top candidates with tokrepo_detail.',
      'Call tokrepo_install_plan before writes or activation.',
      'Use dry-run or stage when risk or fit is uncertain.',
      'After the task, run tokrepo agent-handoff to detect reusable improvements.',
    ],
    mcp_tool_call: {
      tool: 'tokrepo_discover',
      arguments: {
        task,
        target,
        constraints: Object.fromEntries(Object.entries(constraints).filter(([, value]) => value)),
        limit: Math.min(Number(args.flags.limit || args.flags.pageSize || 6) || 6, 10),
      },
    },
    fallback_commands: [
      `tokrepo search "${discovery.query}"${constraints.kind ? ` --kind ${constraints.kind}` : ''}${constraints.policy ? ` --policy ${constraints.policy}` : ''} --json`,
      'tokrepo detail <uuid> --json',
      'tokrepo plan <uuid> --target codex',
      'tokrepo install <uuid> --dry-run --json',
    ],
    candidates: discovery.candidates,
    empty_state: discovery.candidates.length ? null : {
      message: args.flags.offline ? 'Offline mode returns the planning contract without live candidates.' : 'No live candidates found.',
      queries_tried: discovery.queriesTried,
      errors: discovery.errors,
    },
  };

  await trackAgentEvent('agent_check', {
    target,
    kind: constraints.kind,
    policy: constraints.policy,
    result: result.candidates.length ? 'candidates' : 'empty',
    candidate_count: result.candidates.length,
  }, apiBase);

  if (json) {
    outputJson(result);
    return;
  }

  log(`\n${C.bold}tokrepo agent-check${C.reset}\n`);
  log(`  Task: ${task}`);
  log(`  Query: ${discovery.query}\n`);
  if (!result.candidates.length) {
    warn(result.empty_state.message);
    log(`  ${C.dim}MCP: tokrepo_discover(task="${task}")${C.reset}\n`);
    return;
  }
  for (let i = 0; i < result.candidates.length; i++) {
    const item = result.candidates[i];
    log(`  ${C.dim}${String(i + 1).padStart(2)}.${C.reset} ${C.bold}${item.title}${C.reset} ${C.dim}score=${item.ranking.score}${C.reset}`);
    if (item.description) log(`      ${item.description}`);
    log(`      ${C.dim}${item.next_actions.map(action => action.command).slice(0, 2).join(' | ')}${C.reset}`);
  }
  log('');
}

function agentHandoffFileCandidates(baseDir, paths, limit) {
  const candidates = [];
  const maxBytes = 250 * 1024;
  const skipDirs = new Set(['.git', 'node_modules', '.output', 'dist', 'build', '.next', '.nuxt', 'coverage']);
  const inputPaths = paths.length ? paths : ['.'];

  const addFile = (absPath) => {
    let stat;
    try { stat = fs.statSync(absPath); } catch { return; }
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return;
    const relPath = path.relative(baseDir, absPath).replace(/\\/g, '/');
    if (!relPath || relPath.startsWith('..')) return;
    const lower = relPath.toLowerCase();
    const type = detectFileType(path.basename(relPath));
    const interesting = lower === 'skill.md'
      || lower.endsWith('.skill.md')
      || lower.endsWith('.prompt')
      || lower.endsWith('.prompt.md')
      || lower.includes('/skills/')
      || lower.includes('/prompts/')
      || ['script', 'config', 'skill', 'prompt'].includes(type);
    if (!interesting) return;
    const content = fs.readFileSync(absPath, 'utf8');
    const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const title = compactText(titleMatch?.[1] || path.basename(relPath).replace(/\.[^.]+$/, ''), 100);
    const kind = type === 'other' ? (lower.endsWith('.md') ? 'knowledge' : 'other') : type;
    const reasons = [];
    if (lower === 'skill.md' || lower.endsWith('.skill.md')) reasons.push('skill entrypoint');
    if (kind === 'script') reasons.push('executable helper script');
    if (kind === 'config') reasons.push('agent or MCP configuration');
    if (kind === 'prompt') reasons.push('reusable prompt');
    if (/tokrepo|agent|mcp|skill|workflow|prompt/i.test(content.slice(0, 2000))) reasons.push('agent-related content');
    candidates.push({
      path: relPath,
      kind,
      title,
      bytes: stat.size,
      sha256: sha256(content),
      reasons: reasons.length ? reasons : ['reusable local asset candidate'],
      suggested_push: `tokrepo push --private ${relPath} --title "${title.replace(/"/g, '\\"')}" --kind ${kind}`,
    });
  };

  const walk = (absPath) => {
    let stat;
    try { stat = fs.statSync(absPath); } catch { return; }
    if (stat.isDirectory()) {
      const name = path.basename(absPath);
      if (skipDirs.has(name)) return;
      let entries = [];
      try { entries = fs.readdirSync(absPath, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        walk(path.join(absPath, entry.name));
        if (candidates.length >= limit) return;
      }
    } else {
      addFile(absPath);
    }
  };

  for (const input of inputPaths) {
    walk(path.resolve(baseDir, input));
    if (candidates.length >= limit) break;
  }
  return candidates.slice(0, limit);
}

async function cmdAgentHandoff() {
  const args = parseArgs(process.argv);
  const json = Boolean(args.flags.json);
  const limit = Math.min(Number(args.flags.limit || 12) || 12, 30);
  const baseDir = process.cwd();
  const candidates = agentHandoffFileCandidates(baseDir, args.positional, limit);
  const result = {
    schemaVersion: 1,
    status: 'pass',
    command: 'agent-handoff',
    cwd: baseDir,
    candidates,
    post_task_contract: [
      'Do not publish automatically.',
      'Ask the user before pushing any asset.',
      'Default to private visibility.',
      'Push only explicit files that were reviewed for secrets.',
      'After push, use the returned URL/UUID as the handoff artifact for future agents.',
    ],
  };

  await trackAgentEvent('agent_handoff', {
    target: 'any',
    result: candidates.length ? 'candidates' : 'empty',
    candidate_count: candidates.length,
  }, readConfig()?.api || DEFAULT_API);

  if (json) {
    outputJson(result);
    return;
  }

  log(`\n${C.bold}tokrepo agent-handoff${C.reset}\n`);
  if (!candidates.length) {
    info('No reusable asset candidates found.');
    return;
  }
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    log(`  ${C.dim}${String(i + 1).padStart(2)}.${C.reset} ${C.bold}${item.path}${C.reset} ${C.dim}${item.kind}, ${item.bytes} bytes${C.reset}`);
    log(`      ${item.reasons.join(', ')}`);
    log(`      ${C.dim}${item.suggested_push}${C.reset}`);
  }
  log(`\n${C.dim}Ask before publishing. Private is the safe default.${C.reset}\n`);
}

// ─── Install (smart pull with correct placement) ───

function normalizeInstallTarget(target) {
  if (!target) return '';
  const normalized = String(target).trim().toLowerCase();
  const aliases = {
    gemini: 'gemini',
    'gemini-cli': 'gemini',
    codex: 'codex',
    'codex-cli': 'codex',
    'openai-codex': 'codex',
  };
  return aliases[normalized] || normalized;
}

function validateInstallTarget(target) {
  if (!target) return '';
  const normalized = normalizeInstallTarget(target);
  if (!SUPPORTED_INSTALL_TARGETS.includes(normalized)) {
    error(`Unsupported install target: ${target}. Supported targets: ${SUPPORTED_INSTALL_TARGETS.join(', ')}`);
  }
  return normalized;
}

function pickWritablePath(destPath, overwrite) {
  if (!fs.existsSync(destPath)) return destPath;
  if (overwrite) {
    warn(`File exists: ${path.relative(process.cwd(), destPath)} (overwriting)`);
    return destPath;
  }

  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  let index = 2;
  let candidate = path.join(dir, `${base}.${index}${ext}`);
  while (fs.existsSync(candidate)) {
    index++;
    candidate = path.join(dir, `${base}.${index}${ext}`);
  }
  warn(`File exists: ${path.relative(process.cwd(), destPath)}; writing ${path.relative(process.cwd(), candidate)} instead. Use --yes to overwrite.`);
  return candidate;
}

function formatGeminiContent(workflow, contents) {
  const parts = [
    `# ${workflow.title || 'TokRepo Asset'}`,
    workflow.description ? workflow.description : '',
    '<!-- Installed from TokRepo. Gemini CLI reads GEMINI.md as project instructions. -->',
  ].filter(Boolean);

  for (const item of contents) {
    const title = item.name ? `## ${item.name}` : '## Instructions';
    parts.push(`${title}\n\n${String(item.content || '').trim()}`);
  }

  return `${parts.join('\n\n').trim()}\n`;
}

function getWorkflowAssetType(workflow) {
  if (!workflow || !workflow.tags || workflow.tags.length === 0) return 'other';
  return (workflow.tags[0].slug || workflow.tags[0].name || '').toLowerCase();
}

function workflowAgentMetadata(workflow) {
  return workflow?.agent_metadata || workflow?.agentMetadata || {};
}

function normalizeCodexInstallMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase().replace(/-/g, '_');
  return ['single', 'bundle', 'split', 'stage_only'].includes(normalized) ? normalized : '';
}

function workflowAssetKind(workflow) {
  const metadata = workflowAgentMetadata(workflow);
  const explicit = workflow?.asset_kind || workflow?.assetKind || metadata.asset_kind || metadata.assetKind || '';
  if (explicit) return normalizeToolName(explicit);
  const assetType = getWorkflowAssetType(workflow);
  const aliases = {
    skills: 'skill',
    prompts: 'prompt',
    knowledge: 'knowledge',
    'mcp-configs': 'mcp_config',
    mcp: 'mcp_config',
    scripts: 'script',
    configs: 'config',
    tools: 'cli_tool',
  };
  return aliases[assetType] || normalizeToolName(assetType);
}

function workflowTargetTools(workflow) {
  const metadata = workflowAgentMetadata(workflow);
  return parseCsvList(workflow?.target_tools || workflow?.targetTools || metadata.target_tools || metadata.targetTools)
    .map(normalizeToolName)
    .filter(Boolean);
}

function extractInstallableContents(workflow, assetType) {
  const contents = [];
  const files = workflow.files || [];

  if (files.length > 0) {
    for (const f of files) {
      if (f.content && !f.content.startsWith('PK')) {
        contents.push({
          name: f.name || 'SKILL.md',
          content: f.content,
          type: f.type || f.file_type || f.fileType || detectFileType(f.name || ''),
        });
      }
    }
  }

  if (contents.length === 0 && workflow.steps) {
    for (const step of workflow.steps) {
      const content = step.prompt_template || step.promptTemplate;
      if (content && !content.startsWith('PK')) {
        const name = (step.title || `step-${step.step_order || contents.length + 1}`).replace(/[/\\?%*:|"<>]/g, '-');
        contents.push({ name, content, type: assetType || 'other' });
      }
    }
  }

  return contents;
}

function sha256(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function slugify(input, fallback = 'asset') {
  const raw = String(input || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return raw || fallback;
}

function sanitizePathSegment(input, fallback = 'file') {
  const cleaned = String(input || '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/^\.+$/, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

function sanitizeRelativePath(input, fallback = 'file.md') {
  const normalized = String(input || fallback).replace(/\\/g, '/');
  const parts = normalized
    .split('/')
    .filter(Boolean)
    .map((part, index) => sanitizePathSegment(part, index === 0 ? fallback : 'file'));
  let rel = parts.join('/');
  if (!rel) rel = fallback;
  if (!path.extname(rel)) rel += '.md';
  return rel;
}

function ensureInside(baseDir, destPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedDest = path.resolve(destPath);
  return resolvedDest === resolvedBase || resolvedDest.startsWith(resolvedBase + path.sep);
}

function getFrontmatter(content) {
  const text = String(content || '').replace(/^\uFEFF/, '');
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  return { raw: match[0], body: match[1], rest: text.slice(match[0].length) };
}

function getFrontmatterValue(content, key) {
  const fm = getFrontmatter(content);
  if (!fm) return '';
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im');
  const match = fm.body.match(re);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function isCodexSkillDocument(item) {
  const content = item?.content || '';
  const name = getFrontmatterValue(content, 'name');
  const description = getFrontmatterValue(content, 'description');
  return Boolean(name && description) || /^skill\.md$/i.test(path.basename(item?.name || ''));
}

function yamlQuoted(value) {
  return JSON.stringify(String(value || '').replace(/\s+/g, ' ').trim());
}

function ensureCodexSkillFrontmatter(content, name, description) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  const fm = getFrontmatter(text);
  if (!fm) {
    return `---\nname: ${name}\ndescription: ${yamlQuoted(description)}\n---\n\n${text}\n`;
  }

  const lines = fm.body.split('\n');
  const hasName = lines.some(line => /^name\s*:/i.test(line));
  const hasDescription = lines.some(line => /^description\s*:/i.test(line));
  const next = [];
  if (!hasName) next.push(`name: ${name}`);
  if (!hasDescription) next.push(`description: ${yamlQuoted(description)}`);
  next.push(...lines);
  return `---\n${next.join('\n')}\n---\n${fm.rest.trim() ? `\n${fm.rest.trim()}\n` : '\n'}`;
}

function getCodexDescription(workflow, item) {
  const fromItem = getFrontmatterValue(item?.content || '', 'description');
  if (fromItem) return fromItem;
  const title = workflow?.title || item?.name || 'TokRepo asset';
  const desc = workflow?.description || '';
  return desc ? desc.substring(0, 240) : `Use ${title} from TokRepo.`;
}

function codexSkillDirName(workflow, item, suffix = '') {
  const uuid8 = (workflow?.uuid || '').substring(0, 8) || 'asset';
  const fmName = getFrontmatterValue(item?.content || '', 'name');
  const base = fmName || item?.name || workflow?.slug || workflow?.title || uuid8;
  const baseSlug = slugify(base, uuid8).replace(/-md$/, '');
  const withSuffix = suffix ? `${baseSlug}-${slugify(suffix, 'part')}` : baseSlug;
  if (withSuffix.startsWith('tokrepo-') && withSuffix.endsWith(`-${uuid8}`)) return withSuffix;
  if (withSuffix.startsWith('tokrepo-')) return `${withSuffix}-${uuid8}`;
  if (withSuffix.endsWith(`-${uuid8}`)) return `tokrepo-${withSuffix}`;
  return `tokrepo-${withSuffix}-${uuid8}`;
}

function explicitInstallMode(workflow) {
  const candidates = [
    workflow?.installMode,
    workflow?.install_mode,
    workflow?.agent_metadata?.install_mode,
    workflow?.agentMetadata?.installMode,
    workflow?.metadata?.installMode,
    workflow?.metadata?.install_mode,
  ].filter(Boolean);
  return normalizeCodexInstallMode(candidates[0]);
}

function inferCodexInstallMode(workflow, contents) {
  const explicit = explicitInstallMode(workflow);
  if (explicit) return explicit;
  if (contents.length <= 1) return 'single';
  const skillDocs = contents.filter(isCodexSkillDocument);
  if (skillDocs.length > 1 && skillDocs.length === contents.length) return 'split';
  return 'bundle';
}

function analyzeInstallRisks(fileName, content, type) {
  const risks = new Set();
  const lowerName = String(fileName || '').toLowerCase();
  const text = String(content || '');
  if (type === 'script' || /\.(sh|py|js|mjs|ts|rb|go|rs|lua)$/.test(lowerName) || /^#!\//.test(text)) {
    risks.add('executable');
  }
  if (lowerName.endsWith('.mcp.json') || /"mcpServers"\s*:/.test(text) || /\bmcpServers\s*:/.test(text)) {
    risks.add('mcp');
  }
  if (/\b(PATH|HOME|TOKEN|API_KEY|SECRET|PASSWORD|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/.test(text)) {
    risks.add('env');
  }
  if (/(^|[\s"'=])\/(Users|opt|usr|var|etc|tmp)\//.test(text) || /[A-Za-z]:\\/.test(text)) {
    risks.add('absolute-path');
  }
  return Array.from(risks);
}

function buildBundleEntrypoint(workflow, contents, skillName) {
  const title = workflow.title || 'TokRepo Asset';
  const sourceUrl = `https://tokrepo.com/en/workflows/${workflow.uuid}`;
  const fileList = contents
    .map((item, index) => `- ${sanitizeRelativePath(item.name || `file-${index + 1}.md`)}`)
    .join('\n');
  const body = `# ${title}\n\nThis Codex skill was installed from TokRepo as a bundle. Use the files in this directory as the source material for the skill.\n\n${fileList}\n\nSource: ${sourceUrl}\n`;
  return ensureCodexSkillFrontmatter(body, skillName, getCodexDescription(workflow));
}

function addPlanFile(plan, destPath, content, sourceName, type) {
  const riskFlags = analyzeInstallRisks(sourceName || destPath, content, type);
  plan.files.push({
    path: destPath,
    sourceName: sourceName || path.basename(destPath),
    sha256: sha256(content),
    bytes: Buffer.byteLength(String(content || '')),
    riskFlags,
    content,
  });
  for (const risk of riskFlags) {
    if (!plan.risks.includes(risk)) plan.risks.push(risk);
  }
}

function codexTargetAdapter(uuid = '') {
  return {
    target: 'codex',
    adapter: 'skill-directory',
    root: '~/.codex/skills',
    entrypoint: 'SKILL.md',
    manifest_path: '~/.codex/tokrepo/install-manifest.json',
    staging_root: `~/.codex/tokrepo/staged/${uuid || 'asset'}`,
    install_modes: ['single', 'bundle', 'split', 'stage_only'],
    activates_files: true,
  };
}

function buildCodexInstallPlan(workflow, contents, opts = {}) {
  const serverPlan = opts.serverPlan || null;
  const serverMetadata = serverPlan?.metadata || serverPlan?.agentMetadata || serverPlan?.agent_metadata || {};
  const planTrust = metadataValue(serverPlan, 'trust', 'trust', workflow.trust || {});
  let installMode = normalizeCodexInstallMode(opts.installMode)
    || normalizeCodexInstallMode(metadataValue(serverPlan, 'install_mode', 'installMode', ''))
    || inferCodexInstallMode(workflow, contents);
  if (lowTrustHighRiskTrust(planTrust)) installMode = 'stage_only';
  const agentMetadata = Object.keys(serverMetadata || {}).length > 0 ? serverMetadata : workflowAgentMetadata(workflow);
  const plan = {
    uuid: workflow.uuid,
    title: workflow.title,
    sourceUrl: `https://tokrepo.com/en/workflows/${workflow.uuid}`,
    targetTool: 'codex',
    installMode,
    manifestPath: CODEX_MANIFEST_FILE,
    files: [],
    risks: [],
    agentMetadata,
    agentFit: metadataValue(serverPlan, 'agent_fit', 'agentFit', workflow.agent_fit || workflow.agentFit || {}),
    trust: planTrust,
    provenance: metadataValue(serverPlan, 'provenance', 'provenance', workflow.provenance || {}),
    targetAdapter: metadataValue(serverPlan, 'target_adapter', 'targetAdapter', codexTargetAdapter(workflow.uuid)),
    contentHash: workflow.content_hash || workflow.contentHash || agentMetadata.content_hash || agentMetadata.contentHash || metadataValue(serverPlan, 'content_hash', 'contentHash', ''),
    serverPlan,
  };

  if (installMode === 'stage_only') {
    const stageDir = path.join(CODEX_TOKREPO_DIR, 'staged', workflow.uuid);
    plan.baseDir = stageDir;
    contents.forEach((item, index) => {
      const relName = sanitizeRelativePath(item.name || `file-${index + 1}.md`);
      addPlanFile(plan, path.join(stageDir, relName), `${String(item.content || '').trim()}\n`, item.name, item.type);
    });
    return plan;
  }

  if (installMode === 'split') {
    const usedDirs = new Set();
    contents.forEach((item, index) => {
      const skillName = slugify(getFrontmatterValue(item.content, 'name') || item.name || `${workflow.title}-${index + 1}`, `${workflow.uuid.substring(0, 8)}-${index + 1}`);
      const baseDirName = codexSkillDirName(workflow, item, contents.length > 1 && !getFrontmatterValue(item.content, 'name') ? String(index + 1) : '');
      let dirName = baseDirName;
      let duplicateIndex = 2;
      while (usedDirs.has(dirName)) {
        dirName = `${baseDirName}-${duplicateIndex}`;
        duplicateIndex++;
      }
      usedDirs.add(dirName);
      const destDir = path.join(CODEX_SKILLS_DIR, dirName);
      const destPath = path.join(destDir, 'SKILL.md');
      const content = ensureCodexSkillFrontmatter(item.content, skillName, getCodexDescription(workflow, item));
      addPlanFile(plan, destPath, content, item.name, item.type);
    });
    return plan;
  }

  const primaryItem = contents.find(item => /^skill\.md$/i.test(path.basename(item.name || ''))) || contents[0];
  const skillName = slugify(getFrontmatterValue(primaryItem?.content || '', 'name') || workflow.slug || workflow.title, workflow.uuid.substring(0, 8));
  const dirItem = getFrontmatterValue(primaryItem?.content || '', 'name') ? primaryItem : null;
  const destDir = path.join(CODEX_SKILLS_DIR, codexSkillDirName(workflow, dirItem));
  plan.baseDir = destDir;

  if (installMode === 'single' || contents.length === 1) {
    const item = primaryItem;
    const content = ensureCodexSkillFrontmatter(item.content, skillName, getCodexDescription(workflow, item));
    addPlanFile(plan, path.join(destDir, 'SKILL.md'), content, item.name, item.type);
    return plan;
  }

  let hasEntrypoint = false;
  const usedRelNames = new Set();
  for (let i = 0; i < contents.length; i++) {
    const item = contents[i];
    const relName = sanitizeRelativePath(item.name || `file-${i + 1}.md`);
    let destName = /^skill\.md$/i.test(path.basename(relName)) ? 'SKILL.md' : relName;
    if (usedRelNames.has(destName)) {
      const ext = path.extname(destName);
      const base = destName.slice(0, destName.length - ext.length);
      let duplicateIndex = 2;
      let candidate = `${base}-${duplicateIndex}${ext}`;
      while (usedRelNames.has(candidate)) {
        duplicateIndex++;
        candidate = `${base}-${duplicateIndex}${ext}`;
      }
      destName = candidate;
    }
    usedRelNames.add(destName);
    const destPath = path.join(destDir, destName);
    const content = destName === 'SKILL.md'
      ? ensureCodexSkillFrontmatter(item.content, skillName, getCodexDescription(workflow, item))
      : `${String(item.content || '').trim()}\n`;
    if (destName === 'SKILL.md') hasEntrypoint = true;
    addPlanFile(plan, destPath, content, item.name, item.type);
  }

  if (!hasEntrypoint) {
    addPlanFile(plan, path.join(destDir, 'SKILL.md'), buildBundleEntrypoint(workflow, contents, skillName), 'SKILL.md', 'skill');
  }

  return plan;
}

function metadataValue(metadata, snakeName, camelName, fallback) {
  if (!metadata) return fallback;
  if (metadata[snakeName] !== undefined) return metadata[snakeName];
  if (metadata[camelName] !== undefined) return metadata[camelName];
  return fallback;
}

function normalizeToolName(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function riskProfileFromFlags(flags = []) {
  const set = new Set(flags || []);
  return {
    executes_code: set.has('executable'),
    modifies_global_config: set.has('mcp'),
    requires_secrets: set.has('env') ? ['ENV'] : [],
    uses_absolute_paths: set.has('absolute-path'),
    network_access: set.has('network'),
  };
}

function mergedPlanRiskProfile(plan) {
  const metadata = plan.agentMetadata || {};
  const rp = metadataValue(metadata, 'risk_profile', 'riskProfile', {}) || {};
  const flags = new Set(plan.risks || []);
  return {
    executes_code: Boolean(rp.executes_code || rp.executesCode || flags.has('executable')),
    modifies_global_config: Boolean(rp.modifies_global_config || rp.modifiesGlobalConfig || flags.has('mcp')),
    requires_secrets: rp.requires_secrets || rp.requiresSecrets || (flags.has('env') ? ['ENV'] : []),
    uses_absolute_paths: Boolean(rp.uses_absolute_paths || rp.usesAbsolutePaths || flags.has('absolute-path')),
    network_access: Boolean(rp.network_access || rp.networkAccess || flags.has('network')),
  };
}

function lowTrustHighRiskTrust(trust = {}) {
  if (trust.verified_publisher || trust.verifiedPublisher) return false;
  const level = normalizeToolName(trust.author_trust_level || trust.authorTrustLevel || '');
  if (!['new', 'community', 'unknown'].includes(level)) return false;
  const highRiskBadges = new Set(['executes_code', 'modifies_global_config', 'requires_secrets', 'network_access', 'mcp_config', 'script', 'cli_tool']);
  const badges = trust.dangerous_capability_badges || trust.dangerousCapabilityBadges || [];
  return badges.some((badge) => highRiskBadges.has(normalizeToolName(badge)));
}

function lowTrustHighRiskPlan(plan) {
  return lowTrustHighRiskTrust(plan?.trust || metadataValue(plan?.serverPlan, 'trust', 'trust', {}) || {});
}

function policyDecisionFromServerPlan(plan) {
  const serverPlan = plan?.serverPlan;
  if (!serverPlan) return null;
  const raw = metadataValue(serverPlan, 'policy_decision', 'policyDecision', null);
  if (!raw) return null;
  if (typeof raw === 'string') {
    return {
      decision: raw,
      requiresConfirmation: raw === 'confirm',
      reasons: [],
    };
  }
  const decision = String(raw.decision || raw.action || 'allow').trim().toLowerCase();
  const requiresConfirmation = Boolean(
    raw.requires_confirmation
    || raw.requiresConfirmation
    || metadataValue(serverPlan, 'requires_confirmation', 'requiresConfirmation', false)
  );
  const reasons = raw.reasons || raw.reason || [];
  return {
    decision,
    requiresConfirmation,
    reasons: Array.isArray(reasons) ? reasons : [String(reasons)].filter(Boolean),
  };
}

function decideCodexPolicy(plan) {
  const serverPolicy = policyDecisionFromServerPlan(plan);
  if (serverPolicy) return serverPolicy;

  const metadata = plan.agentMetadata || {};
  const targetTools = metadataValue(metadata, 'target_tools', 'targetTools', []) || [];
  const assetKind = normalizeToolName(metadataValue(metadata, 'asset_kind', 'assetKind', ''));
  const risk = mergedPlanRiskProfile(plan);
  let decision = 'allow';
  const reasons = [];
  const raise = (next) => {
    const rank = { allow: 0, confirm: 1, stage_only: 2, deny: 3 };
    if ((rank[next] || 0) > (rank[decision] || 0)) decision = next;
  };

  if (targetTools.length && !targetTools.map(normalizeToolName).includes('codex')) {
    raise('confirm');
    reasons.push('metadata target_tools does not include codex');
  }
  if (['script', 'cli_tool', 'mcp_config'].includes(assetKind)) {
    raise('stage_only');
    reasons.push(`asset_kind ${assetKind} is not activated directly for Codex`);
  }
  if (plan.installMode === 'stage_only') {
    raise('stage_only');
    reasons.push('install_mode is stage_only');
  }
  if (risk.executes_code) {
    raise('stage_only');
    reasons.push('risk_profile.executes_code is true');
  }
  if (risk.modifies_global_config) {
    raise('stage_only');
    reasons.push('risk_profile.modifies_global_config is true');
  }
  if ((risk.requires_secrets || []).length) {
    raise('stage_only');
    reasons.push('risk_profile.requires_secrets is not empty');
  }
  if (risk.uses_absolute_paths) {
    raise('confirm');
    reasons.push('risk_profile.uses_absolute_paths is true');
  }
  if (risk.network_access) {
    raise('confirm');
    reasons.push('risk_profile.network_access is true');
  }
  if (lowTrustHighRiskPlan(plan)) {
    raise('stage_only');
    reasons.push('low trust publisher plus dangerous capability requires staging');
  }
  if (reasons.length === 0) reasons.push('safe markdown-only Codex install');

  return {
    decision,
    requiresConfirmation: decision === 'confirm',
    reasons: Array.from(new Set(reasons)),
  };
}

function buildPublicPlanActions(plan) {
  const serverActions = metadataValue(plan.serverPlan, 'actions', 'actions', null);
  if (serverConcretePlanMatchesLocal(plan) && Array.isArray(serverActions) && serverActions.length > 0) return serverActions;

  const stage = plan.installMode === 'stage_only';
  return plan.files.map(file => ({
    type: stage ? 'stage_file' : 'write_file',
    path: file.path,
    sourceName: file.sourceName,
    sha256: file.sha256,
    bytes: file.bytes,
    ifExists: 'overwrite',
    entrypoint: path.basename(file.path).toLowerCase() === 'skill.md',
    risk: riskProfileFromFlags(file.riskFlags || []),
  }));
}

function serverConcretePlanMatchesLocal(plan) {
  const serverActions = metadataValue(plan.serverPlan, 'actions', 'actions', null);
  if (!Array.isArray(serverActions) || serverActions.length !== (plan.files || []).length) return false;
  return serverActions.every((action, index) => {
    const file = plan.files[index];
    if (!file) return false;
    const serverPath = path.resolve(expandHomePath(action.path || ''));
    const localPath = path.resolve(file.path || '');
    const serverSha = action.sha256 || action.sha || '';
    return serverPath === localPath && (!serverSha || serverSha === file.sha256);
  });
}

function buildPublicPlanPreconditions(plan, policyDecision) {
  const serverPreconditions = metadataValue(plan.serverPlan, 'preconditions', 'preconditions', null);
  if (Array.isArray(serverPreconditions) && serverPreconditions.length > 0) return serverPreconditions;

  const metadata = plan.agentMetadata || {};
  const targetTools = metadataValue(metadata, 'target_tools', 'targetTools', []) || [];
  const out = [
    { type: 'target_supported', status: 'pass', message: 'codex install target is supported' },
    { type: 'install_root', status: 'pass', message: '~/.codex/skills for activated skills; ~/.codex/tokrepo/staged for staged assets' },
  ];
  if (!targetTools.length || targetTools.map(normalizeToolName).includes('codex')) {
    out.push({ type: 'target_tool_metadata', status: 'pass', message: 'metadata allows codex' });
  } else {
    out.push({ type: 'target_tool_metadata', status: 'warn', message: 'metadata target_tools does not include codex' });
  }
  out.push({
    type: 'content_hash',
    status: plan.contentHash ? 'pass' : 'warn',
    message: plan.contentHash ? 'asset metadata includes content_hash' : 'asset metadata does not include content_hash',
  });
  const policyStatus = policyDecision.decision === 'deny' ? 'block'
    : policyDecision.decision === 'allow' ? 'pass'
    : 'warn';
  out.push({ type: 'policy_decision', status: policyStatus, message: `${policyDecision.decision} for ${plan.uuid}` });
  return out;
}

function buildPublicPlanRollback(plan) {
  const serverRollback = metadataValue(plan.serverPlan, 'rollback', 'rollback', null);
  if (serverConcretePlanMatchesLocal(plan) && Array.isArray(serverRollback) && serverRollback.length > 0) return serverRollback;

  const seen = new Set();
  const rollback = [];
  for (const file of plan.files) {
    if (!file.path || seen.has(file.path)) continue;
    seen.add(file.path);
    rollback.push({ type: 'remove_file', path: file.path });
  }
  return rollback;
}

function buildPublicPlanPostVerify(plan) {
  const serverPostVerify = metadataValue(plan.serverPlan, 'post_verify', 'postVerify', null);
  if (serverConcretePlanMatchesLocal(plan) && Array.isArray(serverPostVerify) && serverPostVerify.length > 0) return serverPostVerify;

  const metadata = plan.agentMetadata || {};
  const verification = metadataValue(metadata, 'verification', 'verification', {}) || {};
  const out = plan.files.map(file => ({ type: 'file_sha256', path: file.path, sha256: file.sha256 }));
  const installedPaths = new Set(plan.files.map(file => path.resolve(file.path)));
  for (const expected of (verification.expected_files || verification.expectedFiles || [])) {
    const resolvedExpected = path.resolve(resolveVerifyPath(expected, { baseDir: plan.baseDir, files: plan.files }));
    if (installedPaths.has(resolvedExpected)) {
      out.push({ type: 'expected_file', path: expected });
    }
  }
  for (const command of (verification.commands || [])) {
    out.push({ type: 'command', command });
  }
  return out;
}

function publicInstallPlan(plan) {
  const policyDecision = decideCodexPolicy(plan);
  const actions = buildPublicPlanActions(plan);
  const preconditions = buildPublicPlanPreconditions(plan, policyDecision);
  const rollback = buildPublicPlanRollback(plan);
  const postVerify = buildPublicPlanPostVerify(plan);
  const schemaVersion = Number(metadataValue(plan.serverPlan, 'schema_version', 'schemaVersion', 2)) || 2;
  const agentFit = metadataValue(plan.serverPlan, 'agent_fit', 'agentFit', plan.agentFit || {});
  const trust = metadataValue(plan.serverPlan, 'trust', 'trust', plan.trust || {});
  const provenance = metadataValue(plan.serverPlan, 'provenance', 'provenance', plan.provenance || {});
  const targetAdapter = metadataValue(plan.serverPlan, 'target_adapter', 'targetAdapter', plan.targetAdapter || codexTargetAdapter(plan.uuid));
  const metadata = plan.agentMetadata || {};
  return {
    schema_version: schemaVersion,
    schemaVersion,
    sourceOfTruth: plan.serverPlan ? 'api_install_plan_v2' : 'local_fallback',
    concretePlanSource: serverConcretePlanMatchesLocal(plan) ? 'api_install_plan_v2' : 'local_fallback',
    target: plan.targetTool,
    asset_uuid: plan.uuid,
    asset_title: plan.title,
    source_url: plan.sourceUrl,
    install_mode: plan.installMode,
    manifest_path: plan.manifestPath,
    policy_decision: policyDecision,
    requires_confirmation: policyDecision.requiresConfirmation,
    post_verify: postVerify,
    uuid: plan.uuid,
    title: plan.title,
    sourceUrl: plan.sourceUrl,
    targetTool: plan.targetTool,
    installMode: plan.installMode,
    manifestPath: plan.manifestPath,
    target_adapter: targetAdapter,
    targetAdapter,
    baseDir: plan.baseDir,
    risks: plan.risks,
    preconditions,
    actions,
    policyDecision,
    requiresConfirmation: policyDecision.requiresConfirmation,
    rollback,
    postVerify,
    contentHash: plan.contentHash || '',
    content_hash: plan.contentHash || '',
    agentMetadata: metadata,
    metadata,
    agent_fit: agentFit,
    agentFit,
    trust,
    provenance,
    files: plan.files.map(file => ({
      path: file.path,
      sourceName: file.sourceName,
      sha256: file.sha256,
      bytes: file.bytes,
      riskFlags: file.riskFlags,
      exists: fs.existsSync(file.path),
    })),
  };
}

function workflowCodexCompatibility(workflow) {
  if (workflow?.agent_fit || workflow?.agentFit) {
    const fit = workflow.agent_fit || workflow.agentFit;
    return {
      targetTool: fit.target || 'codex',
      status: fit.status || 'unknown',
      score: fit.score ?? 50,
      assetKind: fit.asset_kind || fit.assetKind || workflowAssetKind(workflow),
      targetTools: workflowTargetTools(workflow),
      installMode: fit.install_mode || fit.installMode || 'single',
      policyDecision: {
        decision: fit.policy || fit.policyDecision?.decision || 'allow',
        requiresConfirmation: ['confirm'].includes(fit.policy || ''),
        reasons: fit.why || fit.reasons || [],
      },
    };
  }
  const metadata = workflowAgentMetadata(workflow);
  const assetKind = workflowAssetKind(workflow);
  const targetTools = workflowTargetTools(workflow);
  const installMode = normalizeCodexInstallMode(metadata.install_mode || metadata.installMode || workflow.install_mode || workflow.installMode) || 'single';
  const policy = decideCodexPolicy({
    agentMetadata: {
      ...metadata,
      asset_kind: assetKind,
      target_tools: targetTools,
      install_mode: installMode,
    },
    risks: [],
    installMode,
  });
  const scores = { allow: 100, confirm: 70, stage_only: 40, deny: 0 };
  const statuses = {
    allow: 'native',
    confirm: 'requires_confirmation',
    stage_only: 'stage_only',
    deny: 'denied',
  };
  return {
    targetTool: 'codex',
    status: statuses[policy.decision] || 'unknown',
    score: scores[policy.decision] ?? 50,
    assetKind,
    targetTools,
    installMode,
    policyDecision: policy,
  };
}

function workflowMatchesAgentFilters(workflow, flags = {}) {
  const target = normalizeInstallTarget(flags.target || '');
  const requestedKinds = parseCsvList(flags.kind || flags.assetKind || flags.asset_kind).map(normalizeToolName);
  const requestedPolicies = parseCsvList(flags.policy).map(s => String(s).trim().toLowerCase());
  const assetKind = workflowAssetKind(workflow);
  const targetTools = workflowTargetTools(workflow);
  const compatibility = workflowCodexCompatibility(workflow);

  if (target === 'codex') {
    if (targetTools.length > 0 && !targetTools.includes('codex')) return false;
  } else if (target && targetTools.length > 0 && !targetTools.includes(target)) {
    return false;
  }

  if (requestedKinds.length > 0) {
    const kindAliases = new Set([assetKind, `${assetKind}s`, assetKind.replace(/_/g, '-')]);
    const tags = (workflow.tags || []).flatMap(t => [t.slug, t.name]).filter(Boolean).map(normalizeToolName);
    const matchesKind = requestedKinds.some(kind => kindAliases.has(kind) || tags.includes(kind) || tags.includes(`${kind}s`));
    if (!matchesKind) return false;
  }

  if (requestedPolicies.length > 0) {
    const decision = compatibility.policyDecision.decision;
    const aliases = {
      safe: 'allow',
      staged: 'stage_only',
      stage: 'stage_only',
      block: 'deny',
      blocked: 'deny',
    };
    const normalizedPolicies = requestedPolicies.map(policy => aliases[policy] || policy);
    if (!normalizedPolicies.includes(decision)) return false;
  }

  return true;
}

function enrichWorkflowForAgent(workflow) {
  const compatibility = workflowCodexCompatibility(workflow);
  const agentFit = workflow.agent_fit || workflow.agentFit || {
    target: 'codex',
    score: compatibility.score,
    status: compatibility.status,
    policy: compatibility.policyDecision.decision,
    why: compatibility.policyDecision.reasons,
    asset_kind: compatibility.assetKind,
    install_mode: compatibility.installMode,
  };
  return {
    ...workflow,
    assetKind: compatibility.assetKind,
    targetTools: compatibility.targetTools,
    agent_fit: agentFit,
    compatibility: {
      codex: compatibility,
    },
    policyDecision: compatibility.policyDecision,
  };
}

function applyAgentWorkflowFilters(list, flags = {}) {
  const shouldEnrich = flags.target || flags.kind || flags.assetKind || flags.asset_kind || flags.policy;
  const filtered = (list || []).filter(item => workflowMatchesAgentFilters(item, flags));
  return shouldEnrich ? filtered.map(enrichWorkflowForAgent) : filtered;
}

function hasCodexInstallRisks(plan) {
  const decision = decideCodexPolicy(plan).decision;
  return decision === 'confirm' || decision === 'stage_only' || decision === 'deny';
}

function formatRiskLine(file) {
  if (!file.riskFlags || file.riskFlags.length === 0) return '';
  return `${file.sourceName || path.basename(file.path)}: ${file.riskFlags.join(', ')}`;
}

async function confirmCodexInstallRisks(plan, opts = {}) {
  const policy = decideCodexPolicy(plan);
  if (policy.decision === 'deny') {
    throw new Error(`Install policy denied this asset: ${policy.reasons.join('; ')}`);
  }
  if (plan.installMode === 'stage_only') return;
  if (opts.dryRun || opts.stage || policy.decision === 'allow') return;
  if (opts.approveMcp || opts.approve_mcp || opts.yes) return;

  if (opts.json || opts.throwOnError || process.env.TOKREPO_NONINTERACTIVE === '1') {
    throw new Error(`Install policy is ${policy.decision}: ${policy.reasons.join('; ')}. Re-run with --dry-run to inspect, --stage to stage the plan, or --approve-mcp to approve writing the Codex skill bundle.`);
  }

  warn(`Install policy is ${policy.decision}: ${policy.reasons.join('; ')}`);
  log(`  ${C.dim}TokRepo will only write files under ${CODEX_SKILLS_DIR}; it will not merge MCP configs, modify PATH, or execute scripts.${C.reset}`);
  const riskyFiles = plan.files
    .map(formatRiskLine)
    .filter(Boolean)
    .slice(0, 8);
  for (const line of riskyFiles) {
    log(`  ${C.yellow}!${C.reset} ${line}`);
  }
  if (plan.files.length > riskyFiles.length) {
    log(`  ${C.dim}...and ${plan.files.length - riskyFiles.length} more file(s) in the plan${C.reset}`);
  }

  const answer = await ask('Write this Codex skill bundle anyway? (y/N):');
  if (answer.toLowerCase() !== 'y') {
    throw new Error('Install aborted.');
  }
}

function stageCodexInstallPlan(plan) {
  const stagedDir = path.join(CODEX_TOKREPO_DIR, 'staged');
  if (!fs.existsSync(stagedDir)) {
    fs.mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
  }
  const stagePath = path.join(stagedDir, `${plan.uuid}.install-plan.json`);
  fs.writeFileSync(stagePath, `${JSON.stringify(publicInstallPlan(plan), null, 2)}\n`, { mode: 0o600 });
  return stagePath;
}

function executeStageOnlyCodexPlan(plan) {
  const installedFiles = [];
  const stageRoot = path.join(CODEX_TOKREPO_DIR, 'staged', plan.uuid);
  if (!fs.existsSync(stageRoot)) fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });

  for (const file of plan.files) {
    if (!ensureInside(stageRoot, file.path)) {
      throw new Error(`Stage path escaped TokRepo staging directory: ${file.path}`);
    }
    const destDir = path.dirname(file.path);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file.path, file.content, { mode: 0o600 });
    installedFiles.push({
      path: file.path,
      sourceName: file.sourceName,
      sha256: sha256(file.content),
      bytes: Buffer.byteLength(String(file.content || '')),
      riskFlags: file.riskFlags,
    });
  }

  const stagePath = path.join(stageRoot, 'install-plan.json');
  fs.writeFileSync(stagePath, `${JSON.stringify(publicInstallPlan(plan), null, 2)}\n`, { mode: 0o600 });
  return { dryRun: true, staged: true, stageOnly: true, stagePath, plan: publicInstallPlan(plan), installedFiles };
}

function expandHomePath(input) {
  const value = String(input || '');
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveVerifyPath(checkPath, publicPlan) {
  const expanded = expandHomePath(checkPath);
  if (path.isAbsolute(expanded)) return expanded;
  const baseDir = publicPlan.baseDir || path.dirname(publicPlan.files?.[0]?.path || CODEX_SKILLS_DIR);
  return path.join(baseDir, expanded);
}

function runCodexPostVerify(publicPlan, opts = {}) {
  const checks = [];
  let ok = true;
  for (const check of (publicPlan.postVerify || publicPlan.post_verify || [])) {
    if (check.type === 'file_sha256') {
      const filePath = resolveVerifyPath(check.path, publicPlan);
      const exists = fs.existsSync(filePath);
      const actualSha = exists ? currentFileSha(filePath) : '';
      const passed = Boolean(exists && actualSha === check.sha256);
      if (!passed) ok = false;
      checks.push({ ...check, path: filePath, status: passed ? 'pass' : 'fail', actualSha });
    } else if (check.type === 'expected_file') {
      const filePath = resolveVerifyPath(check.path, publicPlan);
      const passed = fs.existsSync(filePath);
      if (!passed) ok = false;
      checks.push({ ...check, path: filePath, status: passed ? 'pass' : 'fail' });
    } else if (check.type === 'command') {
      if (!opts.verifyCommands) {
        checks.push({ ...check, status: 'skipped', message: 'command verification is opt-in; re-run with --verify-commands' });
        continue;
      }
      try {
        const childProcess = require('child_process');
        childProcess.execSync(String(check.command || ''), { stdio: 'pipe', shell: true, timeout: 30000 });
        checks.push({ ...check, status: 'pass' });
      } catch (e) {
        ok = false;
        checks.push({ ...check, status: 'fail', message: e.message });
      }
    } else {
      checks.push({ ...check, status: 'skipped', message: 'unknown verification check type' });
    }
  }
  return { ok, checks };
}

function createCodexSessionId(operation = 'session') {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  const random = crypto.randomBytes(4).toString('hex');
  return `${slugify(operation, 'session')}-${stamp}-${random}`;
}

function writeCodexSession(record) {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  }
  const sessionId = record.sessionId || createCodexSessionId(record.operation || 'session');
  const sessionPath = path.join(CODEX_SESSIONS_DIR, `${sessionId}.json`);
  const payload = {
    schemaVersion: 1,
    sessionId,
    createdAt: new Date().toISOString(),
    cliVersion: CLI_VERSION,
    argv: process.argv.slice(2),
    ...record,
    sessionId,
  };
  fs.writeFileSync(sessionPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { sessionId, sessionPath };
}

function readCodexSessions() {
  try {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];
    return fs.readdirSync(CODEX_SESSIONS_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const sessionPath = path.join(CODEX_SESSIONS_DIR, name);
        try {
          const parsed = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
          return { ...parsed, sessionPath };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  } catch {
    return [];
  }
}

function readCodexManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_MANIFEST_FILE, 'utf8'));
    if (Array.isArray(parsed.installs)) return parsed;
  } catch {}
  return { schemaVersion: 1, installs: [] };
}

function writeCodexManifest(manifest) {
  if (!fs.existsSync(CODEX_TOKREPO_DIR)) {
    fs.mkdirSync(CODEX_TOKREPO_DIR, { recursive: true, mode: 0o700 });
  }
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(CODEX_MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function writeCodexManifestRecord(plan, installedFiles, sessionInfo = {}, verification = null) {
  if (!fs.existsSync(CODEX_TOKREPO_DIR)) {
    fs.mkdirSync(CODEX_TOKREPO_DIR, { recursive: true, mode: 0o700 });
  }
  const manifest = readCodexManifest();
  const installedAt = new Date().toISOString();
  const record = {
    uuid: plan.uuid,
    title: plan.title,
    sourceUrl: plan.sourceUrl,
    targetTool: 'codex',
    installMode: plan.installMode,
    installedAt,
    contentHash: plan.contentHash || '',
    agentMetadata: plan.agentMetadata || {},
    sessionId: sessionInfo.sessionId,
    sessionPath: sessionInfo.sessionPath,
    verification,
    installedFiles: installedFiles.map(file => ({
      path: file.path,
      sourceName: file.sourceName,
      sha256: file.sha256,
      bytes: file.bytes,
      riskFlags: file.riskFlags,
    })),
    risks: plan.risks,
  };
  manifest.installs = manifest.installs.filter(item => !(item.uuid === plan.uuid && item.targetTool === 'codex'));
  manifest.installs.push(record);
  manifest.updatedAt = installedAt;
  writeCodexManifest(manifest);
  return record;
}

function executeCodexInstallPlan(plan, opts = {}) {
  const publicPlan = publicInstallPlan(plan);
  if (opts.dryRun) {
    const session = writeCodexSession({
      operation: 'install',
      status: 'dry_run',
      targetTool: 'codex',
      uuid: plan.uuid,
      title: plan.title,
      sourceUrl: plan.sourceUrl,
      policyDecision: publicPlan.policyDecision,
      plan: publicPlan,
      result: { dryRun: true, installedFiles: [] },
    });
    return { dryRun: true, plan: publicPlan, installedFiles: [], ...session };
  }
  if (plan.installMode === 'stage_only') {
    const result = executeStageOnlyCodexPlan(plan);
    const verification = runCodexPostVerify(result.plan, opts);
    const session = writeCodexSession({
      operation: 'install',
      status: 'stage_only',
      targetTool: 'codex',
      uuid: plan.uuid,
      title: plan.title,
      sourceUrl: plan.sourceUrl,
      policyDecision: result.plan.policyDecision,
      plan: result.plan,
      installedFiles: result.installedFiles,
      verification,
      result: { staged: true, stageOnly: true, stagePath: result.stagePath },
    });
    return { ...result, verification, ...session };
  }
  if (opts.stage) {
    const stagePath = stageCodexInstallPlan(plan);
    const session = writeCodexSession({
      operation: 'install',
      status: 'staged',
      targetTool: 'codex',
      uuid: plan.uuid,
      title: plan.title,
      sourceUrl: plan.sourceUrl,
      policyDecision: publicPlan.policyDecision,
      plan: publicPlan,
      result: { staged: true, stagePath },
    });
    return { dryRun: true, staged: true, stagePath, plan: publicPlan, installedFiles: [], ...session };
  }

  const installedFiles = [];
  for (const file of plan.files) {
    const destDir = path.dirname(file.path);
    if (!ensureInside(CODEX_SKILLS_DIR, file.path)) {
      throw new Error(`Install path escaped Codex skills directory: ${file.path}`);
    }
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(file.path, file.content);
    installedFiles.push({
      path: file.path,
      sourceName: file.sourceName,
      sha256: sha256(file.content),
      bytes: Buffer.byteLength(String(file.content || '')),
      riskFlags: file.riskFlags,
    });
  }

  const verification = runCodexPostVerify(publicPlan, opts);
  const session = writeCodexSession({
    operation: 'install',
    status: 'installed',
    targetTool: 'codex',
    uuid: plan.uuid,
    title: plan.title,
    sourceUrl: plan.sourceUrl,
    policyDecision: publicPlan.policyDecision,
    plan: publicPlan,
    installedFiles,
    verification,
    result: { installedFiles },
  });
  const manifestRecord = writeCodexManifestRecord(plan, installedFiles, session, verification);
  return { dryRun: false, plan: publicPlan, installedFiles, manifestRecord, verification, ...session };
}

async function installCodexAsset(workflow, contents, opts = {}) {
  const plan = buildCodexInstallPlan(workflow, contents, opts);
  await confirmCodexInstallRisks(plan, opts);
  return executeCodexInstallPlan(plan, opts);
}

async function cmdInstall() {
  const args = parseArgs(process.argv);
  const target = args.positional[0];
  if (!target) {
    showInstallHelp();
    process.exit(1);
  }

  if (!args.flags.json) log(`\n${C.bold}tokrepo install${C.reset}\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;
  const installOpts = {
    targetTool: validateInstallTarget(args.flags.target),
    yes: Boolean(args.flags.yes),
    update: Boolean(args.flags.update),
    dryRun: Boolean(args.flags.dryRun || args.flags.dry_run),
    stage: Boolean(args.flags.stage),
    approveMcp: Boolean(args.flags.approveMcp || args.flags.approve_mcp),
    verifyCommands: Boolean(args.flags.verify_commands || args.flags.verifyCommands),
    json: Boolean(args.flags.json),
    manifest: Boolean(args.flags.manifest),
  };

  // pack/<slug> dispatch — install entire theme pack
  if (target.startsWith('pack/')) {
    const slug = target.slice('pack/'.length).trim();
    if (!slug) {
      error('Pack slug is required, e.g. tokrepo install pack/seo-geo');
    }
    await installPack(slug, config, apiBase, installOpts);
    return;
  }

  const result = await installOneAsset(target, config, apiBase, installOpts);
  await trackAgentEvent(result.dryRun ? 'install_dry_run' : 'install_apply', {
    target: result.targetTool || installOpts.targetTool || 'any',
    kind: result.installMode || '',
    result: result.staged ? 'staged' : 'pass',
    dry_run: Boolean(result.dryRun),
    candidate_count: (result.installedFiles || []).length,
  }, apiBase);
  if (args.flags.json) {
    outputJson(result);
  }
}

async function cmdPlan() {
  const args = parseArgs(process.argv);
  const target = args.positional[0];
  if (!target) {
    showPlanHelp();
    process.exit(1);
  }

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;
  const targetTool = validateInstallTarget(args.flags.target || 'codex');
  if (targetTool !== 'codex') {
    error(`plan currently supports --target codex only`);
  }
  const result = await installOneAsset(target, config, apiBase, {
    targetTool,
    dryRun: true,
    stage: Boolean(args.flags.stage),
    installMode: args.flags.installMode,
    json: true,
    manifest: true,
    throwOnError: true,
  });

  await trackAgentEvent('install_plan', {
    target: targetTool,
    kind: result.plan?.installMode || '',
    result: 'pass',
    dry_run: true,
    candidate_count: result.plan?.files?.length || 0,
  }, apiBase);

  outputJson(result.plan);
}

// Install all assets in a theme pack — sequentially, continue past per-item errors
async function installPack(slug, config, apiBase, opts) {
  info(`Fetching pack ${C.bold}${slug}${C.reset}...`);
  let pack;
  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/homepage/packs/${encodeURIComponent(slug)}`, null, config?.token, apiBase);
    pack = data.pack;
  } catch (e) {
    error(`Pack not found: ${slug} (${e.message})`);
  }

  log(`\n  ${C.bold}${pack.icon} ${pack.title}${C.reset}`);
  if (pack.description) log(`  ${C.dim}${pack.description.substring(0, 140)}${C.reset}`);
  log(`  ${C.dim}${pack.items.length} asset(s) in this pack${C.reset}\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < pack.items.length; i++) {
    const it = pack.items[i];
    log(`${C.dim}[${i + 1}/${pack.items.length}]${C.reset}`);
    try {
      await installOneAsset(it.uuid, config, apiBase, { ...(opts || {}), silent: false, throwOnError: true });
      ok++;
    } catch (e) {
      warn(`Skipped "${it.title}": ${e.message}`);
      fail++;
    }
  }

  log('');
  if (fail === 0) {
    success(`${ok} asset(s) installed from pack ${C.bold}${pack.title}${C.reset}`);
  } else {
    log(`  ${C.dim}${ok} ok, ${fail} failed${C.reset}`);
  }
  log(`  ${C.dim}Pack page: https://tokrepo.com/packs/${slug}${C.reset}\n`);
}

// Single asset install — extracted so `pack/` flow can reuse.
// opts.throwOnError: pack flow wants to throw and continue; single-cli flow uses error() (which exits)
async function installOneAsset(target, config, apiBase, opts) {
  opts = opts || {};
  const die = (msg) => { if (opts.throwOnError) throw new Error(msg); error(msg); };
  const emitInfo = (msg) => { if (!opts.json) info(msg); };

  // Resolve target to UUID
  let uuid = target;

  // URL format
  const urlMatch = target.match(/workflows\/([^/?#]+)/);
  if (urlMatch) {
    // URL may carry either UUID or slug-uuid8 — pass through to detail resolver below
    uuid = urlMatch[1];
  }

  // 已经是完整 UUID — 直接用
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) {
    // ok
  }
  // SEO slug 形态：结尾是 -<8 hex>，先尝试 /detail?slug= 直查，避免走 search 超时
  else if (/-[a-f0-9]{8}$/i.test(uuid)) {
    try {
      const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?slug=${encodeURIComponent(uuid)}`, null, config?.token, apiBase);
      if (data && data.workflow && data.workflow.uuid) {
        uuid = data.workflow.uuid;
      }
    } catch (_) {
      // 404 → 回落到 search
    }
  }

  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid)) {
    // Search by name (normalize separators for better matching)
    const normalizedTarget = normalizeQuery(uuid);
    emitInfo(`Searching for "${normalizedTarget}"...`);
    try {
      const encoded = encodeURIComponent(normalizedTarget);
      const searchData = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?keyword=${encoded}&page=1&page_size=5&sort_by=views`, null, config?.token, apiBase);

      if (!searchData.list || searchData.list.length === 0) {
        die(`No asset found matching "${target}". Try: tokrepo search ${target}`);
      }

      // If title contains all query words, prefer it
      const queryWords = normalizedTarget.toLowerCase().split(' ');
      const exact = searchData.list.find(w => {
        const title = w.title.toLowerCase();
        return queryWords.every(word => title.includes(word));
      });
      const chosen = exact || searchData.list[0];

      uuid = chosen.uuid;
      emitInfo(`Found: ${C.bold}${chosen.title}${C.reset}`);
    } catch (e) {
      die(`Search failed: ${e.message}`);
    }
  }

  // Fetch the asset
  emitInfo(`Fetching ${uuid.substring(0, 8)}...`);

  let workflow;
  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${uuid}`, null, config?.token, apiBase);
    workflow = data.workflow;
  } catch (e) {
    die(`Fetch failed: ${e.message}`);
  }

  if (!opts.json) {
    log(`\n  ${C.bold}${workflow.title}${C.reset}`);
    if (workflow.description) log(`  ${C.dim}${workflow.description.substring(0, 100)}${C.reset}`);
  }

  // Determine asset type from tags
  let assetType = getWorkflowAssetType(workflow);

  // Get content — prefer files, fallback to steps
  const contents = extractInstallableContents(workflow, assetType);

  if (contents.length === 0) {
    die('No installable content found in this asset.');
  }

  if (!opts.json) log('');
  const targetTool = normalizeInstallTarget(opts.targetTool);

  if (targetTool === 'codex') {
    let result;
    try {
      const serverPlan = opts.serverPlan !== undefined ? opts.serverPlan : await fetchServerCodexInstallPlan(uuid, config, apiBase);
      result = await installCodexAsset(workflow, contents, { ...opts, serverPlan });
    } catch (e) {
      die(e.message);
    }

    if (!opts.json) {
      const plan = result.plan;
      if (result.staged || opts.stage) {
        info(`Staged install plan: ${result.stagePath}`);
        if (result.stageOnly) {
          info(`stage_only asset: files were written only under ${path.dirname(result.stagePath)}; no Codex skill was activated.`);
        } else {
          info(`No Codex skill files were written. Re-run with --approve-mcp or --yes to install.`);
        }
        if (result.sessionPath) log(`  ${C.dim}Session: ${result.sessionPath}${C.reset}`);
      } else if (opts.dryRun) {
        info(`Dry run: ${plan.files.length} file(s) would be installed to ${CODEX_SKILLS_DIR}`);
        for (const file of plan.files) {
          const rel = path.relative(os.homedir(), file.path);
          log(`  ${C.dim}•${C.reset} ~/${rel}`);
          if (file.riskFlags.length) log(`    ${C.yellow}${file.riskFlags.join(', ')}${C.reset}`);
        }
        if (result.sessionPath) log(`  ${C.dim}Session: ${result.sessionPath}${C.reset}`);
      } else {
        for (const file of result.installedFiles) {
          const relPath = path.relative(os.homedir(), file.path);
          success(`Installed: ~/${relPath}`);
        }
        log('');
        success(`${result.installedFiles.length} file(s) installed from ${C.bold}${workflow.title}${C.reset}`);
        log(`  ${C.dim}Manifest: ${CODEX_MANIFEST_FILE}${C.reset}`);
        if (result.sessionPath) log(`  ${C.dim}Session: ${result.sessionPath}${C.reset}`);
        if (result.verification && !result.verification.ok) log(`  ${C.yellow}Verification: failed${C.reset}`);
        log(`  ${C.dim}Source: https://tokrepo.com/en/workflows/${uuid}${C.reset}\n`);
      }
    }

    return {
      uuid,
      title: workflow.title,
      targetTool: 'codex',
      dryRun: Boolean(opts.dryRun || opts.stage),
      staged: Boolean(result.staged),
      stagePath: result.stagePath,
      installMode: result.plan.installMode,
      installedFiles: result.installedFiles || [],
      plan: result.plan,
      manifestPath: CODEX_MANIFEST_FILE,
      sessionId: result.sessionId,
      sessionPath: result.sessionPath,
      verification: result.verification,
    };
  }

  if (targetTool === 'gemini') {
    const destDir = path.join(process.cwd(), '.gemini');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const destPath = pickWritablePath(path.join(destDir, 'GEMINI.md'), Boolean(opts.yes));
    const resolvedDir = path.resolve(destDir);
    const resolvedDest = path.resolve(destPath);
    if (!resolvedDest.startsWith(resolvedDir + path.sep) && resolvedDest !== resolvedDir) {
      die('Install path escaped .gemini directory.');
    }
    fs.writeFileSync(destPath, formatGeminiContent(workflow, contents));
    const relPath = path.relative(process.cwd(), destPath);
    success(`Installed: ${relPath}`);
    if (path.basename(destPath) !== 'GEMINI.md') {
      warn('Gemini CLI automatically reads GEMINI.md. Merge this file if you want it loaded by default.');
    }
    log('');
    success(`1 file installed from ${C.bold}${workflow.title}${C.reset}`);
    log(`  ${C.dim}Source: https://tokrepo.com/en/workflows/${uuid}${C.reset}\n`);
    return {
      uuid,
      title: workflow.title,
      targetTool: 'gemini',
      installedFiles: [{ path: destPath }],
      sourceUrl: `https://tokrepo.com/en/workflows/${uuid}`,
    };
  }

  // Smart install based on asset type
  let installed = 0;

  for (const item of contents) {
    let destDir = process.cwd();
    let fileName = item.name;

    // Ensure file has extension
    if (!path.extname(fileName)) fileName += '.md';

    switch (assetType) {
      case 'skills':
      case 'skill': {
        // Install to .claude/skills/ if it exists, otherwise current dir
        const claudeSkillsDir = path.join(process.cwd(), '.claude', 'skills');
        if (fs.existsSync(path.join(process.cwd(), '.claude'))) {
          if (!fs.existsSync(claudeSkillsDir)) {
            fs.mkdirSync(claudeSkillsDir, { recursive: true });
          }
          destDir = claudeSkillsDir;
        }
        break;
      }
      case 'mcp':
      case 'mcp configs': {
        // Save as mcp config, hint about manual merge
        if (!fileName.endsWith('.json')) fileName = fileName.replace(/\.md$/, '.json');
        break;
      }
      case 'configs':
      case 'config': {
        // Save to project root
        break;
      }
      case 'scripts':
      case 'script': {
        // Save and make executable
        if (!path.extname(fileName) || fileName.endsWith('.md')) {
          // Detect language from content
          if (item.content.startsWith('#!/usr/bin/env python') || item.content.includes('import ')) {
            fileName = fileName.replace(/\.md$/, '.py');
          } else if (item.content.startsWith('#!/bin/bash') || item.content.startsWith('#!/bin/sh')) {
            fileName = fileName.replace(/\.md$/, '.sh');
          }
        }
        break;
      }
      case 'prompts':
      case 'prompt': {
        // Save as markdown
        if (!fileName.endsWith('.md') && !fileName.endsWith('.prompt')) fileName += '.md';
        break;
      }
    }

    let destPath = path.join(destDir, fileName);

    // Path traversal guard: ensure resolved path stays inside destDir
    if (!path.resolve(destPath).startsWith(path.resolve(destDir) + path.sep) && path.resolve(destPath) !== path.resolve(destDir)) {
      warn(`Skipping "${fileName}" — path traversal detected`);
      continue;
    }

    destPath = pickWritablePath(destPath, Boolean(opts.yes));

    fs.writeFileSync(destPath, item.content);

    // Make scripts executable
    if (assetType === 'script' || assetType === 'scripts') {
      try { fs.chmodSync(destPath, 0o755); } catch {}
    }

    const relPath = path.relative(process.cwd(), destPath);
    success(`Installed: ${relPath}`);
    installed++;
  }

  log('');
  success(`${installed} file(s) installed from ${C.bold}${workflow.title}${C.reset}`);
  log(`  ${C.dim}Source: https://tokrepo.com/en/workflows/${uuid}${C.reset}\n`);
  return {
    uuid,
    title: workflow.title,
    targetTool: targetTool || 'project',
    installed,
    sourceUrl: `https://tokrepo.com/en/workflows/${uuid}`,
  };
}

async function cmdWhoami() {
  const config = readConfig();
  if (!config || !config.token) error('Not logged in. Run: tokrepo login');

  try {
    const data = await fetchCurrentUser(config);
    log(`\n${C.bold}Logged in as:${C.reset}`);
    log(`  ${C.bold}Name:${C.reset}  ${data.nickname}`);
    log(`  ${C.bold}Email:${C.reset} ${data.email}`);
    log(`  ${C.bold}UUID:${C.reset}  ${data.uuid}`);
    log(`  ${C.bold}API:${C.reset}   ${config.api}\n`);
  } catch (e) {
    error(`Auth failed: ${e.message}`);
  }
}

async function cmdList() {
  const args = parseArgs(process.argv);
  if (!args.flags.json) log(`\n${C.bold}tokrepo list${C.reset}\n`);

  const config = readConfig();
  if (!config || !config.token) error('Not logged in. Run: tokrepo login');

  try {
    const pageSize = Number(args.flags.pageSize || (args.flags.all ? 200 : 50)) || 50;
    let page = Number(args.flags.page || 1) || 1;
    let data = await apiRequest('GET', `/api/v1/tokenboard/workflows/my?page=${page}&page_size=${pageSize}`, null, config.token, config.api);

    if (args.flags.all) {
      const list = [...(data.list || [])];
      while (list.length < (data.total || 0)) {
        page++;
        const next = await apiRequest('GET', `/api/v1/tokenboard/workflows/my?page=${page}&page_size=${pageSize}`, null, config.token, config.api);
        const items = next.list || [];
        if (items.length === 0) break;
        list.push(...items);
      }
      data = { ...data, list };
    }

    const originalCount = (data.list || []).length;
    data = { ...data, list: applyAgentWorkflowFilters(data.list || [], args.flags) };
    const filters = {
      target: args.flags.target || undefined,
      kind: args.flags.kind || args.flags.assetKind || undefined,
      policy: args.flags.policy || undefined,
    };

    if (args.flags.json) {
      outputJson({ total: data.total || 0, fetched: originalCount, count: (data.list || []).length, filters, list: data.list || [] });
      return;
    }

    if (!data.list || data.list.length === 0) {
      info('No assets found. Run: tokrepo push');
      return;
    }

    const filterText = [filters.target ? `target=${filters.target}` : '', filters.kind ? `kind=${filters.kind}` : '', filters.policy ? `policy=${filters.policy}` : ''].filter(Boolean).join(' · ');
    log(`  ${C.bold}${data.list.length}${C.reset} assets${filterText ? ` ${C.dim}(${filterText})${C.reset}` : ''}${data.total ? ` ${C.dim}from ${data.total}${C.reset}` : ''}:\n`);

    for (const wf of data.list) {
      const views = wf.view_count || 0;
      log(`  ${C.cyan}${wf.uuid.substring(0,8)}${C.reset}  ${C.bold}${wf.title}${C.reset}`);
      if (wf.compatibility?.codex) {
        const c = wf.compatibility.codex;
        log(`  ${C.dim}         codex=${c.status} · policy=${c.policyDecision.decision} · kind=${c.assetKind || 'unknown'}${C.reset}`);
      }
      log(`  ${C.dim}         ${views} views · https://tokrepo.com/en/workflows/${wf.uuid}${C.reset}\n`);
    }
  } catch (e) {
    error(`Failed: ${e.message}`);
  }
}

async function cmdUpdate() {
  const args = parseArgs(process.argv);
  if (args.flags.target || args.flags.all || args.flags.force) {
    await cmdSyncInstalled();
    return;
  }

  const uuid = process.argv[3];
  if (!uuid) error('Usage: tokrepo update <uuid> [file]');

  log(`\n${C.bold}tokrepo update${C.reset}\n`);

  const config = readConfig();
  if (!config || !config.token) error('Not logged in. Run: tokrepo login');

  const filePath = process.argv[4];
  let body = { uuid };

  if (filePath) {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) error(`File not found: ${filePath}`);

    const content = fs.readFileSync(fullPath, 'utf8');
    body.steps = [{
      id: 0,
      step_order: 1,
      title: body.title || path.basename(filePath),
      description: '',
      prompt_template: content,
      variables: '{}',
      depends_on: '',
      expected_output: '',
    }];
  }

  info(`Updating ${uuid.substring(0,8)}...`);

  try {
    await apiRequest('PUT', '/api/v1/tokenboard/workflows/update', body, config.token, config.api);
    success('Updated!');
    log(`  ${C.dim}https://tokrepo.com/en/workflows/${uuid}${C.reset}\n`);
  } catch (e) {
    error(`Update failed: ${e.message}`);
  }
}

async function cmdDelete() {
  const args = parseArgs(process.argv);
  const uuid = args.positional[0];
  if (!uuid) error('Usage: tokrepo delete <uuid> [--yes]');

  log(`\n${C.bold}tokrepo delete${C.reset}\n`);

  const config = readConfig();
  if (!config || !config.token) error('Not logged in. Run: tokrepo login');

  // --yes / -y / TOKREPO_NONINTERACTIVE 跳过交互式确认（脚本/CI 友好）。
  // 没有这两个的话仍然要 y/N 防误删。
  const skipConfirm = Boolean(args.flags.yes) || Boolean(args.flags.y) || process.env.TOKREPO_NONINTERACTIVE === '1';
  if (!skipConfirm) {
    const confirm = await ask(`Delete ${uuid.substring(0,8)}...? (y/N):`);
    if (confirm.toLowerCase() !== 'y') { log('Aborted.'); return; }
  }

  try {
    await apiRequest('DELETE', '/api/v1/tokenboard/workflows/delete', { uuid }, config.token, config.api);
    success('Deleted!');
  } catch (e) {
    error(`Delete failed: ${e.message}`);
  }
}

function tagMatchesTypes(workflow, requestedTypes) {
  if (!requestedTypes || requestedTypes.length === 0) return true;
  const tags = (workflow.tags || []).flatMap(t => [t.slug, t.name]).filter(Boolean).map(t => String(t).toLowerCase());
  const assetType = getWorkflowAssetType(workflow);
  const metadataKind = String(workflow.asset_kind || workflow.agent_metadata?.asset_kind || workflow.agentMetadata?.assetKind || '').toLowerCase();
  return requestedTypes.some(type => {
    const needle = String(type).trim().toLowerCase();
    if (!needle) return false;
    if (metadataKind === needle || metadataKind === `${needle}s`) return true;
    if (assetType === needle || assetType === `${needle}s`) return true;
    return tags.some(tag => tag === needle || tag === `${needle}s` || tag.includes(needle));
  });
}

function itemMatchesKeyword(workflow, keyword) {
  if (!keyword) return true;
  const needle = normalizeQuery(keyword).toLowerCase();
  const fields = [
    workflow.title,
    workflow.slug,
    workflow.description,
    ...(workflow.tags || []).flatMap(t => [t.name, t.slug]),
  ].filter(Boolean).join(' ').toLowerCase();
  return needle.split(/\s+/).every(word => fields.includes(word));
}

async function fetchCloneItems(username, config, apiBase, args) {
  const pageSize = Number(args.flags.pageSize || 200) || 200;
  const keyword = args.flags.keyword || '';
  const requestedTypes = String(args.flags.types || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let effectiveUsername = username.startsWith('@') ? username.slice(1) : username;
  const result = { username: effectiveUsername, source: 'public', list: [], total: 0 };

  let cloneSelf = effectiveUsername === 'me';
  if (config?.token) {
    try {
      const me = await apiRequest('GET', '/api/v1/tokenboard/auth/me', null, config.token, apiBase);
      if (effectiveUsername === 'me' || me.nickname?.toLowerCase() === effectiveUsername.toLowerCase()) {
        cloneSelf = true;
        effectiveUsername = me.nickname || effectiveUsername;
        result.username = effectiveUsername;
      }
    } catch { /* anonymous/public clone still works */ }
  }

  if (cloneSelf) {
    if (!config?.token) error('Cloning @me requires login or TOKREPO_TOKEN.');
    let page = 1;
    while (true) {
      const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/my?page=${page}&page_size=${pageSize}`, null, config.token, apiBase);
      const items = data.list || [];
      result.total = data.total || result.total;
      result.list.push(...items);
      if (items.length < pageSize || result.list.length >= result.total) break;
      page++;
    }
    result.source = 'my';
  } else {
    let page = 1;
    while (true) {
      const params = [
        `author_name=${encodeURIComponent(effectiveUsername)}`,
        `page=${page}`,
        `page_size=${pageSize}`,
        'sort_by=latest',
      ];
      if (keyword) params.push(`keyword=${encodeURIComponent(normalizeQuery(keyword))}`);
      const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?${params.join('&')}`, null, config?.token, apiBase);
      const items = data.list || data.items || [];
      result.total = data.total || result.total;
      result.list.push(...items);
      if (items.length < pageSize || result.list.length >= result.total) break;
      page++;
    }
  }

  result.list = result.list.filter(item => itemMatchesKeyword(item, keyword) && tagMatchesTypes(item, requestedTypes));
  result.count = result.list.length;
  result.keyword = keyword || undefined;
  result.types = requestedTypes;
  return result;
}

async function cmdClone() {
  const args = parseArgs(process.argv);
  const target = args.positional[0];
  if (!target) {
    showCloneHelp();
    process.exit(1);
  }

  const json = Boolean(args.flags.json);
  if (!json) log(`\n${C.bold}tokrepo clone${C.reset}\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;
  const targetTool = validateInstallTarget(args.flags.target);
  const dryRun = Boolean(args.flags.dryRun || args.flags.dry_run);

  try {
    if (!json) info(`Fetching assets from ${target}...`);
    const cloneItems = await fetchCloneItems(target, config, apiBase, args);

    if (cloneItems.list.length === 0) {
      if (json) {
        outputJson({ target, count: 0, list: [] });
      } else {
        info(`${target} has no matching assets.`);
      }
      return;
    }

    if (!json) log(`  Found ${C.bold}${cloneItems.list.length}${C.reset} matching asset(s)\n`);

    if (targetTool === 'codex') {
      const results = [];
      let installedCount = 0;
      for (let i = 0; i < cloneItems.list.length; i++) {
        const item = cloneItems.list[i];
        if (!json) log(`${C.dim}[${i + 1}/${cloneItems.list.length}]${C.reset} ${item.title}`);
        try {
          const detail = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${item.uuid}`, null, config?.token, apiBase);
          const workflow = detail.workflow;
          const assetType = getWorkflowAssetType(workflow);
          const contents = extractInstallableContents(workflow, assetType);
          if (contents.length === 0) throw new Error('No installable content found');
          const serverPlan = await fetchServerCodexInstallPlan(workflow.uuid, config, apiBase);
          const result = await installCodexAsset(workflow, contents, {
            ...args.flags,
            dryRun,
            stage: Boolean(args.flags.stage),
            approveMcp: Boolean(args.flags.approveMcp || args.flags.approve_mcp),
            verifyCommands: Boolean(args.flags.verify_commands || args.flags.verifyCommands),
            json: true,
            throwOnError: true,
            serverPlan,
          });
          if (!dryRun) installedCount += result.installedFiles.length;
          results.push({
            uuid: workflow.uuid,
            title: workflow.title,
            dryRun: Boolean(dryRun || args.flags.stage),
            staged: Boolean(result.staged),
            stagePath: result.stagePath,
            installMode: result.plan.installMode,
            files: result.plan.files,
            installedFiles: result.installedFiles || [],
            risks: result.plan.risks,
            sessionId: result.sessionId,
            sessionPath: result.sessionPath,
            verification: result.verification,
          });
          if (!json) {
            const fileCount = (dryRun || args.flags.stage) ? result.plan.files.length : result.installedFiles.length;
            success(`${args.flags.stage ? 'Staged' : dryRun ? 'Planned' : 'Installed'} ${fileCount} file(s)`);
          }
        } catch (e) {
          results.push({ uuid: item.uuid, title: item.title, error: e.message });
          if (!json) warn(`Skipped "${item.title}": ${e.message}`);
        }
      }

      const response = {
        target,
        username: cloneItems.username,
        targetTool: 'codex',
        dryRun,
        total: cloneItems.total,
        count: cloneItems.count,
        manifestPath: CODEX_MANIFEST_FILE,
        results,
      };
    if (json) {
        outputJson(response);
      } else {
        log('');
        if (args.flags.stage) {
          success(`Staged ${results.filter(r => !r.error).length}/${cloneItems.list.length} asset install plan(s)`);
        } else if (dryRun) {
          success(`Dry run complete: ${results.filter(r => !r.error).length}/${cloneItems.list.length} assets planned`);
        } else {
          success(`Installed ${installedCount} Codex file(s) from ${results.filter(r => !r.error).length}/${cloneItems.list.length} assets`);
          log(`  ${C.dim}Manifest: ${CODEX_MANIFEST_FILE}${C.reset}\n`);
        }
      }
      return;
    }

    if (targetTool && targetTool !== 'codex') {
      error(`clone --target ${targetTool} is not implemented yet. Supported clone target: codex`);
    }

    if (json) {
      outputJson(cloneItems);
      return;
    }

    // Legacy raw clone behavior for users who do not specify a target.
    const outDir = path.join(process.cwd(), cloneItems.username);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let downloaded = 0;
    for (const item of cloneItems.list) {
      const title = item.title || item.uuid;
      const safeDirName = title.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 80);
      const assetDir = path.join(outDir, safeDirName);

      try {
        const detail = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${item.uuid}`, null, config?.token, apiBase);
        const workflow = detail.workflow;
        const contents = extractInstallableContents(workflow, getWorkflowAssetType(workflow));

        if (contents.length > 0) {
          if (!fs.existsSync(assetDir)) fs.mkdirSync(assetDir, { recursive: true });
          for (const contentItem of contents) {
            const safeName = sanitizeRelativePath(contentItem.name || 'content.md');
            fs.writeFileSync(path.join(assetDir, safeName), contentItem.content);
          }
          downloaded++;
          log(`  ${C.green}✓${C.reset} ${safeDirName} ${C.dim}(${contents.length} files)${C.reset}`);
        }
      } catch (e) {
        log(`  ${C.yellow}!${C.reset} ${safeDirName} ${C.dim}(skipped: ${e.message})${C.reset}`);
      }
    }

    log('');
    success(`Cloned ${downloaded}/${cloneItems.list.length} assets to ./${cloneItems.username}/`);
  } catch (e) {
    error(`Clone failed: ${e.message}`);
  }
}

function currentFileSha(filePath) {
  try {
    return sha256(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return '';
  }
}

function diffCodexPlanWithLocal(plan, manifestRecord = {}) {
  const reasons = [];
  const desired = new Map(plan.files.map(file => [file.path, file.sha256]));
  const recordedFiles = manifestRecord.installedFiles || manifestRecord.installed_files || [];

  for (const file of plan.files) {
    if (!fs.existsSync(file.path)) {
      reasons.push({ type: 'missing', path: file.path });
      continue;
    }
    const actualSha = currentFileSha(file.path);
    if (actualSha !== file.sha256) {
      reasons.push({ type: 'changed', path: file.path, actualSha, expectedSha: file.sha256 });
    }
  }

  for (const file of recordedFiles) {
    if (file.path && !desired.has(file.path)) {
      reasons.push({ type: 'obsolete-manifest-path', path: file.path });
    }
  }

  return {
    needsUpdate: reasons.length > 0,
    reasons,
  };
}

function buildObsoleteCodexFileActions(record, plan, opts = {}) {
  const desired = new Set((plan.files || []).map(file => path.resolve(expandHomePath(file.path))));
  const recordedFiles = record.installedFiles || record.installed_files || [];
  return recordedFiles
    .filter(file => file.path && !desired.has(path.resolve(expandHomePath(file.path))))
    .map(file => {
      const filePath = path.resolve(expandHomePath(file.path));
      const exists = fs.existsSync(filePath);
      const expectedSha = file.sha256 || '';
      const actualSha = exists ? currentFileSha(filePath) : '';
      const changed = Boolean(exists && expectedSha && actualSha !== expectedSha);
      const managed = isCodexManagedPath(filePath);
      const allowed = managed && (!changed || opts.force);
      const reason = !managed ? 'outside-managed-roots'
        : changed && !opts.force ? 'local-changes'
        : exists ? 'obsolete'
        : 'already-missing';
      return {
        type: 'remove_file',
        path: filePath,
        sourceName: file.sourceName || file.source_name,
        expectedSha,
        actualSha,
        exists,
        changed,
        allowed,
        reason,
      };
    });
}

function assertObsoleteCodexFilesRemovable(actions) {
  const blocked = actions.filter(action => !action.allowed);
  if (blocked.length > 0) {
    const first = blocked[0];
    throw new Error(`Refusing to update because obsolete file cannot be removed: ${first.path} (${first.reason}). Use --force only if you want to remove local changes.`);
  }
}

function removeObsoleteCodexFiles(actions) {
  const removed = [];
  const skipped = [];
  for (const action of actions) {
    if (!action.exists) {
      skipped.push({ path: action.path, reason: 'already-missing' });
      continue;
    }
    fs.unlinkSync(action.path);
    removed.push({ path: action.path, sha256: action.actualSha || action.expectedSha, reason: action.reason });
    removeEmptyCodexDirs(path.dirname(action.path));
  }
  return { removed, skipped };
}

async function fetchWorkflowForInstall(uuid, config, apiBase) {
  const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${encodeURIComponent(uuid)}`, null, config?.token, apiBase);
  const workflow = data.workflow;
  const contents = extractInstallableContents(workflow, getWorkflowAssetType(workflow));
  if (contents.length === 0) {
    throw new Error('No installable content found');
  }
  return { workflow, contents };
}

async function fetchServerCodexInstallPlan(uuid, config, apiBase) {
  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/install-plan?uuid=${encodeURIComponent(uuid)}&target=codex`, null, config?.token, apiBase);
    return data?.plan || data || null;
  } catch {
    return null;
  }
}

function runSelfCliJson(cliArgs, opts = {}) {
  const childProcess = require('child_process');
  const stdout = childProcess.execFileSync(process.execPath, [__filename, ...cliArgs], {
    env: { ...process.env, ...(opts.env || {}), TOKREPO_NONINTERACTIVE: '1', TOKREPO_TELEMETRY: '0' },
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function makeEvalResult(name, ok, details = {}) {
  return {
    name,
    ok: Boolean(ok),
    status: ok ? 'pass' : 'fail',
    ...details,
  };
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function offlineEvalFixtureWorkflow() {
  const skillContent = `---\nname: tokrepo-eval-contract-skill\ndescription: \"Offline fixture for TokRepo agent contract and lifecycle verification.\"\n---\n\n# TokRepo Eval Contract Skill\n\nUse this fixture to verify Codex install contracts without network access.\n`;
  const uuid = '00000000-0000-4000-8000-000000000001';
  return {
    workflow: {
      uuid,
      slug: 'tokrepo-eval-contract-skill-00000000',
      title: 'TokRepo Eval Contract Skill',
      description: 'Offline fixture for TokRepo agent contract and lifecycle verification.',
      content_hash: sha256(`SKILL.md\0${skillContent}\0`),
      agent_metadata: {
        asset_kind: 'skill',
        target_tools: ['codex'],
        install_mode: 'single',
        entrypoint: 'SKILL.md',
        risk_profile: {
          executes_code: false,
          modifies_global_config: false,
          requires_secrets: [],
          uses_absolute_paths: false,
          network_access: false,
        },
        dependencies: { npm: [], pip: [], brew: [], system: [] },
        content_hash: sha256(`SKILL.md\0${skillContent}\0`),
        verification: { commands: [], expected_files: ['SKILL.md'] },
      },
      trust: {
        author_trust_level: 'verified',
        verified_publisher: true,
        asset_signed_hash: sha256(skillContent),
        signature_status: 'hash_only',
        install_count: 1,
        report_count: 0,
        dangerous_capability_badges: [],
        review_status: 'reviewed',
      },
    },
    contents: [{ name: 'SKILL.md', type: 'skill', content: skillContent }],
  };
}

function runOfflineAgentFixtureEval() {
  const { workflow, contents } = offlineEvalFixtureWorkflow();
  const plan = buildCodexInstallPlan(workflow, contents);
  const publicPlan = publicInstallPlan(plan);
  const checks = [];
  const check = (name, condition, details = {}) => {
    checks.push({ name, ok: Boolean(condition), status: condition ? 'pass' : 'fail', ...details });
    if (!condition) throw new Error(`offline fixture check failed: ${name}`);
  };

  check('canonical_install_plan_shape', publicPlan.schema_version === 2
    && publicPlan.target === 'codex'
    && publicPlan.asset_uuid === workflow.uuid
    && publicPlan.install_mode === 'single'
    && publicPlan.policy_decision?.decision === 'allow'
    && Array.isArray(publicPlan.actions)
    && Array.isArray(publicPlan.rollback)
    && Array.isArray(publicPlan.post_verify), {
    policy: publicPlan.policy_decision?.decision,
    actionCount: publicPlan.actions.length,
  });

  const install = executeCodexInstallPlan(plan, { dryRun: false, json: true });
  check('install_writes_manifest_and_session', Boolean(install.sessionId && install.manifestRecord && install.installedFiles?.length), {
    sessionId: install.sessionId,
    installedFiles: install.installedFiles?.length || 0,
  });
  check('install_verification_passes', install.verification?.ok === true, {
    checks: install.verification?.checks?.length || 0,
  });

  const installedRecord = findCodexManifestRecord(workflow.uuid);
  check('installed_state_recorded', Boolean(installedRecord), {
    manifestPath: CODEX_MANIFEST_FILE,
  });

  const installedFile = install.installedFiles[0]?.path;
  fs.appendFileSync(installedFile, '\nLocal edit from offline eval.\n');
  const changedPlan = buildCodexRemovalPlan(installedRecord, installedRecord.installedFiles, { operation: 'uninstall', dryRun: true });
  check('local_change_blocks_removal_without_force', changedPlan.actions.some(action => action.changed && !action.allowed), {
    changedFiles: changedPlan.actions.filter(action => action.changed).length,
  });

  const forcedPlan = buildCodexRemovalPlan(installedRecord, installedRecord.installedFiles, { operation: 'uninstall', dryRun: false, force: true });
  const uninstall = executeCodexRemovalPlan(forcedPlan, { force: true });
  check('uninstall_removes_manifest_record', !findCodexManifestRecord(workflow.uuid), {
    removedFiles: uninstall.removedFiles?.length || 0,
  });

  const reinstall = executeCodexInstallPlan(plan, { dryRun: false, json: true });
  const rollbackSession = findRollbackSession(reinstall.sessionId);
  const rollbackPlan = buildCodexRemovalPlan(rollbackSession, filesFromRollbackSession(rollbackSession), { operation: 'rollback', dryRun: false });
  const rollback = executeCodexRemovalPlan(rollbackPlan, { removeManifest: true });
  check('rollback_removes_latest_install', !findCodexManifestRecord(workflow.uuid) && rollback.removedFiles?.length > 0, {
    rollbackSessionId: reinstall.sessionId,
    removedFiles: rollback.removedFiles?.length || 0,
  });

  return {
    schemaVersion: 1,
    status: 'pass',
    targetTool: 'codex',
    fixtureUuid: workflow.uuid,
    checks,
  };
}

async function cmdEvalAgent() {
  const args = parseArgs(process.argv);
  const json = Boolean(args.flags.json);
  const offline = Boolean(args.flags.offline);
  const sampleUuid = args.flags.uuid || '91aeb22d-eff0-4310-abc6-811d2394b420';
  const query = args.flags.keyword || args.flags.query || 'video';
  const keepTemp = Boolean(args.flags.keep_temp || args.flags.keepTemp);
  const startedAt = new Date().toISOString();
  const results = [];
  const tempRoots = [];

  if (!json) log(`\n${C.bold}tokrepo eval-agent${C.reset}\n`);

  const runScenario = async (name, fn) => {
    const start = Date.now();
    try {
      const details = await fn();
      const result = makeEvalResult(name, true, { durationMs: Date.now() - start, ...details });
      results.push(result);
      if (!json) success(`${name} (${result.durationMs}ms)`);
    } catch (e) {
      const result = makeEvalResult(name, false, { durationMs: Date.now() - start, error: e.message });
      results.push(result);
      if (!json) warn(`${name}: ${e.message}`);
    }
  };

  if (offline) {
    await runScenario('offline_contract_and_lifecycle_fixture', async () => {
      const tmpHome = createTempDir('tokrepo-eval-offline-home');
      tempRoots.push(tmpHome);
      return runSelfCliJson(['eval-agent-fixture', '--json'], { env: { HOME: tmpHome, TOKREPO_EVAL_FIXTURE: '1' } });
    });

    await runScenario('agent_memory_bootstrap_fixture', async () => {
      const tmpProject = createTempDir('tokrepo-eval-agent-project');
      tempRoots.push(tmpProject);
      const init = runSelfCliJson(['init-agent', '--target', 'all', '--json'], { cwd: tmpProject });
      const required = [
        'AGENTS.md',
        'CLAUDE.md',
        'GEMINI.md',
        '.cursor/rules/tokrepo.mdc',
        '.github/copilot-instructions.md',
        '.github/instructions/tokrepo.instructions.md',
        '.clinerules/tokrepo.md',
        '.windsurf/rules/tokrepo.md',
        '.roo/rules/tokrepo.md',
        '.openhands/microagents/repo.md',
        'CONVENTIONS.md',
        '.mcp.json',
      ];
      for (const relPath of required) {
        const fullPath = path.join(tmpProject, relPath);
        if (!fs.existsSync(fullPath)) throw new Error(`missing ${relPath}`);
        const body = fs.readFileSync(fullPath, 'utf8');
        if (relPath !== '.mcp.json' && !body.includes('tokrepo_discover')) throw new Error(`${relPath} missing tokrepo_discover`);
      }
      return { operations: init.operations?.length || 0, files: required };
    });

    await runScenario('agent_planning_precheck_fixture', async () => {
      const check = runSelfCliJson(['agent-check', 'write SEO content for product pages', '--offline', '--json']);
      if (check.schemaVersion !== 1) throw new Error('agent-check missing schemaVersion');
      if (check.mcp_tool_call?.tool !== 'tokrepo_discover') throw new Error('agent-check missing tokrepo_discover MCP call');
      if (!check.fallback_commands?.some(command => command.includes('tokrepo search'))) throw new Error('agent-check missing fallback search command');
      return { flowSteps: check.recommended_flow?.length || 0, fallbackCommands: check.fallback_commands?.length || 0 };
    });

    await runScenario('agent_post_task_handoff_fixture', async () => {
      const tmpProject = createTempDir('tokrepo-eval-handoff');
      tempRoots.push(tmpProject);
      fs.mkdirSync(path.join(tmpProject, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(tmpProject, 'SKILL.md'), `---\nname: reusable-eval-skill\ndescription: Reusable eval skill for TokRepo handoff.\n---\n\n# Reusable Eval Skill\n\nUse this with agents.\n`);
      fs.writeFileSync(path.join(tmpProject, 'scripts', 'check.sh'), '#!/usr/bin/env bash\necho ok\n');
      const handoff = runSelfCliJson(['agent-handoff', '--json'], { cwd: tmpProject });
      if (!handoff.candidates?.some(candidate => candidate.path === 'SKILL.md')) throw new Error('handoff did not detect SKILL.md');
      if (!handoff.post_task_contract?.some(rule => rule.includes('Do not publish automatically'))) throw new Error('handoff missing safety contract');
      return { candidates: handoff.candidates.length };
    });
  } else {
  await runScenario('search_filters_codex_allow_skill', async () => {
    const data = runSelfCliJson(['search', query, '--target', 'codex', '--kind', 'skill', '--policy', 'allow', '--json', '--page-size', '10']);
    if (!data.count || !Array.isArray(data.list)) throw new Error('filtered search returned no list');
    const bad = data.list.find(item => {
      const policy = item.agent_fit?.policy || item.policyDecision?.decision;
      return policy && policy !== 'allow';
    });
    if (bad) throw new Error(`search returned non-allow asset ${bad.uuid}`);
    const firstFit = data.list[0]?.agent_fit || data.list[0]?.agentFit;
    if (!firstFit?.score && firstFit?.score !== 0) throw new Error('search result missing agent_fit.score');
    if (firstFit.policy !== 'allow') throw new Error(`first result policy is ${firstFit.policy}`);
    return { count: data.count, firstUuid: data.list[0]?.uuid, firstTitle: data.list[0]?.title, firstAgentFitScore: firstFit.score };
  });

  await runScenario('install_plan_contract', async () => {
    const plan = runSelfCliJson(['plan', sampleUuid, '--target', 'codex']);
    if (plan.schema_version !== 2) throw new Error(`expected schema_version 2, got ${plan.schema_version}`);
    if (plan.schemaVersion !== 2) throw new Error(`expected schemaVersion compatibility alias 2, got ${plan.schemaVersion}`);
    if (plan.target !== 'codex') throw new Error(`expected target codex, got ${plan.target}`);
    if (!plan.asset_uuid) throw new Error('missing canonical asset_uuid');
    if (!plan.install_mode) throw new Error('missing canonical install_mode');
    if (!plan.policy_decision?.decision) throw new Error('missing canonical policy_decision');
    if (!plan.policyDecision?.decision) throw new Error('missing policyDecision compatibility alias');
    if (!Array.isArray(plan.actions) || plan.actions.length === 0) throw new Error('missing actions');
    if (!Array.isArray(plan.rollback) || plan.rollback.length === 0) throw new Error('missing rollback');
    if (!Array.isArray(plan.post_verify) || plan.post_verify.length === 0) throw new Error('missing canonical post_verify');
    if (!Array.isArray(plan.postVerify) || plan.postVerify.length === 0) throw new Error('missing postVerify compatibility alias');
    return {
      sourceOfTruth: plan.sourceOfTruth,
      concretePlanSource: plan.concretePlanSource,
      policy: plan.policy_decision.decision,
      actions: plan.actions.length,
    };
  });

  await runScenario('metadata_quality_report_non_blocking', async () => {
    const tmp = createTempDir('tokrepo-eval-quality');
    tempRoots.push(tmp);
    const skillPath = path.join(tmp, 'SKILL.md');
    fs.writeFileSync(skillPath, `---\nname: eval-agent-sample\ndescription: \"Sample skill used by tokrepo eval-agent.\"\n---\n\n# Eval Agent Sample\n\nUse this to test metadata quality reporting.\n`);
    const report = runSelfCliJson(['push', skillPath, '--metadata-report', '--json', '--kind', 'skill', '--target', 'codex', '--install-mode', 'single', '--entrypoint', 'SKILL.md']);
    if (!report.metadataQuality) throw new Error('missing metadataQuality');
    if (report.metadataQuality.status !== 'pass') throw new Error(`expected pass, got ${report.metadataQuality.status}`);
    return { score: report.metadataQuality.score, status: report.metadataQuality.status };
  });

  await runScenario('codex_install_verify_and_rollback', async () => {
    const tmpHome = createTempDir('tokrepo-eval-home');
    tempRoots.push(tmpHome);
    const env = { HOME: tmpHome };
    const install = runSelfCliJson(['install', sampleUuid, '--target', 'codex', '--yes', '--json'], { env });
    if (!install.sessionId) throw new Error('install did not create sessionId');
    if (!install.verification?.ok) throw new Error('install verification failed');
    if (!install.installedFiles?.length) throw new Error('no files installed');
    const installed = runSelfCliJson(['installed', '--target', 'codex', '--json'], { env });
    if (installed.count < 1) throw new Error('installed manifest did not record asset');
    const rollback = runSelfCliJson(['rollback', '--last', '--target', 'codex', '--json'], { env });
    if (!rollback.removedFiles?.length) throw new Error('rollback removed no files');
    const after = runSelfCliJson(['installed', '--target', 'codex', '--json'], { env });
    if (after.count !== 0) throw new Error(`manifest still has ${after.count} install(s) after rollback`);
    return {
      installedFiles: install.installedFiles.length,
      sessionId: install.sessionId,
      removedFiles: rollback.removedFiles.length,
    };
  });

  await runScenario('codex_status_outdated_sync_uninstall', async () => {
    const tmpHome = createTempDir('tokrepo-eval-lifecycle-home');
    tempRoots.push(tmpHome);
    const env = { HOME: tmpHome };
    const install = runSelfCliJson(['install', sampleUuid, '--target', 'codex', '--yes', '--json'], { env });
    const installedFile = install.installedFiles?.[0]?.path;
    if (!installedFile) throw new Error('install produced no file to mutate');

    const installedBefore = runSelfCliJson(['installed', '--target', 'codex', '--json'], { env });
    if (installedBefore.count !== 1 || installedBefore.list[0]?.status !== 'installed') {
      throw new Error(`expected one installed record, got ${installedBefore.count}/${installedBefore.list[0]?.status}`);
    }

    fs.appendFileSync(installedFile, '\nLocal edit from eval-agent lifecycle scenario.\n');
    const installedChanged = runSelfCliJson(['installed', '--target', 'codex', '--json'], { env });
    if (installedChanged.list[0]?.status !== 'local-changes') throw new Error(`expected local-changes, got ${installedChanged.list[0]?.status}`);

    const outdated = runSelfCliJson(['outdated', '--target', 'codex', '--json'], { env });
    if (outdated.outdated < 1) throw new Error('outdated did not report the local change');

    const dryRun = runSelfCliJson(['sync-installed', '--target', 'codex', '--dry-run', '--json'], { env });
    if (dryRun.results?.[0]?.status !== 'would-update') throw new Error(`sync dry-run status was ${dryRun.results?.[0]?.status}`);

    const sync = runSelfCliJson(['sync-installed', '--target', 'codex', '--json'], { env });
    if (!['updated', 'staged'].includes(sync.results?.[0]?.status)) throw new Error(`sync status was ${sync.results?.[0]?.status}`);

    const installedAfterSync = runSelfCliJson(['installed', '--target', 'codex', '--json'], { env });
    if (installedAfterSync.list[0]?.status !== 'installed') throw new Error(`expected installed after sync, got ${installedAfterSync.list[0]?.status}`);

    const uninstallDryRun = runSelfCliJson(['uninstall', sampleUuid, '--target', 'codex', '--dry-run', '--json'], { env });
    if (!uninstallDryRun.plan?.actions?.length) throw new Error('uninstall dry-run missing actions');

    const uninstall = runSelfCliJson(['uninstall', sampleUuid, '--target', 'codex', '--json'], { env });
    if (!uninstall.removedFiles?.length) throw new Error('uninstall removed no files');
    const installedAfterUninstall = runSelfCliJson(['installed', '--target', 'codex', '--json'], { env });
    if (installedAfterUninstall.count !== 0) throw new Error(`manifest still has ${installedAfterUninstall.count} install(s) after uninstall`);

    return {
      installedFile,
      outdated: outdated.outdated,
      syncStatus: sync.results?.[0]?.status,
      removedFiles: uninstall.removedFiles.length,
    };
  });
  }

  if (!keepTemp) {
    for (const dir of tempRoots) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  const failed = results.filter(result => !result.ok);
  const summary = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    cliVersion: CLI_VERSION,
    targetTool: 'codex',
    sampleUuid,
    query,
    status: failed.length === 0 ? 'pass' : 'fail',
    passed: results.length - failed.length,
    failed: failed.length,
    count: results.length,
    tempRoots: keepTemp ? tempRoots : [],
    results,
  };

  if (json) {
    outputJson(summary);
  } else {
    log('');
    if (summary.status === 'pass') success(`Agent eval passed: ${summary.passed}/${summary.count}`);
    else warn(`Agent eval failed: ${summary.failed}/${summary.count}`);
  }

  if (failed.length > 0) process.exitCode = 1;
}

async function cmdSyncInstalled() {
  const args = parseArgs(process.argv);
  const targetTool = validateInstallTarget(args.flags.target || 'codex');
  if (targetTool !== 'codex') {
    error(`sync-installed currently supports --target codex only`);
  }

  const json = Boolean(args.flags.json);
  if (!json) log(`\n${C.bold}tokrepo sync-installed${C.reset}\n`);

  const manifest = readCodexManifest();
  const installed = (manifest.installs || []).filter(item => (item.targetTool || item.target_tool) === 'codex');
  const dryRun = Boolean(args.flags.dryRun || args.flags.dry_run);
  const stage = Boolean(args.flags.stage);
  if (installed.length === 0) {
    if (json) outputJson({ targetTool: 'codex', manifestPath: CODEX_MANIFEST_FILE, dryRun, stage, count: 0, results: [] });
    else info(`No Codex installs found in ${CODEX_MANIFEST_FILE}`);
    return;
  }

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;
  const force = Boolean(args.flags.update || args.flags.force || args.flags.all);
  const results = [];

  for (let i = 0; i < installed.length; i++) {
    const record = installed[i];
    const uuid = record.uuid;
    if (!uuid) continue;

    if (!json) log(`${C.dim}[${i + 1}/${installed.length}]${C.reset} ${record.title || uuid}`);

    try {
      const { workflow, contents } = await fetchWorkflowForInstall(uuid, config, apiBase);
      const serverPlan = await fetchServerCodexInstallPlan(uuid, config, apiBase);
      const plan = buildCodexInstallPlan(workflow, contents, { installMode: record.installMode || record.install_mode, serverPlan });
      const diff = diffCodexPlanWithLocal(plan, record);
      const obsoleteActions = buildObsoleteCodexFileActions(record, plan, { force: Boolean(args.flags.force) });
      const shouldWrite = force || diff.needsUpdate;

      if (dryRun) {
        results.push({
          uuid,
          title: workflow.title,
          status: shouldWrite ? 'would-update' : 'unchanged',
          needsUpdate: shouldWrite,
          reasons: diff.reasons,
          obsoleteActions,
          plan: publicInstallPlan(plan),
        });
        if (!json) {
          const label = shouldWrite ? `${C.yellow}would update${C.reset}` : `${C.green}unchanged${C.reset}`;
          log(`  ${label}`);
        }
        continue;
      }

      if (!shouldWrite) {
        results.push({
          uuid,
          title: workflow.title,
          status: 'unchanged',
          needsUpdate: false,
          reasons: [],
        });
        if (!json) success('Unchanged');
        continue;
      }

      assertObsoleteCodexFilesRemovable(obsoleteActions);
      const installResult = await installCodexAsset(workflow, contents, {
        ...args.flags,
        dryRun: false,
        stage,
        installMode: record.installMode || record.install_mode,
        approveMcp: Boolean(args.flags.approveMcp || args.flags.approve_mcp),
        verifyCommands: Boolean(args.flags.verify_commands || args.flags.verifyCommands),
        json: true,
        throwOnError: true,
        serverPlan,
      });
      const obsolete = removeObsoleteCodexFiles(obsoleteActions);

      results.push({
        uuid,
        title: workflow.title,
        status: stage ? 'staged' : 'updated',
        needsUpdate: true,
        reasons: diff.reasons,
        obsoleteFilesRemoved: obsolete.removed,
        obsoleteFilesSkipped: obsolete.skipped,
        stagePath: installResult.stagePath,
        installedFiles: installResult.installedFiles || [],
        plan: installResult.plan,
        sessionId: installResult.sessionId,
        sessionPath: installResult.sessionPath,
        verification: installResult.verification,
      });
      if (!json) success(stage ? `Staged ${installResult.plan.files.length} file(s)` : `Updated ${(installResult.installedFiles || []).length} file(s)`);
    } catch (e) {
      results.push({ uuid, title: record.title || uuid, status: 'failed', error: e.message });
      if (!json) warn(`Failed: ${e.message}`);
    }
  }

  const summary = {
    targetTool: 'codex',
    manifestPath: CODEX_MANIFEST_FILE,
    dryRun,
    stage,
    count: results.length,
    updated: results.filter(item => item.status === 'updated').length,
    staged: results.filter(item => item.status === 'staged').length,
    unchanged: results.filter(item => item.status === 'unchanged').length,
    failed: results.filter(item => item.status === 'failed').length,
    results,
  };

  if (json) {
    outputJson(summary);
  } else {
    log('');
    success(`Sync complete: ${summary.updated} updated, ${summary.staged} staged, ${summary.unchanged} unchanged, ${summary.failed} failed`);
  }
}

async function cmdInstalled() {
  const args = parseArgs(process.argv);
  const targetTool = validateInstallTarget(args.flags.target || 'codex');
  if (targetTool !== 'codex') error(`installed currently supports --target codex only`);

  const json = Boolean(args.flags.json);
  if (!json) log(`\n${C.bold}tokrepo installed${C.reset}\n`);

  const manifest = readCodexManifest();
  const records = (manifest.installs || []).filter(item => (item.targetTool || item.target_tool) === 'codex');
  const list = records.map(record => {
    const files = (record.installedFiles || record.installed_files || []).map(file => {
      const actualSha = file.path && fs.existsSync(file.path) ? currentFileSha(file.path) : '';
      return {
        path: file.path,
        sourceName: file.sourceName || file.source_name,
        sha256: file.sha256,
        exists: Boolean(file.path && fs.existsSync(file.path)),
        changed: Boolean(actualSha && file.sha256 && actualSha !== file.sha256),
      };
    });
    return {
      uuid: record.uuid,
      title: record.title,
      sourceUrl: record.sourceUrl || record.source_url,
      targetTool: 'codex',
      installMode: record.installMode || record.install_mode,
      installedAt: record.installedAt || record.installed_at,
      contentHash: record.contentHash || record.content_hash || '',
      sessionId: record.sessionId || record.session_id,
      sessionPath: record.sessionPath || record.session_path,
      risks: record.risks || [],
      files,
      status: files.some(file => !file.exists) ? 'missing-files' : files.some(file => file.changed) ? 'local-changes' : 'installed',
    };
  });

  if (json) {
    outputJson({ targetTool: 'codex', manifestPath: CODEX_MANIFEST_FILE, count: list.length, list });
    return;
  }

  if (list.length === 0) {
    info(`No Codex installs found in ${CODEX_MANIFEST_FILE}`);
    return;
  }

  for (const item of list) {
    const color = item.status === 'installed' ? C.green : C.yellow;
    log(`  ${color}${item.status}${C.reset}  ${C.bold}${item.title || item.uuid}${C.reset}`);
    log(`  ${C.dim}${item.uuid} · ${item.installMode || 'unknown'} · ${item.files.length} file(s)${C.reset}\n`);
  }
}

function isCodexManagedPath(filePath) {
  const resolved = path.resolve(expandHomePath(filePath));
  return ensureInside(CODEX_SKILLS_DIR, resolved) || ensureInside(path.join(CODEX_TOKREPO_DIR, 'staged'), resolved);
}

function removeEmptyCodexDirs(startDir) {
  const roots = [CODEX_SKILLS_DIR, path.join(CODEX_TOKREPO_DIR, 'staged')].map(root => path.resolve(root));
  let dir = path.resolve(startDir);
  const root = roots.find(candidate => dir === candidate || dir.startsWith(candidate + path.sep));
  if (!root) return;
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

function findCodexManifestRecord(selector) {
  const manifest = readCodexManifest();
  const records = (manifest.installs || []).filter(item => (item.targetTool || item.target_tool) === 'codex');
  const needle = String(selector || '').trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  const exact = records.find(record => String(record.uuid || '').toLowerCase() === lower);
  if (exact) return exact;

  const prefixMatches = /^[a-f0-9-]{8,}$/i.test(needle)
    ? records.filter(record => String(record.uuid || '').toLowerCase().startsWith(lower))
    : [];
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) throw new Error(`Multiple installed assets match "${selector}". Use the full UUID.`);

  const slugNeedle = slugify(needle, '');
  const titleMatches = records.filter(record => {
    const title = String(record.title || '').toLowerCase();
    const sourceUrl = String(record.sourceUrl || record.source_url || '').toLowerCase();
    return title === lower || slugify(record.title || '', '') === slugNeedle || sourceUrl.includes(lower);
  });
  if (titleMatches.length === 1) return titleMatches[0];
  if (titleMatches.length > 1) throw new Error(`Multiple installed assets match "${selector}". Use the UUID.`);

  const fuzzy = records.filter(record => String(record.title || '').toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new Error(`Multiple installed assets match "${selector}". Use the UUID.`);
  return null;
}

function buildCodexRemovalPlan(record, files, opts = {}) {
  const actions = (files || []).map(file => {
    const filePath = path.resolve(expandHomePath(file.path));
    const exists = fs.existsSync(filePath);
    const actualSha = exists ? currentFileSha(filePath) : '';
    const expectedSha = file.sha256 || '';
    const changed = Boolean(exists && expectedSha && actualSha !== expectedSha);
    const managed = isCodexManagedPath(filePath);
    const allowed = managed && (!changed || opts.force);
    const reason = !managed ? 'outside-managed-roots'
      : changed && !opts.force ? 'local-changes'
      : exists ? 'remove'
      : 'already-missing';
    return {
      type: 'remove_file',
      path: filePath,
      sourceName: file.sourceName || file.source_name,
      expectedSha,
      actualSha,
      exists,
      changed,
      allowed,
      reason,
    };
  });
  return {
    schemaVersion: 1,
    operation: opts.operation || 'uninstall',
    targetTool: 'codex',
    uuid: record.uuid,
    title: record.title,
    sourceUrl: record.sourceUrl || record.source_url,
    manifestPath: CODEX_MANIFEST_FILE,
    force: Boolean(opts.force),
    dryRun: Boolean(opts.dryRun),
    requiresConfirmation: actions.some(action => !action.allowed),
    actions,
  };
}

function executeCodexRemovalPlan(plan, opts = {}) {
  const blocked = plan.actions.filter(action => !action.allowed);
  if (blocked.length > 0) {
    const first = blocked[0];
    throw new Error(`Refusing to remove ${first.path}: ${first.reason}. Use --force only if you want to remove local changes.`);
  }

  const removedFiles = [];
  const skippedFiles = [];
  for (const action of plan.actions) {
    if (!action.exists) {
      skippedFiles.push({ path: action.path, reason: 'already-missing' });
      continue;
    }
    fs.unlinkSync(action.path);
    removedFiles.push({ path: action.path, sha256: action.actualSha || action.expectedSha });
    removeEmptyCodexDirs(path.dirname(action.path));
  }

  const session = writeCodexSession({
    operation: plan.operation,
    status: plan.operation === 'rollback' ? 'rolled_back' : 'uninstalled',
    targetTool: 'codex',
    uuid: plan.uuid,
    title: plan.title,
    sourceUrl: plan.sourceUrl,
    plan,
    result: { removedFiles, skippedFiles },
  });

  if (opts.removeManifest !== false && plan.uuid) {
    const manifest = readCodexManifest();
    manifest.installs = (manifest.installs || []).filter(item => !((item.targetTool || item.target_tool) === 'codex' && item.uuid === plan.uuid));
    writeCodexManifest(manifest);
  }

  return { dryRun: false, plan, removedFiles, skippedFiles, ...session };
}

async function cmdUninstall() {
  const args = parseArgs(process.argv);
  const target = args.positional[0];
  if (!target) {
    showUninstallHelp();
    process.exit(1);
  }
  const targetTool = validateInstallTarget(args.flags.target || 'codex');
  if (targetTool !== 'codex') error(`uninstall currently supports --target codex only`);

  const json = Boolean(args.flags.json);
  const dryRun = Boolean(args.flags.dryRun || args.flags.dry_run);
  const force = Boolean(args.flags.force);
  if (!json) log(`\n${C.bold}tokrepo uninstall${C.reset}\n`);

  try {
    const record = findCodexManifestRecord(target);
    if (!record) error(`No installed Codex asset found for "${target}". Run: tokrepo installed --target codex`);
    const files = record.installedFiles || record.installed_files || [];
    const plan = buildCodexRemovalPlan(record, files, { operation: 'uninstall', dryRun, force });
    if (dryRun) {
      const session = writeCodexSession({
        operation: 'uninstall',
        status: 'dry_run',
        targetTool: 'codex',
        uuid: record.uuid,
        title: record.title,
        sourceUrl: record.sourceUrl || record.source_url,
        plan,
        result: { dryRun: true },
      });
      const response = { dryRun: true, plan, removedFiles: [], ...session };
      if (json) outputJson(response);
      else {
        info(`Dry run: ${plan.actions.length} file(s) would be removed`);
        for (const action of plan.actions) {
          const rel = path.relative(os.homedir(), action.path);
          log(`  ${action.allowed ? C.dim : C.yellow}•${C.reset} ~/${rel} ${C.dim}${action.reason}${C.reset}`);
        }
        log(`  ${C.dim}Session: ${session.sessionPath}${C.reset}`);
      }
      return;
    }

    const result = executeCodexRemovalPlan(plan, { force });
    if (json) outputJson(result);
    else {
      for (const file of result.removedFiles) {
        success(`Removed: ~/${path.relative(os.homedir(), file.path)}`);
      }
      success(`Uninstalled ${record.title || record.uuid}`);
      log(`  ${C.dim}Manifest: ${CODEX_MANIFEST_FILE}${C.reset}`);
      log(`  ${C.dim}Session: ${result.sessionPath}${C.reset}\n`);
    }
  } catch (e) {
    error(`Uninstall failed: ${e.message}`);
  }
}

function findRollbackSession(selector) {
  const sessions = readCodexSessions();
  if (selector === 'last') {
    return [...sessions].reverse().find(session => (
      session.operation === 'install'
      && ['installed', 'staged', 'stage_only'].includes(session.status)
      && (session.installedFiles?.length || session.result?.stagePath || session.plan?.rollback?.length)
    ));
  }
  const needle = String(selector || '').trim();
  if (!needle) return null;
  return sessions.find(session => session.sessionId === needle || String(session.sessionId || '').startsWith(needle));
}

function filesFromRollbackSession(session) {
  if (!session) return [];
  if (session.status === 'staged' && session.result?.stagePath) {
    return [{ path: session.result.stagePath, sha256: currentFileSha(session.result.stagePath), sourceName: 'install-plan.json' }];
  }
  if (Array.isArray(session.installedFiles) && session.installedFiles.length > 0) return session.installedFiles;
  return (session.plan?.rollback || [])
    .filter(action => action.type === 'remove_file' && action.path)
    .map(action => ({ path: action.path, sha256: action.sha256 || '', sourceName: path.basename(action.path) }));
}

async function cmdRollback() {
  const args = parseArgs(process.argv);
  const selector = args.flags.last ? 'last' : (args.flags.session || args.positional[0]);
  if (!selector) {
    showRollbackHelp();
    process.exit(1);
  }
  const targetTool = validateInstallTarget(args.flags.target || 'codex');
  if (targetTool !== 'codex') error(`rollback currently supports --target codex only`);

  const json = Boolean(args.flags.json);
  const dryRun = Boolean(args.flags.dryRun || args.flags.dry_run);
  const force = Boolean(args.flags.force);
  if (!json) log(`\n${C.bold}tokrepo rollback${C.reset}\n`);

  try {
    const session = findRollbackSession(selector);
    if (!session) error(`No rollback session found for "${selector}". Run: tokrepo installed --target codex --json`);
    const files = filesFromRollbackSession(session);
    const plan = buildCodexRemovalPlan(session, files, { operation: 'rollback', dryRun, force });
    plan.rollbackSessionId = session.sessionId;
    plan.rollbackSessionPath = session.sessionPath;

    if (dryRun) {
      const audit = writeCodexSession({
        operation: 'rollback',
        status: 'dry_run',
        targetTool: 'codex',
        uuid: session.uuid,
        title: session.title,
        sourceUrl: session.sourceUrl,
        plan,
        result: { dryRun: true },
      });
      const response = { dryRun: true, plan, removedFiles: [], ...audit };
      if (json) outputJson(response);
      else {
        info(`Dry run: rollback ${session.sessionId} would remove ${plan.actions.length} file(s)`);
        for (const action of plan.actions) {
          const rel = path.relative(os.homedir(), action.path);
          log(`  ${action.allowed ? C.dim : C.yellow}•${C.reset} ~/${rel} ${C.dim}${action.reason}${C.reset}`);
        }
        log(`  ${C.dim}Session: ${audit.sessionPath}${C.reset}`);
      }
      return;
    }

    const result = executeCodexRemovalPlan(plan, { force, removeManifest: Boolean(session.uuid) });
    if (json) outputJson(result);
    else {
      for (const file of result.removedFiles) {
        success(`Removed: ~/${path.relative(os.homedir(), file.path)}`);
      }
      success(`Rolled back ${session.sessionId}`);
      log(`  ${C.dim}Session: ${result.sessionPath}${C.reset}\n`);
    }
  } catch (e) {
    error(`Rollback failed: ${e.message}`);
  }
}

async function cmdOutdated() {
  const args = parseArgs(process.argv);
  const targetTool = validateInstallTarget(args.flags.target || 'codex');
  if (targetTool !== 'codex') error(`outdated currently supports --target codex only`);

  const json = Boolean(args.flags.json);
  if (!json) log(`\n${C.bold}tokrepo outdated${C.reset}\n`);

  const manifest = readCodexManifest();
  const installed = (manifest.installs || []).filter(item => (item.targetTool || item.target_tool) === 'codex');
  if (installed.length === 0) {
    if (json) outputJson({ targetTool: 'codex', count: 0, outdated: 0, list: [] });
    else info(`No Codex installs found in ${CODEX_MANIFEST_FILE}`);
    return;
  }

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;
  const list = [];
  let unchanged = 0;
  let failed = 0;

  for (const record of installed) {
    try {
      const { workflow, contents } = await fetchWorkflowForInstall(record.uuid, config, apiBase);
      const serverPlan = await fetchServerCodexInstallPlan(record.uuid, config, apiBase);
      const plan = buildCodexInstallPlan(workflow, contents, { installMode: record.installMode || record.install_mode, serverPlan });
      const diff = diffCodexPlanWithLocal(plan, record);
      if (diff.needsUpdate) {
        list.push({
          uuid: record.uuid,
          title: workflow.title,
          status: 'outdated',
          reasons: diff.reasons,
          plan: publicInstallPlan(plan),
        });
      } else {
        unchanged++;
      }
    } catch (e) {
      failed++;
      list.push({ uuid: record.uuid, title: record.title || record.uuid, status: 'failed', error: e.message });
    }
  }

  if (json) {
    outputJson({ targetTool: 'codex', manifestPath: CODEX_MANIFEST_FILE, count: installed.length, outdated: list.filter(i => i.status === 'outdated').length, unchanged, failed, list });
    return;
  }

  const outdated = list.filter(item => item.status === 'outdated');
  if (outdated.length === 0 && failed === 0) {
    success(`All ${unchanged} Codex install(s) are up to date.`);
    return;
  }
  for (const item of list) {
    if (item.status === 'failed') {
      warn(`${item.title}: ${item.error}`);
    } else {
      log(`  ${C.yellow}outdated${C.reset}  ${C.bold}${item.title}${C.reset}`);
      for (const reason of item.reasons.slice(0, 3)) {
        log(`    ${C.dim}${reason.type}: ${reason.path || ''}${C.reset}`);
      }
    }
  }
  log('');
  info(`Run ${C.cyan}tokrepo update --target codex --all${C.reset} to update installed Codex assets.`);
}

async function cmdTags() {
  log(`\n${C.bold}tokrepo tags${C.reset}\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  try {
    const data = await apiRequest('GET', '/api/v1/tokenboard/tags/list', null, null, apiBase);
    log(`  Available tags:\n`);
    for (const tag of data.tags) {
      log(`  ${C.cyan}${tag.name}${C.reset}${tag.count ? ` ${C.dim}(${tag.count} assets)${C.reset}` : ''}`);
    }
    log('');
  } catch (e) {
    error(`Failed: ${e.message}`);
  }
}

async function cmdStatus() {
  log(`\n${C.bold}tokrepo status${C.reset}\n`);

  const config = readConfig();
  if (!config || !config.token) error(`Not logged in. Run: ${C.cyan}tokrepo login${C.reset}`);

  const projectConfig = readProjectConfig();
  const baseDir = process.cwd();

  // Collect local files
  let filesToCheck;
  if (projectConfig) {
    const patterns = projectConfig.files || ['*.md'];
    filesToCheck = findFiles(patterns, baseDir);
  } else {
    filesToCheck = collectFiles(['.'], baseDir);
  }

  if (filesToCheck.length === 0) {
    info('No pushable files found in current directory.');
    return;
  }

  // Build assets with content hashes for diff
  const crypto = require('crypto');
  const assets = [];
  const titleBase = projectConfig?.title || guessTitle(filesToCheck, baseDir);

  // Each file becomes an asset for diff comparison
  // But the primary asset is the whole push unit
  const pushFiles = [];
  for (const f of filesToCheck) {
    let content;
    try { content = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    if (!content.trim()) continue;
    pushFiles.push({ name: f.relPath, content });
  }

  if (pushFiles.length === 0) {
    info('No readable text files found.');
    return;
  }

  // Compute content hash matching backend's computeContentHash format
  const h = crypto.createHash('sha256');
  for (const f of pushFiles) {
    h.update(f.name);
    h.update('\0');
    h.update(f.content);
    h.update('\0');
  }
  const localHash = h.digest('hex');

  assets.push({ title: titleBase, content_hash: localHash });

  info('Comparing local files with remote...');

  try {
    const data = await apiRequest('POST', '/api/v1/tokenboard/push/diff', { assets }, config.token, config.api);
    log('');
    for (const r of data.results) {
      const icon = r.status === 'new' ? `${C.green}+ new${C.reset}`
        : r.status === 'updated' ? `${C.yellow}~ modified${C.reset}`
        : `${C.dim}= unchanged${C.reset}`;
      log(`  ${icon}  ${r.title}${r.remote_uuid ? ` ${C.dim}(${r.remote_uuid.substring(0, 8)}...)${C.reset}` : ''}`);
    }
    log('');

    const newCount = data.results.filter(r => r.status === 'new').length;
    const updatedCount = data.results.filter(r => r.status === 'updated').length;
    const unchangedCount = data.results.filter(r => r.status === 'unchanged').length;

    if (newCount || updatedCount) {
      info(`${newCount ? newCount + ' new' : ''}${newCount && updatedCount ? ', ' : ''}${updatedCount ? updatedCount + ' modified' : ''}. Run ${C.cyan}tokrepo push${C.reset} to sync.`);
    } else {
      success('Everything up to date.');
    }
  } catch (e) {
    error(`Status check failed: ${e.message}`);
  }
}

function showHelp() {
  log(`
${C.bold}tokrepo${C.reset} — AI assets for humans and agents. Like GitHub, for AI experience.

  ${C.dim}You control what gets pushed. Each push uploads only the files you specify.
  Nothing is shared without your explicit action. Private by default.${C.reset}

${C.bold}QUICK START${C.reset}
  ${C.cyan}tokrepo init-agent${C.reset}                     # teach project agents to use TokRepo
  ${C.cyan}tokrepo agent-check "write SEO docs"${C.reset}    # planning-time capability check
  ${C.cyan}tokrepo search cursor rules${C.reset}             # find assets
  ${C.cyan}tokrepo install awesome-cursor-rules${C.reset}    # install to your project
  ${C.cyan}tokrepo agent-handoff${C.reset}                   # suggest reusable assets after a task
  ${C.cyan}tokrepo push --private my-skill.md${C.reset}      # save privately (only you can see)
  ${C.cyan}tokrepo push --public my-skill.md${C.reset}       # share publicly

${C.bold}USAGE${C.reset}
  tokrepo <command> [args] [options]

${C.bold}DISCOVER & INSTALL${C.reset}
  ${C.cyan}init-agent${C.reset}          Write AGENTS/CLAUDE/GEMINI/Cursor rules for TokRepo
  ${C.cyan}agent-check${C.reset} <task>  Planning-time capability discovery contract
  ${C.cyan}search${C.reset} <query>      Search assets by keyword
  ${C.cyan}detail${C.reset} <name|uuid>  Show full asset metadata
  ${C.cyan}plan${C.reset} <name|uuid>    Print agent-native Codex install plan
  ${C.cyan}install${C.reset} <name|uuid> Smart install (auto-detects type & placement)
  ${C.cyan}pull${C.reset} <url|uuid|@u/n> Download raw asset files
  ${C.cyan}clone${C.reset} @username      Clone all assets from a user
  ${C.cyan}installed${C.reset}            List installed Codex assets from manifest
  ${C.cyan}outdated${C.reset}             Check installed Codex assets for updates
  ${C.cyan}sync-installed${C.reset}       Update installed Codex assets from manifest
  ${C.cyan}uninstall${C.reset} <uuid>     Remove a managed Codex install
  ${C.cyan}rollback${C.reset} --last      Roll back the latest Codex install session
  ${C.cyan}eval-agent${C.reset}           Run agent-native contract and lifecycle evals

${C.bold}PUBLISH${C.reset}
  ${C.cyan}agent-handoff${C.reset}       Suggest reusable local assets to push after a task
  ${C.cyan}push${C.reset} [files...]     Push files/directory (idempotent upsert)
  ${C.cyan}status${C.reset}              Compare local vs remote (like git status)
  ${C.cyan}init${C.reset}                Create .tokrepo.json project config
  ${C.cyan}update${C.reset} <uuid> [f]   Update existing remote asset
  ${C.cyan}update${C.reset} --target codex --all   Update installed Codex assets
  ${C.cyan}delete${C.reset} <uuid>       Delete an asset

${C.bold}ACCOUNT${C.reset}
  ${C.cyan}login${C.reset}               Save API key (or set TOKREPO_TOKEN env var)
  ${C.cyan}list${C.reset}                List your published assets
  ${C.cyan}tags${C.reset}                List available tags
  ${C.cyan}whoami${C.reset}              Show current user
  ${C.cyan}help${C.reset}                Show this help

${C.bold}PUSH OPTIONS${C.reset}
  ${C.cyan}--private${C.reset}           Keep asset private — only you can see it (recommended for personal assets)
  ${C.cyan}--public${C.reset}            Share asset publicly with the community
  ${C.cyan}--title${C.reset} "..."       Set title (auto-detected from README or dir name)
  ${C.cyan}--desc${C.reset} "..."        Set description
  ${C.cyan}--tag${C.reset} Skills        Add tag (repeatable)
  ${C.cyan}--kind${C.reset} skill         Set agent asset_kind
  ${C.cyan}--target${C.reset} codex       Add target tool metadata on push
  ${C.cyan}--install-mode${C.reset} bundle Set install_mode metadata
  ${C.cyan}--metadata-report${C.reset}    Print agent metadata quality suggestions without pushing

${C.bold}INSTALL BEHAVIOR${C.reset}
  Skills   → .claude/skills/    (if .claude/ exists)
  Gemini   → .gemini/GEMINI.md  (with --target gemini)
  Codex    → ~/.codex/skills/    (with --target codex)
  Scripts  → current dir        (chmod +x)
  Configs  → project root
  MCP      → current dir        (.json)
  Prompts  → current dir        (.md)

${C.bold}EXAMPLES${C.reset}
  tokrepo init-agent --target all
  tokrepo agent-check "audit Nuxt SEO" --target codex --json
  tokrepo search "mcp server"                 # Find MCP configs
  tokrepo search video --target codex --kind skill --policy allow --json
  tokrepo detail ca000374-f5d8-... --json     # Machine-readable detail
  tokrepo plan 91aeb22d-eff0-4310-...         # Install plan v2 for agents
  tokrepo install ca000374-f5d8-...           # Install by UUID
  tokrepo install ca000374-f5d8-... --target codex
  tokrepo install c4b18aeb --target gemini    # Install for Gemini CLI
  tokrepo clone @henuwangkai --target codex --keyword video
  tokrepo installed --target codex --json
  tokrepo outdated --target codex --json
  tokrepo update --target codex --all
  tokrepo sync-installed --target codex --dry-run
  tokrepo uninstall 91aeb22d --target codex --dry-run
  tokrepo rollback --last --target codex --dry-run
  tokrepo eval-agent --json
  tokrepo agent-handoff --json
  tokrepo push --private my-rules.md          # Save one file privately
  tokrepo push . --metadata-report --json     # Check agent metadata without uploading
  tokrepo push . --kind skill --target codex --install-mode bundle
  tokrepo push --public skill.md              # Share one file publicly
  tokrepo push --private .                    # Push current dir as private
  tokrepo push --public --title "My MCP" .    # Push dir publicly with title

${C.bold}FILE TYPE AUTO-DETECTION${C.reset}
  .sh .py .js .ts .mjs .go .rs  →  script
  .json .yaml .yml .toml        →  config
  .skill.md                     →  skill
  .prompt .prompt.md            →  prompt
  .md (other)                   →  other

${C.bold}AGENT / CI SETUP${C.reset}
  npx -y tokrepo-mcp-server           # exposes tokrepo_discover to MCP agents
  tokrepo init-agent --target all     # writes project instructions for agents
  export TOKREPO_TOKEN=tk_xxx          # skip login, agents use this
  export TOKREPO_API=https://...       # optional custom API endpoint

${C.bold}GET YOUR TOKEN${C.reset}
  https://tokrepo.com/en/my/settings
`);
}

function showSearchHelp() {
  log(`
${C.bold}tokrepo search${C.reset}

USAGE
  tokrepo search <query> [--json] [--all] [--target codex] [--kind skill] [--policy allow|confirm|stage_only|deny] [--page-size N] [--sort-by views|latest|stars|popular]

EXAMPLES
  tokrepo search video
  tokrepo search video --json
  tokrepo search video --target codex --kind skill --policy allow --json
  tokrepo search "mcp server" --json --all
`);
}

function showInitAgentHelp() {
  log(`
${C.bold}tokrepo init-agent${C.reset}

USAGE
  tokrepo init-agent [--target all|codex|claude|gemini|cursor|copilot|cline|windsurf|roo|openhands|aider] [--dry-run] [--json] [--no-mcp]

BEHAVIOR
  Writes a managed TokRepo block into project agent instruction files:
  AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules/tokrepo.mdc,
  .github/copilot-instructions.md, .github/instructions/tokrepo.instructions.md,
  .clinerules/tokrepo.md, .windsurf/rules/tokrepo.md, .roo/rules/tokrepo.md,
  .openhands/microagents/repo.md, CONVENTIONS.md, plus .mcp.json.
  Existing user content is preserved; only the managed TokRepo block is replaced.

EXAMPLES
  tokrepo init-agent --target all
  tokrepo init-agent --target codex --dry-run --json
  tokrepo init-agent --target claude,cursor,copilot --no-mcp
`);
}

function showAgentCheckHelp() {
  log(`
${C.bold}tokrepo agent-check${C.reset}

USAGE
  tokrepo agent-check <task> [--target codex|any] [--kind skill] [--policy allow] [--json] [--offline]

BEHAVIOR
  Produces the planning-time contract an agent should run before inventing a new
  one-off tool. MCP agents should call tokrepo_discover; this command is the CLI fallback.

EXAMPLES
  tokrepo agent-check "audit Nuxt SEO" --target codex --json
  tokrepo agent-check "write product page copy" --kind skill --policy allow
  tokrepo agent-check "build a database MCP integration" --offline --json
`);
}

function showAgentHandoffHelp() {
  log(`
${C.bold}tokrepo agent-handoff${C.reset}

USAGE
  tokrepo agent-handoff [paths...] [--json] [--limit N]

BEHAVIOR
  Scans local files for reusable skills, prompts, scripts, and configs created
  during a task. It never publishes automatically; it only suggests explicit
  private push commands for user confirmation.

EXAMPLES
  tokrepo agent-handoff --json
  tokrepo agent-handoff SKILL.md scripts/check.sh
`);
}

function showDetailHelp() {
  log(`
${C.bold}tokrepo detail${C.reset}

USAGE
  tokrepo detail <uuid|url|name> [--json]

EXAMPLES
  tokrepo detail 91aeb22d-eff0-4310-abc6-811d2394b420 --json
  tokrepo detail https://tokrepo.com/en/workflows/91aeb22d-eff0-4310-abc6-811d2394b420
`);
}

function showInstallHelp() {
  log(`
${C.bold}tokrepo install${C.reset}

USAGE
  tokrepo install <uuid|url|name|pack/slug> [--target gemini|codex] [--yes] [--dry-run] [--stage] [--approve-mcp] [--verify-commands] [--json]

TARGETS
  codex    Write Codex skills to ~/.codex/skills/<asset-slug>/SKILL.md
  gemini   Write project instructions to .gemini/GEMINI.md

EXAMPLES
  tokrepo install awesome-cursor-rules
  tokrepo install ca000374-f5d8-4d75-a30c-460fda0b6b0e
  tokrepo install https://tokrepo.com/en/workflows/ca000374-...
  tokrepo install 91aeb22d-eff0-4310-abc6-811d2394b420 --target codex
  tokrepo install 91aeb22d-eff0-4310-abc6-811d2394b420 --target codex --dry-run --json
  tokrepo install 20bc3ffd-1d7a-41d1-86d0-b668e8500cee --target codex --stage
  tokrepo install c4b18aeb --target gemini
`);
}

function showPlanHelp() {
  log(`
${C.bold}tokrepo plan${C.reset}

USAGE
  tokrepo plan <uuid|url|name> [--target codex] [--stage]

OUTPUT
  Machine-readable install plan v2 with preconditions, actions, policyDecision,
  rollback, postVerify, risk metadata, and destination file hashes.

EXAMPLES
  tokrepo plan 91aeb22d-eff0-4310-abc6-811d2394b420
  tokrepo plan https://tokrepo.com/en/workflows/91aeb22d-eff0-4310-abc6-811d2394b420
`);
}

function showListHelp() {
  log(`
${C.bold}tokrepo list${C.reset}

USAGE
  tokrepo list [--json] [--all] [--target codex] [--kind skill] [--policy allow] [--page-size N]

EXAMPLES
  tokrepo list
  tokrepo list --json --all --target codex
`);
}

function showCloneHelp() {
  log(`
${C.bold}tokrepo clone${C.reset}

USAGE
  tokrepo clone @username [--target codex] [--keyword query] [--types skill,prompt,knowledge] [--dry-run] [--stage] [--approve-mcp] [--json] [--manifest]

EXAMPLES
  tokrepo clone @henuwangkai --target codex --types skill,prompt,knowledge
  tokrepo clone @henuwangkai --target codex --keyword video
  tokrepo clone @me --target codex --dry-run --json --manifest
`);
}

function showSyncInstalledHelp() {
  log(`
${C.bold}tokrepo sync-installed${C.reset}

USAGE
  tokrepo sync-installed --target codex [--dry-run] [--stage] [--update] [--approve-mcp] [--json]
  tokrepo installed --target codex [--json]
  tokrepo outdated --target codex [--json]
  tokrepo update --target codex --all [--stage] [--approve-mcp] [--json]

BEHAVIOR
  Reads ~/.codex/tokrepo/install-manifest.json, fetches each TokRepo asset again,
  rebuilds the Codex install plan, compares local files by sha256, then updates
  changed or missing files. Use --update to force reinstall unchanged assets.

EXAMPLES
  tokrepo installed --target codex --json
  tokrepo outdated --target codex --json
  tokrepo update --target codex --all
  tokrepo sync-installed --target codex --dry-run --json
  tokrepo sync-installed --target codex --stage
  tokrepo sync-installed --target codex --update --approve-mcp
`);
}

function showUninstallHelp() {
  log(`
${C.bold}tokrepo uninstall${C.reset}

USAGE
  tokrepo uninstall <uuid|uuid-prefix|title> --target codex [--dry-run] [--force] [--json]

BEHAVIOR
  Removes only files recorded in ~/.codex/tokrepo/install-manifest.json and only
  under ~/.codex/skills or ~/.codex/tokrepo/staged. Local changes are blocked
  unless --force is provided.

EXAMPLES
  tokrepo uninstall 91aeb22d --target codex --dry-run --json
  tokrepo uninstall 91aeb22d-eff0-4310-abc6-811d2394b420 --target codex
`);
}

function showRollbackHelp() {
  log(`
${C.bold}tokrepo rollback${C.reset}

USAGE
  tokrepo rollback --last --target codex [--dry-run] [--force] [--json]
  tokrepo rollback <session-id> --target codex [--dry-run] [--force] [--json]

BEHAVIOR
  Replays the rollback section from ~/.codex/tokrepo/sessions/<session-id>.json.
  Local changes are blocked unless --force is provided.

EXAMPLES
  tokrepo rollback --last --target codex --dry-run --json
  tokrepo rollback install-20260506-120000-abc123 --target codex
`);
}

function showEvalAgentHelp() {
  log(`
${C.bold}tokrepo eval-agent${C.reset}

USAGE
  tokrepo eval-agent [--json] [--uuid <asset-uuid>] [--keyword video] [--offline] [--keep-temp]

BEHAVIOR
  Runs agent-native smoke evals against search filters, install-plan contracts,
  metadata quality reporting, Codex install verification, manifest state, and rollback.
  Lifecycle tests use a temporary HOME and do not touch your real ~/.codex.
  --offline runs a fixture-based contract/lifecycle eval without network access.

EXAMPLES
  tokrepo eval-agent
  tokrepo eval-agent --offline --json
  tokrepo eval-agent --json
  tokrepo eval-agent --uuid 91aeb22d-eff0-4310-abc6-811d2394b420 --keyword video --json
`);
}

function showCommandHelp(command) {
  switch (command) {
    case 'search':
    case 'find':
      showSearchHelp(); break;
    case 'init-agent':
    case 'agent-init':
      showInitAgentHelp(); break;
    case 'agent-check':
    case 'precheck':
      showAgentCheckHelp(); break;
    case 'agent-handoff':
    case 'suggest-push':
      showAgentHandoffHelp(); break;
    case 'detail':
      showDetailHelp(); break;
    case 'plan':
      showPlanHelp(); break;
    case 'install':
    case 'i':
      showInstallHelp(); break;
    case 'list':
      showListHelp(); break;
    case 'clone':
      showCloneHelp(); break;
    case 'sync-installed':
    case 'sync':
    case 'installed':
    case 'outdated':
      showSyncInstalledHelp(); break;
    case 'uninstall':
    case 'remove':
    case 'rm':
      showUninstallHelp(); break;
    case 'rollback':
      showRollbackHelp(); break;
    case 'eval-agent':
    case 'eval':
      showEvalAgentHelp(); break;
    default:
      showHelp(); break;
  }
}

// ─── Main ───

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv);

  if (args.flags.help && command && !['help', '--help', '-h'].includes(command)) {
    showCommandHelp(command);
    return;
  }

  switch (command) {
    case 'login': await cmdLogin(); break;
    case 'init': await cmdInit(); break;
    case 'init-agent': case 'agent-init': await cmdInitAgent(); break;
    case 'agent-check': case 'precheck': await cmdAgentCheck(); break;
    case 'agent-handoff': case 'suggest-push': await cmdAgentHandoff(); break;
    case 'push': await cmdPush(); break;
    case 'pull': await cmdPull(); break;
    case 'search': case 'find': await cmdSearch(); break;
    case 'detail': await cmdDetail(); break;
    case 'plan': await cmdPlan(); break;
    case 'install': case 'i': await cmdInstall(); break;
    case 'list': await cmdList(); break;
    case 'update': await cmdUpdate(); break;
    case 'delete': await cmdDelete(); break;
    case 'clone': await cmdClone(); break;
    case 'installed': await cmdInstalled(); break;
    case 'uninstall': case 'remove': case 'rm': await cmdUninstall(); break;
    case 'rollback': await cmdRollback(); break;
    case 'eval-agent': case 'eval': await cmdEvalAgent(); break;
    case 'eval-agent-fixture':
      if (process.env.TOKREPO_EVAL_FIXTURE !== '1') {
        error('eval-agent-fixture is an internal offline test command. Run: tokrepo eval-agent --offline --json');
      }
      outputJson(runOfflineAgentFixtureEval());
      break;
    case 'outdated': await cmdOutdated(); break;
    case 'sync-installed': case 'sync': await cmdSyncInstalled(); break;
    case 'tags': await cmdTags(); break;
    case 'status': case 'diff': await cmdStatus(); break;
    case 'whoami': await cmdWhoami(); break;
    case '--version': case '-v': case 'version':
      log(`tokrepo ${CLI_VERSION}`); break;
    case 'help': case '--help': case '-h': case undefined:
      showHelp(); break;
    default:
      error(`Unknown command: ${command}. Run: tokrepo help`);
  }

  // Non-blocking update check after command completes
  if (command !== 'plan' && !wantsJson(process.argv) && !args.flags.help) {
    checkForUpdate();
  }
}

main().catch((e) => { error(e.message); });
