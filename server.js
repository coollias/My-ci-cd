const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 7331);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.DEPLOY_TOKEN || "change-me-to-a-long-random-string";
const DATA_DIR = path.join(ROOT, "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PUBLIC_DIR = path.join(ROOT, "public");

fs.mkdirSync(RUNS_DIR, { recursive: true });

const activeRuns = new Map();
const runStreams = new Map();

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

function loadProjects() {
  return readJson(PROJECTS_FILE, []);
}

function saveProjects(projects) {
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

function getProject(id) {
  return loadProjects().find((project) => project.id === id);
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
  for (const client of run.clients) {
    client.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    client.end();
  }
  runStreams.delete(runId);
  activeRuns.delete(run.project.id);
}

function createRun(project) {
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
  runStreams.set(runId, run);
  activeRuns.set(project.id, runId);
  fs.writeFileSync(logFile, "");

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
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!requireAuth(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, { projects: loadProjects().map(publicProject), activeRuns: Object.fromEntries(activeRuns) });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/projects") {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.projects)) {
      sendJson(res, 400, { error: "projects must be an array" });
      return;
    }
    saveProjects(body.projects);
    sendJson(res, 200, { projects: loadProjects().map(publicProject) });
    return;
  }

  const scriptMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/script$/);
  if (scriptMatch) {
    const project = getProject(scriptMatch[1]);
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
    const project = getProject(deployMatch[1]);
    if (!project) {
      sendJson(res, 404, { error: "Project not found" });
      return;
    }
    try {
      sendJson(res, 202, createRun(project));
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

server.listen(PORT, HOST, () => {
  console.log(`My CI/CD is running at http://${HOST}:${PORT}`);
  if (TOKEN === "change-me-to-a-long-random-string") {
    console.warn("DEPLOY_TOKEN is using the default value. Change it before exposing this service.");
  }
});
