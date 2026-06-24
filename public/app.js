const state = {
  token: localStorage.getItem("deployToken") || "",
  projects: [],
  selectedId: null,
  deploying: false,
  eventSource: null
};

const $ = (id) => document.getElementById(id);

const els = {
  tokenInput: $("tokenInput"),
  saveTokenBtn: $("saveTokenBtn"),
  refreshBtn: $("refreshBtn"),
  projectList: $("projectList"),
  projectTitle: $("projectTitle"),
  saveConfigBtn: $("saveConfigBtn"),
  saveScriptBtn: $("saveScriptBtn"),
  deployBtn: $("deployBtn"),
  nameInput: $("nameInput"),
  repoInput: $("repoInput"),
  branchInput: $("branchInput"),
  workDirInput: $("workDirInput"),
  scriptPathLabel: $("scriptPathLabel"),
  scriptEditor: $("scriptEditor"),
  statusLabel: $("statusLabel"),
  logBox: $("logBox")
};

els.tokenInput.value = state.token;

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedId);
}

function setStatus(text, className = "") {
  els.statusLabel.textContent = text;
  els.statusLabel.className = className;
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${state.token}`
  };
  if (options.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function renderProjects() {
  els.projectList.innerHTML = "";
  for (const project of state.projects) {
    const button = document.createElement("button");
    button.className = `project-item${project.id === state.selectedId ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = project.name;
    button.querySelector("span").textContent = `${project.branch} · ${project.repoUrl}`;
    button.addEventListener("click", () => selectProject(project.id));
    els.projectList.append(button);
  }
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects;
  if (!state.selectedId && state.projects.length) {
    state.selectedId = state.projects[0].id;
  }
  renderProjects();
  await loadSelectedProject();
}

async function loadSelectedProject() {
  const project = selectedProject();
  const disabled = !project;
  els.saveConfigBtn.disabled = disabled;
  els.saveScriptBtn.disabled = disabled;
  els.deployBtn.disabled = disabled || state.deploying;
  if (!project) return;

  els.projectTitle.textContent = project.name;
  els.nameInput.value = project.name;
  els.repoInput.value = project.repoUrl;
  els.branchInput.value = project.branch;
  els.workDirInput.value = project.workDir;
  els.scriptPathLabel.textContent = project.scriptPath;

  const script = await api(`/api/projects/${project.id}/script`);
  els.scriptEditor.value = script.content;
}

async function selectProject(id) {
  state.selectedId = id;
  renderProjects();
  await loadSelectedProject();
}

async function saveConfig() {
  const project = selectedProject();
  if (!project) return;
  project.name = els.nameInput.value.trim();
  project.repoUrl = els.repoInput.value.trim();
  project.branch = els.branchInput.value.trim();
  project.workDir = els.workDirInput.value.trim();
  const data = await api("/api/projects", {
    method: "PUT",
    body: JSON.stringify({ projects: state.projects })
  });
  state.projects = data.projects;
  renderProjects();
  els.projectTitle.textContent = project.name;
  setStatus("Project config saved");
}

async function saveScript() {
  const project = selectedProject();
  if (!project) return;
  await api(`/api/projects/${project.id}/script`, {
    method: "PUT",
    body: JSON.stringify({ content: els.scriptEditor.value })
  });
  setStatus("deploy.sh saved");
}

function streamRun(runId) {
  if (state.eventSource) {
    state.eventSource.close();
  }
  const source = new EventSource(`/api/runs/${runId}/stream?token=${encodeURIComponent(state.token)}`);
  state.eventSource = source;
  source.addEventListener("log", (event) => {
    els.logBox.textContent += JSON.parse(event.data);
    els.logBox.scrollTop = els.logBox.scrollHeight;
  });
  source.addEventListener("done", (event) => {
    const data = JSON.parse(event.data);
    state.deploying = false;
    els.deployBtn.disabled = false;
    setStatus(data.status, data.status === "success" ? "status-success" : "status-failed");
    source.close();
  });
  source.onerror = () => {
    if (state.deploying) setStatus("Log stream disconnected", "status-failed");
  };
}

async function deploy() {
  const project = selectedProject();
  if (!project || state.deploying) return;
  await saveConfig();
  await saveScript();
  state.deploying = true;
  els.deployBtn.disabled = true;
  els.logBox.textContent = "";
  setStatus("Running");
  const data = await api(`/api/projects/${project.id}/deploy`, { method: "POST" });
  streamRun(data.runId);
}

els.saveTokenBtn.addEventListener("click", () => {
  state.token = els.tokenInput.value.trim();
  localStorage.setItem("deployToken", state.token);
  loadProjects().catch((error) => setStatus(error.message, "status-failed"));
});

els.refreshBtn.addEventListener("click", () => {
  loadProjects().catch((error) => setStatus(error.message, "status-failed"));
});

els.saveConfigBtn.addEventListener("click", () => {
  saveConfig().catch((error) => setStatus(error.message, "status-failed"));
});

els.saveScriptBtn.addEventListener("click", () => {
  saveScript().catch((error) => setStatus(error.message, "status-failed"));
});

els.deployBtn.addEventListener("click", () => {
  deploy().catch((error) => {
    state.deploying = false;
    els.deployBtn.disabled = false;
    setStatus(error.message, "status-failed");
  });
});

if (state.token) {
  loadProjects().catch((error) => setStatus(error.message, "status-failed"));
}
