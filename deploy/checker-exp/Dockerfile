FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git coreutils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY <<'EOF' /usr/local/bin/git-askpass
#!/bin/sh
case "$1" in
  *sername*|*Username*) printf '%s' "${GIT_USERNAME:-x-access-token}" ;;
  *) printf '%s' "${GIT_TOKEN:?GIT_TOKEN is required}" ;;
esac
EOF

RUN chmod +x /usr/local/bin/git-askpass \
 && install -d -o node -g node /work

USER node
WORKDIR /work
CMD ["sleep", "infinity"]
