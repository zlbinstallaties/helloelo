# syntax=docker/dockerfile:1
# Sandbox image for DIG Builder: runs project installs, builds, tests and previews.
#   docker build -t dig-sandbox:1 sandbox
# Behind a TLS-intercepting proxy, pass its CA as a build secret:
#   docker build --secret id=ca,src=/path/ca.pem -t dig-sandbox:1 sandbox
# Contains only runtimes. Project code is mounted at /work at run time; no
# credentials are baked in or passed in.
FROM node:22-slim

RUN --mount=type=secret,id=ca,required=false \
  if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
  && npm install -g bun@1.3.14 && npm cache clean --force \
  && rm -rf /root/.npm /tmp/*

USER node
WORKDIR /work
