#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
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

const CONFIG_DIR = path.join(require('os').homedir(), '.tokrepo');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SYNC_STATE_FILE = path.join(CONFIG_DIR, 'sync-state.json');
const PROJECT_CONFIG = '.tokrepo.json';
const DEFAULT_API = 'https://api.tokrepo.com';
const CLI_VERSION = '3.2.0';
const VERSION_CHECK_FILE = path.join(require('os').homedir(), '.tokrepo', '.version-check');

// ─── Helpers ───

function log(msg) { console.log(msg); }
function success(msg) { log(`${C.green}✓${C.reset} ${msg}`); }
function error(msg) { log(`${C.red}✗${C.reset} ${msg}`); process.exit(1); }
function warn(msg) { log(`${C.yellow}!${C.reset} ${msg}`); }
function info(msg) { log(`${C.cyan}→${C.reset} ${msg}`); }

function readConfig() {
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

// Sync state: maps "dirPath:title" → { uuid, hash, lastSync }
function readSyncState() {
  try { return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeSyncState(state) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
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
      'User-Agent': 'tokrepo-cli/2.0.0',
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
  // Use lowercase singular names to match backend tag slugs
  const map = { skill: 'skill', prompt: 'prompt', script: 'script', config: 'config', mcp: 'mcp' };
  return map[fileType] || null;
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
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--public') {
      args.flags.public = true;
    } else if (arg === '--private') {
      args.flags.private = true;
    } else if (arg === '--title' && i + 1 < argv.length) {
      args.flags.title = argv[++i];
    } else if (arg.startsWith('--title=')) {
      args.flags.title = arg.split('=').slice(1).join('=');
    } else if (arg === '--desc' && i + 1 < argv.length) {
      args.flags.desc = argv[++i];
    } else if (arg.startsWith('--desc=')) {
      args.flags.desc = arg.split('=').slice(1).join('=');
    } else if (arg === '--tag' && i + 1 < argv.length) {
      if (!args.flags.tags) args.flags.tags = [];
      args.flags.tags.push(argv[++i]);
    } else if (arg.startsWith('--tag=')) {
      if (!args.flags.tags) args.flags.tags = [];
      args.flags.tags.push(arg.split('=').slice(1).join('='));
    } else if (arg === '-y' || arg === '--yes') {
      args.flags.yes = true;
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
    // Prevent path traversal — resolved must be within baseDir
    if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
      warn(`Skipped (outside project): ${p}`);
      continue;
    }
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
  info('Get your API token from https://tokrepo.com/en/workflows/submit');
  log('');

  const token = await ask('API Token:');
  if (!token) error('Token is required');

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

async function cmdPush() {
  const args = parseArgs(process.argv);

  const config = readConfig();
  if (!config || !config.token) {
    error(`Not logged in. Run: ${C.cyan}tokrepo login${C.reset}`);
  }

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
  visibility = args.flags.public ? 1 : (args.flags.private ? 0 : (projectConfig?.visibility ?? 1));
  tags = args.flags.tags || tags || [];

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

  // Show summary
  log(`\n${C.bold}tokrepo push${C.reset}\n`);
  log(`  ${C.bold}Title:${C.reset}      ${title}`);
  log(`  ${C.bold}Visibility:${C.reset} ${visibility === 1 ? `${C.green}public${C.reset}` : `${C.yellow}private${C.reset}`}`);
  log(`  ${C.bold}Files:${C.reset}      ${pushFiles.length}`);
  if (detectedTags.size > 0) {
    log(`  ${C.bold}Tags:${C.reset}       ${Array.from(detectedTags).join(', ')}`);
  }
  log('');

  for (const f of pushFiles) {
    const sizeKb = (Buffer.byteLength(f.content) / 1024).toFixed(1);
    log(`  ${C.dim}•${C.reset} ${f.name} ${C.dim}(${f.type}, ${sizeKb}KB)${C.reset}`);
  }
  log('');

  const totalChars = pushFiles.reduce((sum, f) => sum + f.content.length, 0);

  // Push
  info('Pushing...');

  try {
    const data = await apiRequest('POST', '/api/v1/tokenboard/push/create', {
      title,
      description,
      files: pushFiles,
      tags: Array.from(detectedTags),
      token_cost: String(Math.round(totalChars / 4)),
      visibility: visibility,
    }, config.token, config.api);

    log('');
    success(`Pushed!`);
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
    visibility: 1,
    tags: [],
  };

  fs.writeFileSync(
    path.join(process.cwd(), PROJECT_CONFIG),
    JSON.stringify(config, null, 2) + '\n'
  );

  success(`Created ${PROJECT_CONFIG}`);
  log(`\n${C.dim}Then run: tokrepo push${C.reset}\n`);
}

async function cmdPull() {
  const urlOrUuid = process.argv[3];
  if (!urlOrUuid) error('Usage: tokrepo pull <url-or-uuid>');

  log(`\n${C.bold}tokrepo pull${C.reset}\n`);

  let uuid = urlOrUuid;
  const urlMatch = urlOrUuid.match(/workflows\/([a-f0-9-]+)/);
  if (urlMatch) uuid = urlMatch[1];

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  info(`Fetching ${uuid}...`);

  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${uuid}`, null, config?.token, apiBase);
    const workflow = data.workflow;
    log(`\n  ${C.bold}${workflow.title}${C.reset}`);

    if (workflow.steps && workflow.steps.length > 0) {
      for (const step of workflow.steps) {
        const content = step.prompt_template || step.promptTemplate;
        if (content) {
          const fileName = `${step.title || 'step-' + step.step_order}.md`;
          const safeName = fileName.replace(/[/\\?%*:|"<>]/g, '-');
          fs.writeFileSync(path.join(process.cwd(), safeName), content);
          success(`Downloaded: ${safeName}`);
        }
      }
    }
    log('');
    success('Pull complete!');
  } catch (e) {
    error(`Pull failed: ${e.message}`);
  }
}

// ─── Search ───

async function cmdSearch() {
  const query = process.argv.slice(3).join(' ');
  if (!query) error('Usage: tokrepo search <keyword>');

  log(`\n${C.bold}tokrepo search${C.reset} "${query}"\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  try {
    const encoded = encodeURIComponent(query);
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?keyword=${encoded}&page=1&page_size=20&sort_by=views`, null, config?.token, apiBase);

    if (!data.list || data.list.length === 0) {
      info('No assets found.');
      log(`\n  ${C.dim}Try different keywords or browse: https://tokrepo.com/en/featured${C.reset}\n`);
      return;
    }

    log(`  ${C.bold}${data.total}${C.reset} results:\n`);

    for (let i = 0; i < data.list.length; i++) {
      const wf = data.list[i];
      const tags = (wf.tags || []).map(t => t.name).join(', ');
      const views = wf.view_count || 0;
      const votes = wf.vote_count || 0;

      log(`  ${C.dim}${String(i + 1).padStart(2)}.${C.reset} ${C.bold}${wf.title}${C.reset}`);
      if (tags) log(`      ${C.cyan}${tags}${C.reset}  ${C.dim}★${votes} 👁${views}${C.reset}`);
      log(`      ${C.dim}tokrepo install ${wf.uuid}${C.reset}`);
      log('');
    }
  } catch (e) {
    error(`Search failed: ${e.message}`);
  }
}

// ─── Install (smart pull with correct placement) ───

async function cmdInstall() {
  const target = process.argv[3];
  if (!target) {
    error(`Usage: tokrepo install <name-or-uuid>

Examples:
  tokrepo install awesome-cursor-rules
  tokrepo install ca000374-f5d8-4d75-a30c-460fda0b6b0e
  tokrepo install https://tokrepo.com/en/workflows/ca000374-...`);
  }

  log(`\n${C.bold}tokrepo install${C.reset}\n`);

  const config = readConfig();
  const apiBase = config?.api || DEFAULT_API;

  // Resolve target to UUID
  let uuid = target;

  // URL format
  const urlMatch = target.match(/workflows\/([a-f0-9-]+)/);
  if (urlMatch) {
    uuid = urlMatch[1];
  }
  // UUID format check
  else if (!/^[a-f0-9-]{36}$/.test(target)) {
    // Search by name
    info(`Searching for "${target}"...`);
    try {
      const encoded = encodeURIComponent(target);
      const searchData = await apiRequest('GET', `/api/v1/tokenboard/workflows/list?keyword=${encoded}&page=1&page_size=5&sort_by=views`, null, config?.token, apiBase);

      if (!searchData.list || searchData.list.length === 0) {
        error(`No asset found matching "${target}". Try: tokrepo search ${target}`);
      }

      // If exact title match, use it directly
      const exact = searchData.list.find(w => w.title.toLowerCase().includes(target.toLowerCase()));
      const chosen = exact || searchData.list[0];

      uuid = chosen.uuid;
      info(`Found: ${C.bold}${chosen.title}${C.reset}`);
    } catch (e) {
      error(`Search failed: ${e.message}`);
    }
  }

  // Fetch the asset
  info(`Fetching ${uuid.substring(0, 8)}...`);

  let workflow, files;
  try {
    const data = await apiRequest('GET', `/api/v1/tokenboard/workflows/detail?uuid=${uuid}`, null, config?.token, apiBase);
    workflow = data.workflow;
    files = data.workflow.files || [];
  } catch (e) {
    error(`Fetch failed: ${e.message}`);
  }

  log(`\n  ${C.bold}${workflow.title}${C.reset}`);
  if (workflow.description) log(`  ${C.dim}${workflow.description.substring(0, 100)}${C.reset}`);

  // Determine asset type from tags
  let assetType = 'other';
  if (workflow.tags && workflow.tags.length > 0) {
    assetType = (workflow.tags[0].slug || workflow.tags[0].name || '').toLowerCase();
  }

  // Get content — prefer files, fallback to steps
  const contents = [];

  if (files.length > 0) {
    for (const f of files) {
      if (f.content && !f.content.startsWith('PK')) {
        contents.push({ name: f.name, content: f.content, type: f.file_type || f.fileType || 'other' });
      }
    }
  }

  if (contents.length === 0 && workflow.steps) {
    for (const step of workflow.steps) {
      const content = step.prompt_template || step.promptTemplate;
      if (content && !content.startsWith('PK')) {
        const name = (step.title || `step-${step.step_order}`).replace(/[/\\?%*:|"<>]/g, '-');
        contents.push({ name, content, type: assetType });
      }
    }
  }

  if (contents.length === 0) {
    error('No installable content found in this asset.');
  }

  log('');

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
        // Security warning for MCP configs
        warn('MCP server config detected. Review the configuration carefully before adding to your project.');
        warn('MCP servers can execute arbitrary code. Only install from trusted sources.');
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

    // Sanitize fileName to prevent path traversal from API response
    fileName = path.basename(fileName);
    const destPath = path.join(destDir, fileName);

    // Don't overwrite without warning
    if (fs.existsSync(destPath)) {
      warn(`File exists: ${path.relative(process.cwd(), destPath)} (overwriting)`);
    }

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
  log(`\n${C.bold}tokrepo list${C.reset}\n`);

  const config = readConfig();
  if (!config || !config.token) error('Not logged in. Run: tokrepo login');

  try {
    const data = await apiRequest('GET', '/api/v1/tokenboard/workflows/my?page=1&page_size=50', null, config.token, config.api);

    if (!data.list || data.list.length === 0) {
      info('No assets found. Run: tokrepo push');
      return;
    }

    log(`  ${C.bold}${data.total}${C.reset} assets:\n`);

    for (const wf of data.list) {
      const views = wf.view_count || 0;
      log(`  ${C.cyan}${wf.uuid.substring(0,8)}${C.reset}  ${C.bold}${wf.title}${C.reset}`);
      log(`  ${C.dim}         ${views} views · https://tokrepo.com/en/workflows/${wf.uuid}${C.reset}\n`);
    }
  } catch (e) {
    error(`Failed: ${e.message}`);
  }
}

async function cmdUpdate() {
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
  const uuid = process.argv[3];
  if (!uuid) error('Usage: tokrepo delete <uuid>');

  log(`\n${C.bold}tokrepo delete${C.reset}\n`);

  const config = readConfig();
  if (!config || !config.token) error('Not logged in. Run: tokrepo login');

  const confirm = await ask(`Delete ${uuid.substring(0,8)}...? (y/N):`);
  if (confirm.toLowerCase() !== 'y') { log('Aborted.'); return; }

  try {
    await apiRequest('DELETE', '/api/v1/tokenboard/workflows/delete', { uuid }, config.token, config.api);
    success('Deleted!');
  } catch (e) {
    error(`Delete failed: ${e.message}`);
  }
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

// ─── Sync: scan directory, diff with remote, upsert changes ───

function computeHash(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f.name);
    h.update('\0');
    h.update(f.content);
    h.update('\0');
  }
  return h.digest('hex');
}

function isProjectDirectory(dirPath) {
  const PROJECT_MARKERS = [
    'package.json', '.tokrepo.json', 'go.mod', 'Cargo.toml',
    'pyproject.toml', 'setup.py', 'Gemfile', 'pom.xml',
    'build.gradle', 'Makefile', 'CMakeLists.txt', 'deno.json',
  ];
  return PROJECT_MARKERS.some(m => fs.existsSync(path.join(dirPath, m)));
}

function scanDirectory(dirPath) {
  const assets = [];
  const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build']);
  const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'package-lock.json', 'yarn.lock']);

  // If the directory itself is a project, treat the whole thing as one asset
  if (isProjectDirectory(dirPath)) {
    const files = collectAssetFiles(dirPath);
    if (files.length > 0) {
      const title = guessAssetTitle(files, path.basename(dirPath));
      const hash = computeHash(files);
      const detectedTags = new Set();
      for (const f of files) {
        const ft = detectFileType(f.name);
        const tag = guessTag(ft);
        if (tag) detectedTags.add(tag);
      }
      assets.push({ title, files, hash, tags: Array.from(detectedTags), sourcePath: dirPath });
    }
    return assets;
  }

  // Non-project directory: each subdirectory = one asset; loose files = one asset per file
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return assets; }

  const looseFiles = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Subdirectory = one asset (e.g., ~/.claude/skills/my-skill/)
      const files = collectAssetFiles(fullPath);
      if (files.length === 0) continue;

      const title = entry.name;
      const hash = computeHash(files);
      const detectedTags = new Set();
      for (const f of files) {
        const ft = detectFileType(f.name);
        const tag = guessTag(ft);
        if (tag) detectedTags.add(tag);
      }

      assets.push({ title, files, hash, tags: Array.from(detectedTags), sourcePath: fullPath });
    } else if (entry.isFile()) {
      // Loose file
      const ext = path.extname(entry.name).toLowerCase();
      const validExts = ['.md', '.sh', '.py', '.js', '.mjs', '.ts', '.json', '.yaml', '.yml', '.toml', '.prompt'];
      if (validExts.includes(ext) || entry.name === '.cursorrules' || entry.name === '.windsurfrules') {
        looseFiles.push({ path: fullPath, name: entry.name });
      }
    }
  }

  // Each loose file = one asset
  for (const f of looseFiles) {
    let content;
    try { content = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    if (!content.trim()) continue;

    const files = [{ name: f.name, content, type: detectFileType(f.name) }];
    const title = guessAssetTitle(files, path.basename(f.name, path.extname(f.name)));
    const hash = computeHash(files);
    const ft = detectFileType(f.name);
    const tag = guessTag(ft);

    assets.push({ title, files, hash, tags: tag ? [tag] : [], sourcePath: f.path });
  }

  return assets;
}

function collectAssetFiles(dirPath) {
  const files = [];
  const SKIP = new Set(['.DS_Store', 'node_modules', '.git', '__pycache__']);

  function walk(dir, relBase) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const validExts = ['.md', '.sh', '.py', '.js', '.mjs', '.ts', '.json', '.yaml', '.yml', '.toml', '.prompt', '.rb', '.go', '.rs'];
        if (validExts.includes(ext) || entry.name === '.cursorrules') {
          let content;
          try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
          if (!content.trim()) continue;
          files.push({ name: relPath, content, type: detectFileType(relPath) });
        }
      }
    }
  }

  walk(dirPath, '');
  return files;
}

function guessAssetTitle(files, fallbackName) {
  // Try to find a heading in the first .md file
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.md')) {
      const match = f.content.match(/^#\s+(.+)$/m);
      if (match) return match[1].trim();
    }
  }
  // Clean up fallback name
  return fallbackName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function cmdSync() {
  const args = parseArgs(process.argv);
  const config = readConfig();
  if (!config || !config.token) error(`Not logged in. Run: ${C.cyan}tokrepo login${C.reset}`);

  const targetDir = args.positional[0]
    ? path.resolve(args.positional[0])
    : path.join(require('os').homedir(), '.claude', 'skills');

  if (!fs.existsSync(targetDir)) {
    error(`Directory not found: ${targetDir}`);
  }

  const visibility = args.flags.public ? 1 : 0; // default private for sync

  log(`\n${C.bold}tokrepo sync${C.reset}\n`);
  info(`Scanning ${targetDir}...`);

  const assets = scanDirectory(targetDir);
  if (assets.length === 0) {
    info('No assets found in directory.');
    return;
  }

  log(`  Found ${C.bold}${assets.length}${C.reset} assets\n`);

  // Load local sync state for fast local-only diff
  const syncState = readSyncState();

  // Classify each asset: check local state first, then remote diff for unknowns
  const needsRemoteCheck = [];
  const localStatus = {};

  for (const asset of assets) {
    const key = asset.sourcePath;
    const cached = syncState[key];
    if (cached && cached.hash === asset.hash) {
      // Local hash matches last sync — unchanged
      localStatus[asset.title] = { status: 'unchanged', uuid: cached.uuid };
    } else if (cached && cached.hash !== asset.hash) {
      // Local hash differs from last sync — updated
      localStatus[asset.title] = { status: 'updated', uuid: cached.uuid };
    } else {
      // Not in local state — check remote
      needsRemoteCheck.push(asset);
    }
  }

  // Remote diff for assets not in local state
  if (needsRemoteCheck.length > 0) {
    info('Comparing with remote...');
    const diffPayload = needsRemoteCheck.map(a => ({ title: a.title, content_hash: a.hash }));
    try {
      const data = await apiRequest('POST', '/api/v1/tokenboard/push/diff', { assets: diffPayload }, config.token, config.api);
      for (const r of data.results) {
        localStatus[r.title] = { status: r.status, uuid: r.remote_uuid || '' };
      }
    } catch (e) {
      warn(`Diff API: ${e.message} — treating unknowns as new`);
      for (const a of needsRemoteCheck) {
        localStatus[a.title] = { status: 'new', uuid: '' };
      }
    }
  }

  // Show status
  let newCount = 0, updatedCount = 0, unchangedCount = 0;

  for (const asset of assets) {
    const st = localStatus[asset.title] || { status: 'new' };
    if (st.status === 'new') {
      log(`  ${C.green}+ new${C.reset}       ${asset.title} ${C.dim}(${asset.files.length} files)${C.reset}`);
      newCount++;
    } else if (st.status === 'updated') {
      log(`  ${C.yellow}~ updated${C.reset}   ${asset.title}`);
      updatedCount++;
    } else {
      log(`  ${C.dim}= unchanged ${asset.title}${C.reset}`);
      unchangedCount++;
    }
  }

  log('');
  log(`  ${C.green}${newCount} new${C.reset}  ${C.yellow}${updatedCount} updated${C.reset}  ${C.dim}${unchangedCount} unchanged${C.reset}`);

  if (newCount === 0 && updatedCount === 0) {
    log('');
    success('Everything is up to date!');
    return;
  }

  log('');

  // Confirm unless -y
  if (!args.flags.yes) {
    const confirm = await ask(`Push ${newCount + updatedCount} assets? (y/N):`);
    if (confirm.toLowerCase() !== 'y') { log('Aborted.'); return; }
  }

  // Upsert each changed asset + save state
  let successCount = 0;
  let failCount = 0;

  for (const asset of assets) {
    const st = localStatus[asset.title] || { status: 'new' };
    if (st.status === 'unchanged') continue;

    const totalChars = asset.files.reduce((sum, f) => sum + f.content.length, 0);

    try {
      const data = await apiRequest('POST', '/api/v1/tokenboard/push/upsert', {
        title: asset.title,
        files: asset.files,
        tags: asset.tags,
        token_cost: String(Math.round(totalChars / 4)),
        visibility,
      }, config.token, config.api);

      const action = data.action === 'created' ? C.green + '+ created' : C.yellow + '~ updated';
      log(`  ${action}${C.reset}  ${asset.title}  ${C.dim}${data.url}${C.reset}`);

      // Save to local sync state
      syncState[asset.sourcePath] = {
        uuid: data.uuid,
        hash: asset.hash,
        title: asset.title,
        url: data.url,
        lastSync: new Date().toISOString(),
      };
      successCount++;
    } catch (e) {
      log(`  ${C.red}✗ failed${C.reset}   ${asset.title}: ${e.message}`);
      failCount++;
    }
  }

  // Persist sync state
  writeSyncState(syncState);

  log('');
  if (failCount === 0) {
    success(`Synced ${successCount} assets!`);
  } else {
    warn(`${successCount} synced, ${failCount} failed`);
  }
  log('');
}

async function cmdStatus() {
  const args = parseArgs(process.argv);
  const config = readConfig();
  if (!config || !config.token) error(`Not logged in. Run: ${C.cyan}tokrepo login${C.reset}`);

  const targetDir = args.positional[0]
    ? path.resolve(args.positional[0])
    : path.join(require('os').homedir(), '.claude', 'skills');

  if (!fs.existsSync(targetDir)) {
    error(`Directory not found: ${targetDir}`);
  }

  log(`\n${C.bold}tokrepo status${C.reset}\n`);
  info(`Scanning ${targetDir}...`);

  const assets = scanDirectory(targetDir);
  if (assets.length === 0) {
    info('No assets found in directory.');
    return;
  }

  // Check local sync state first, remote for unknowns
  const syncState = readSyncState();
  const localStatus = {};
  const needsRemoteCheck = [];

  for (const asset of assets) {
    const cached = syncState[asset.sourcePath];
    if (cached && cached.hash === asset.hash) {
      localStatus[asset.title] = { status: 'unchanged', uuid: cached.uuid };
    } else if (cached && cached.hash !== asset.hash) {
      localStatus[asset.title] = { status: 'updated', uuid: cached.uuid };
    } else {
      needsRemoteCheck.push(asset);
    }
  }

  if (needsRemoteCheck.length > 0) {
    info('Comparing with remote...');
    const diffPayload = needsRemoteCheck.map(a => ({ title: a.title, content_hash: a.hash }));
    try {
      const data = await apiRequest('POST', '/api/v1/tokenboard/push/diff', { assets: diffPayload }, config.token, config.api);
      for (const r of data.results) {
        localStatus[r.title] = { status: r.status, uuid: r.remote_uuid || '' };
      }
    } catch (e) {
      error(`Diff API error: ${e.message}`);
    }
  }

  log('');
  let newCount = 0, updatedCount = 0, unchangedCount = 0;

  for (const asset of assets) {
    const st = localStatus[asset.title] || { status: 'new', uuid: '' };
    const status = st.status;
    const uuid = st.uuid || '';
    const uuidShort = uuid ? ` ${C.dim}(${uuid.substring(0, 8)})${C.reset}` : '';

    if (status === 'new') {
      log(`  ${C.green}+ new${C.reset}       ${asset.title} ${C.dim}(${asset.files.length} files)${C.reset}`);
      newCount++;
    } else if (status === 'updated') {
      log(`  ${C.yellow}~ modified${C.reset}  ${asset.title}${uuidShort}`);
      updatedCount++;
    } else {
      log(`  ${C.dim}  unchanged ${asset.title}${uuidShort}${C.reset}`);
      unchangedCount++;
    }
  }

  log('');
  log(`  ${C.bold}${assets.length}${C.reset} local assets: ${C.green}${newCount} new${C.reset}  ${C.yellow}${updatedCount} modified${C.reset}  ${C.dim}${unchangedCount} synced${C.reset}`);

  if (newCount > 0 || updatedCount > 0) {
    log(`\n  Run ${C.cyan}tokrepo sync ${args.positional[0] || ''}${C.reset} to push changes`);
  }
  log('');
}

function showHelp() {
  log(`
${C.bold}tokrepo${C.reset} — AI assets for humans and agents. Like GitHub, for AI experience.

${C.bold}QUICK START${C.reset}
  ${C.cyan}tokrepo search cursor rules${C.reset}             # find assets
  ${C.cyan}tokrepo install awesome-cursor-rules${C.reset}    # install to your project
  ${C.cyan}tokrepo push --public .${C.reset}                 # share your own assets

${C.bold}USAGE${C.reset}
  tokrepo <command> [args] [options]

${C.bold}DISCOVER & INSTALL${C.reset}
  ${C.cyan}search${C.reset} <query>      Search assets by keyword
  ${C.cyan}install${C.reset} <name|uuid> Smart install (auto-detects type & placement)
  ${C.cyan}pull${C.reset} <url|uuid>     Download raw asset files

${C.bold}PUBLISH & SYNC${C.reset}
  ${C.cyan}push${C.reset} [files...]     Push files/directory (creates new asset)
  ${C.cyan}sync${C.reset} [dir]          Sync directory to TokRepo (smart upsert)
  ${C.cyan}status${C.reset} [dir]        Show local vs remote diff
  ${C.cyan}init${C.reset}                Create .tokrepo.json project config
  ${C.cyan}update${C.reset} <uuid> [f]   Update existing asset by UUID
  ${C.cyan}delete${C.reset} <uuid>       Delete an asset

${C.bold}ACCOUNT${C.reset}
  ${C.cyan}login${C.reset}               Save API token
  ${C.cyan}list${C.reset}                List your published assets
  ${C.cyan}tags${C.reset}                List available tags
  ${C.cyan}whoami${C.reset}              Show current user
  ${C.cyan}help${C.reset}                Show this help

${C.bold}PUSH OPTIONS${C.reset}
  ${C.cyan}--public${C.reset}            Make asset publicly visible (default)
  ${C.cyan}--private${C.reset}           Make asset private
  ${C.cyan}--title${C.reset} "..."       Set title (auto-detected from README or dir name)
  ${C.cyan}--desc${C.reset} "..."        Set description
  ${C.cyan}--tag${C.reset} Skills        Add tag (repeatable)

${C.bold}INSTALL BEHAVIOR${C.reset}
  Skills   → .claude/skills/    (if .claude/ exists)
  Scripts  → current dir        (chmod +x)
  Configs  → project root
  MCP      → current dir        (.json)
  Prompts  → current dir        (.md)

${C.bold}SYNC (the killer feature)${C.reset}
  ${C.cyan}tokrepo sync ~/.claude/skills/${C.reset}          # Sync all skills (default: private)
  ${C.cyan}tokrepo sync ~/.claude/skills/ --public${C.reset} # Sync as public assets
  ${C.cyan}tokrepo sync . -y${C.reset}                       # Sync current dir, skip confirm
  ${C.cyan}tokrepo status${C.reset}                          # Show what would change

  Sync scans a directory, detects new/modified assets, and pushes only
  what changed. Each subdirectory becomes one asset. Loose files become
  individual assets. Like ${C.bold}git push${C.reset} for your AI assets.

${C.bold}EXAMPLES${C.reset}
  tokrepo search "mcp server"                 # Find MCP configs
  tokrepo install ca000374-f5d8-...           # Install by UUID
  tokrepo push --public .                     # Push current directory
  tokrepo push --public --title "My MCP" .    # Push with custom title

${C.bold}FILE TYPE AUTO-DETECTION${C.reset}
  .sh .py .js .ts .mjs .go .rs  →  script
  .json .yaml .yml .toml        →  config
  .skill.md                     →  skill
  .prompt .prompt.md            →  prompt
  .md (other)                   →  other

${C.bold}GET YOUR TOKEN${C.reset}
  https://tokrepo.com/en/workflows/submit
`);
}

// ─── Main ───

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'login': await cmdLogin(); break;
    case 'init': await cmdInit(); break;
    case 'push': await cmdPush(); break;
    case 'sync': await cmdSync(); break;
    case 'status': case 'st': await cmdStatus(); break;
    case 'pull': await cmdPull(); break;
    case 'search': case 'find': await cmdSearch(); break;
    case 'install': case 'i': await cmdInstall(); break;
    case 'list': await cmdList(); break;
    case 'update': await cmdUpdate(); break;
    case 'delete': await cmdDelete(); break;
    case 'tags': await cmdTags(); break;
    case 'whoami': await cmdWhoami(); break;
    case '--version': case '-v': case 'version':
      log(`tokrepo ${CLI_VERSION}`); break;
    case 'help': case '--help': case '-h': case undefined:
      showHelp(); break;
    default:
      error(`Unknown command: ${command}. Run: tokrepo help`);
  }

  // Non-blocking update check after command completes
  checkForUpdate();
}

main().catch((e) => { error(e.message); });
