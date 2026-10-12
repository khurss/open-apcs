FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ARG PNPM_VERSION=10.18.3
RUN npm install --global pnpm@${PNPM_VERSION} \
    && mkdir -p /workspace/node_modules /pnpm/store \
    && chown -R node:node /workspace /pnpm

WORKDIR /workspace
USER node

# Source and dependencies are mounted at runtime. Editing TypeScript does not
# rebuild this image. This image contains tooling only, not application code.
CMD ["node", "-e", "setInterval(() => {}, 3600000)"]
