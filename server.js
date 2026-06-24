const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const ROOT = __dirname;

function loadEnvFile() {
  const envFile = path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 7331);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.DEPLOY_TOKEN || "change-me-to-a-long-random-string";
const DATA_DIR = path.join(ROOT, "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_CONFIG = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "my_ci_cd"
};
const USE_MYSQL = Boolean(DB_CONFIG.host && DB_CONFIG.user);

fs.mkdirSync(RUNS_DIR, { recursive: true });

const activeRuns = new Map();
const runStreams = new Map();
let dbPool = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function initStorage() {
  if (!USE_MYSQL) return;

  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch {
    throw new Error("MySQL is configured but mysql2 is not installed. Run `npm install` first.");
  }

  if (!/^[a-zA-Z0-9_$]+$/.test(DB_CONFIG.database)) {
    throw new Error("DB_NAME may only contain letters, numbers, underscores, and dollar signs.");
  }

  const bootstrap = await mysql.createConnection({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    multipleStatements: false
  });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();

  dbPool = mysql.createPool({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    database: DB_CONFIG.database,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    charset: "utf8mb4"
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(80) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      repo_url VARCHAR(1024) NOT NULL,
      branch_name VARCHAR(255) NOT NULL,
      work_dir VARCHAR(1024) NOT NULL,
      script_path VARCHAR(1024) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS deployment_runs (
      id VARCHAR(80) PRIMARY KEY,
      project_id VARCHAR(80) NOT NULL,
      status VARCHAR(40) NOT NULL,
      exit_code INT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME NULL,
      log_file VARCHAR(1024) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_deployment_runs_project_started (project_id, started_at),
      CONSTRAINT fk_deployment_runs_project
        FOREIGN KEY (project_id) REFERENCES projects(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [[{ count }]] = await dbPool.query("SELECT COUNT(*) AS count FROM projects");
  if (count === 0) {
    const localProjects = readJson(PROJECTS_FILE, []);
    if (localProjects.length) {
      await saveProjects(localProjects);
      console.log(`Seeded ${localProjects.length} project(s) from data/projects.json`);
    }
  }
}

async function loadProjects() {
  if (dbPool) {
    const [rows] = await dbPool.query(
      "SELECT id, name, repo_url AS repoUrl, branch_name AS branch, work_dir AS workDir, script_path AS scriptPath FROM projects ORDER BY created_at, id"
    );
    return rows;
  }
  return readJson(PROJECTS_FILE, []);
}

async function saveProjects(projects) {
  if (dbPool) {
    const connection = await dbPool.getConnection();
    try {
      await connection.beginTransaction();
      const ids = projects.map((project) => project.id);
      if (ids.length) {
        await connection.query("DELETE FROM projects WHERE id NOT IN (?)", [ids]);
      } else {
        await connection.query("DELETE FROM projects");
      }
      for (const project of projects) {
        await connection.query(
          `INSERT INTO projects (id, name, repo_url, branch_name, work_dir, script_path)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             repo_url = VALUES(repo_url),
             branch_name = VALUES(branch_name),
             work_dir = VALUES(work_dir),
             script_path = VALUES(script_path)`,
          [project.id, project.name, project.repoUrl, project.branch, project.workDir, project.scriptPath]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return;
  }
  writeJson(PROJECTS_FILE, projects);
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    branch: project.branch,
    workDir: project.workDir,
    scriptPath: project.scriptPath
  };
}

async function getProject(id) {
  const projects = await loadProjects();
  return projects.find((project) => project.id === id);
}

function safeRelativePath(value) {
  if (!value || path.isAbsolute(value) || value.includes("..")) {
    throw new Error("Path must be relative and cannot contain '..'.");
  }
  return path.join(ROOT, value);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function requireAuth(req, res, url) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.headers["x-deploy-token"] || url.searchParams.get("token");
  if (token === TOKEN) return true;
  sendJson(res, 401, { error: "Unauthorized" });
  return false;
}

function appendRunLog(runId, chunk) {
  const text = chunk.toString();
  const run = runStreams.get(runId);
  if (!run) return;
  run.log += text;
  fs.appendFileSync(run.logFile, text);
  for (const client of run.clients) {
    client.write(`event: log\ndata: ${JSON.stringify(text)}\n\n`);
  }
}

function finishRun(runId, status, exitCode) {
  const run = runStreams.get(runId);
  if (!run) return;
  run.status = status;
  run.exitCode = exitCode;
  run.finishedAt = new Date().toISOString();
  const payload = {
    id: runId,
    projectId: run.project.id,
    status,
    exitCode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  };
  fs.writeFileSync(path.join(RUNS_DIR, `${runId}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  updateRunRecord(runId, status, exitCode, run.finishedAt).catch((error) => {
    console.error(`Failed to update run ${runId}:`, error.message);
  });
  for (const client of run.clients) {
    client.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    client.end();
  }
  runStreams.delete(runId);
  activeRuns.delete(run.project.id);
}

async function createRun(project) {
  if (activeRuns.has(project.id)) {
    const error = new Error("This project is already deploying.");
    error.status = 409;
    throw error;
  }

  const scriptFile = safeRelativePath(project.scriptPath);
  if (!fs.existsSync(scriptFile)) {
    const error = new Error("Deploy script does not exist.");
    error.status = 400;
    throw error;
  }

  const runId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const logFile = path.join(RUNS_DIR, `${runId}.log`);
  const startedAt = new Date().toISOString();
  const run = {
    project,
    status: "running",
    startedAt,
    logFile,
    log: "",
    clients: new Set()
  };
  fs.writeFileSync(logFile, "");
  await createRunRecord(runId, project.id, startedAt, logFile);
  runStreams.set(runId, run);
  activeRuns.set(project.id, runId);

  const child = spawn("bash", [scriptFile], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROJECT_ID: project.id,
      PROJECT_NAME: project.name,
      REPO_URL: project.repoUrl,
      BRANCH: project.branch,
      WORK_DIR: project.workDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  appendRunLog(runId, `$ ${project.scriptPath}\n`);
  child.stdout.on("data", (chunk) => appendRunLog(runId, chunk));
  child.stderr.on("data", (chunk) => appendRunLog(runId, chunk));
  child.on("error", (error) => {
    appendRunLog(runId, `\nProcess error: ${error.message}\n`);
    finishRun(runId, "failed", 1);
  });
  child.on("close", (code) => {
    appendRunLog(runId, `\nProcess exited with code ${code}\n`);
    finishRun(runId, code === 0 ? "success" : "failed", code);
  });

  return { runId, startedAt };
}

async function createRunRecord(runId, projectId, startedAt, logFile) {
  const payload = {
    id: runId,
    projectId,
    status: "running",
    exitCode: null,
    startedAt,
    finishedAt: null,
    logFile
  };
  fs.writeFileSync(path.join(RUNS_DIR, `${runId}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  if (!dbPool) return;
  await dbPool.query(
    `INSERT INTO deployment_runs (id, project_id, status, exit_code, started_at, finished_at, log_file)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [runId, projectId, "running", null, new Date(startedAt), null, logFile]
  );
}

async function updateRunRecord(runId, status, exitCode, finishedAt) {
  if (!dbPool) return;
  await dbPool.query(
    "UPDATE deployment_runs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?",
    [status, exitCode, new Date(finishedAt), runId]
  );
}

function contentType(file) {
  const ext = path.extname(file);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": contentType(file) });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, storage: dbPool ? "mysql" : "json" });
    return;
  }

  if (!requireAuth(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const projects = await loadProjects();
    sendJson(res, 200, { projects: projects.map(publicProject), activeRuns: Object.fromEntries(activeRuns) });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/projects") {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.projects)) {
      sendJson(res, 400, { error: "projects must be an array" });
      return;
    }
    await saveProjects(body.projects);
    const projects = await loadProjects();
    sendJson(res, 200, { projects: projects.map(publicProject) });
    return;
  }

  const scriptMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/script$/);
  if (scriptMatch) {
    const project = await getProject(scriptMatch[1]);
    if (!project) {
      sendJson(res, 404, { error: "Project not found" });
      return;
    }
    const scriptFile = safeRelativePath(project.scriptPath);
    if (req.method === "GET") {
      sendJson(res, 200, {
        path: project.scriptPath,
        content: fs.existsSync(scriptFile) ? fs.readFileSync(scriptFile, "utf8") : ""
      });
      return;
    }
    if (req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
      fs.writeFileSync(scriptFile, body.content || "", { mode: 0o755 });
      fs.chmodSync(scriptFile, 0o755);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const deployMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/deploy$/);
  if (req.method === "POST" && deployMatch) {
    const project = await getProject(deployMatch[1]);
    if (!project) {
      sendJson(res, 404, { error: "Project not found" });
      return;
    }
    try {
      sendJson(res, 202, await createRun(project));
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const run = runStreams.get(streamMatch[1]);
    if (!run) {
      sendJson(res, 404, { error: "Run not found or already finished" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(`event: log\ndata: ${JSON.stringify(run.log)}\n\n`);
    run.clients.add(res);
    req.on("close", () => run.clients.delete(res));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

initStorage()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`My CI/CD is running at http://${HOST}:${PORT}`);
      console.log(`Storage: ${dbPool ? `mysql://${DB_CONFIG.host}/${DB_CONFIG.database}` : "local JSON"}`);
      if (TOKEN === "change-me-to-a-long-random-string") {
        console.warn("DEPLOY_TOKEN is using the default value. Change it before exposing this service.");
      }
    });
  })
  .catch((error) => {
    console.error(`Failed to start My CI/CD: ${error.message}`);
    process.exit(1);
  });
