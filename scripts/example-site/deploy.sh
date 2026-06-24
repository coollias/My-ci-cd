#!/usr/bin/env bash
set -Eeuo pipefail

echo "Deploying ${PROJECT_NAME}"
echo "Repository: ${REPO_URL}"
echo "Branch: ${BRANCH}"
echo "Directory: ${WORK_DIR}"

if [ ! -d "${WORK_DIR}/.git" ]; then
  mkdir -p "$(dirname "${WORK_DIR}")"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${WORK_DIR}"
fi

cd "${WORK_DIR}"
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"

if [ -f pnpm-lock.yaml ]; then
  corepack enable
  pnpm install --frozen-lockfile
  pnpm run build
elif [ -f package-lock.json ]; then
  npm ci
  npm run build
elif [ -f yarn.lock ]; then
  corepack enable
  yarn install --frozen-lockfile
  yarn build
else
  echo "No known frontend lockfile found, skipping dependency install/build."
fi

echo "Deployment finished. Add your restart/reload command here, for example:"
echo "pm2 restart example-site || true"
echo "sudo systemctl reload nginx || true"
