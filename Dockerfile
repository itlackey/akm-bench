FROM node:22-bookworm-slim

ARG BUN_VERSION=1.3.13
ARG AKM_CLI_VERSION=0.7.1
ARG OPENCODE_AI_VERSION=latest
ARG OPENCODE_PROVIDER_PACKAGES="@ai-sdk/openai @ai-sdk/openai-compatible opencode-antigravity-auth"

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:/opt/akm-bench/node_modules/.bin:${PATH}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v${BUN_VERSION}
RUN python3 -m pip install --break-system-packages --no-cache-dir pytest PyYAML

RUN npm install -g "opencode-ai@${OPENCODE_AI_VERSION}"

RUN mkdir -p /opt/opencode-home/.config/opencode \
  && npm install --prefix /opt/opencode-home/.config/opencode ${OPENCODE_PROVIDER_PACKAGES}

WORKDIR /opt/akm-bench

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
RUN npm install --no-save "akm-cli@${AKM_CLI_VERSION}"

COPY biome.json tsconfig.json README.md LICENSE ./
COPY config ./config
COPY docs ./docs
COPY fixtures ./fixtures
COPY src ./src
COPY tests ./tests
COPY bin/docker-entrypoint.sh ./bin/docker-entrypoint.sh

RUN chmod +x /opt/akm-bench/bin/docker-entrypoint.sh

ENTRYPOINT ["/opt/akm-bench/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/cli.ts"]
