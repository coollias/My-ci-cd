# My CI/CD

一个轻量级的手动部署面板：在网页里点击“拉取并部署”，服务器从 GitHub 拉取代码，然后执行可编辑的 `deploy.sh`。

## 功能

- 手动触发部署，不会在 `git push` 后自动部署
- 支持多个项目
- 在网页里编辑每个项目的 `deploy.sh`
- 实时查看部署日志
- 项目配置保存在 `data/projects.json`
- 部署日志保存在 `data/runs/`
- 零第三方依赖，Node.js 18+ 即可运行

## 快速启动

```bash
cp .env.example .env
export DEPLOY_TOKEN="换成一个足够长的随机字符串"
npm start
```

打开：

```text
http://你的服务器IP:7331
```

第一次进入页面时，在左侧输入 `DEPLOY_TOKEN` 并保存。

## 项目配置

项目列表在 `data/projects.json`：

```json
[
  {
    "id": "example-site",
    "name": "Example Site",
    "repoUrl": "git@github.com:coollias/example-site.git",
    "branch": "main",
    "workDir": "/var/www/example-site",
    "scriptPath": "scripts/example-site/deploy.sh"
  }
]
```

字段说明：

- `id`：项目唯一标识，只建议使用英文、数字和短横线
- `name`：页面显示名称
- `repoUrl`：GitHub 仓库地址，推荐使用 SSH 地址
- `branch`：部署分支
- `workDir`：服务器上存放项目代码的目录
- `scriptPath`：相对于本项目根目录的部署脚本路径

## deploy.sh 可用变量

执行脚本时，系统会注入这些环境变量：

```bash
PROJECT_ID
PROJECT_NAME
REPO_URL
BRANCH
WORK_DIR
```

示例脚本位于 `scripts/example-site/deploy.sh`。你可以在网页里直接编辑它，也可以在服务器上编辑文件。

## 让服务器能拉 GitHub 私有仓库

推荐在服务器上生成 SSH Key：

```bash
ssh-keygen -t ed25519 -C "deploy@my-server"
cat ~/.ssh/id_ed25519.pub
```

然后把公钥添加到 GitHub 仓库的 Deploy keys，或添加到你的 GitHub 账号 SSH keys。

测试：

```bash
ssh -T git@github.com
git ls-remote git@github.com:coollias/你的仓库.git
```

## 用 PM2 常驻运行

```bash
npm install -g pm2
DEPLOY_TOKEN="换成一个足够长的随机字符串" pm2 start server.js --name my-ci-cd
pm2 save
```

## 用 systemd 常驻运行

创建 `/etc/systemd/system/my-ci-cd.service`：

```ini
[Unit]
Description=My CI/CD
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/my-ci-cd
Environment=PORT=7331
Environment=HOST=0.0.0.0
Environment=DEPLOY_TOKEN=换成一个足够长的随机字符串
ExecStart=/usr/bin/node /opt/my-ci-cd/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now my-ci-cd
```

## 安全建议

- 一定要修改默认 `DEPLOY_TOKEN`
- 不要把面板直接裸露到公网，建议配合防火墙、内网、VPN 或 Nginx Basic Auth
- `deploy.sh` 只给可信管理员编辑
- 尽量给部署用户最小权限，不要直接用 root 跑面板
- 如果脚本里用了 `sudo`，只开放必要命令
