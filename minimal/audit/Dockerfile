FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
RUN apt-get update \
    && apt-get install -y --no-install-recommends strace=6.1-0.1 chromium \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENTRYPOINT ["strace"]
