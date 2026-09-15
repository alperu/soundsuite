# ss-rlm-sandbox — the RLM pattern driven against a hosted chat model.
#
# See docs/DESIGN-ss-rlm-sandbox-runtime.md. Three properties are requirements,
# not preferences (SPEC-ss-rlm-sandbox.md §4), because the Python that executes
# in here is written by a model rather than by us:
#
#   NO Docker socket   — never mount /var/run/docker.sock into this container.
#                        The sidecar holds it for itself and does not pass it to
#                        role containers; keep it that way. This is also why the
#                        REPL runs with environment="local" rather than the
#                        library's DockerREPL, which would need the socket to
#                        spawn nested containers.
#   NO API key         — sub-model calls go back through the sidecar, which
#                        holds the OpenRouter key. Do not add one here.
#   NO outbound egress — the only route needed is to the sidecar. Lock it down.
#
# Build (from repo root), fetching the library from a master:
#   docker build -t rlm-sandbox:0.1.0 \
#     --build-arg MASTER_URL=http://<master>:3000 \
#     --build-arg RLMS_SHA256=$(node -p "require('./public/rlm/manifest.json').sha256") \
#     docker/rlm-sandbox
#
# Run:
#   docker run --rm -p 8101:8101 \
#     -e SS_SIDECAR_URL=http://host.docker.internal:8098/api/v1 \
#     rlm-sandbox:0.1.0

FROM python:3.11-slim

ARG MASTER_URL
ARG RLMS_SHA256

# The library is vendored at public/rlm/ and served from disk by any master, so
# a build host needs a route to a master and nothing else — not GitHub, not
# PyPI. The checksum is verified the way install.sh verifies the sidecar
# tarball: fetching a dependency over HTTP without checking it is the defect
# class those rules exist for.
ADD ${MASTER_URL}/rlm/rlms-latest.tar.gz /tmp/rlms.tar.gz
RUN set -eux; \
    echo "${RLMS_SHA256}  /tmp/rlms.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/rlms; \
    tar xzf /tmp/rlms.tar.gz -C /tmp/rlms; \
    pip install --no-cache-dir /tmp/rlms; \
    rm -rf /tmp/rlms /tmp/rlms.tar.gz

COPY server.py /app/server.py

# Non-root. /tmp stays writable for the REPL's scratch files; run with
# --read-only --tmpfs /tmp in production for the read-only rootfs SPEC §4 asks
# for (not baked in here so the image stays runnable by hand for debugging).
RUN useradd --create-home --uid 10001 sandbox && chown -R sandbox /app
USER sandbox

ENV PYTHONUNBUFFERED=1 \
    PORT=8101

EXPOSE 8101

# No HEALTHCHECK on purpose: the sidecar probes /health itself and a Docker-level
# healthcheck would add a second source of truth about whether this role is up.
CMD ["python", "/app/server.py"]
