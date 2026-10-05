# Build from the repository root: docker build -f gateway/Dockerfile .
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app
COPY src/lib/odoo-client.ts src/lib/odoo-client.ts
COPY gateway/src gateway/src

USER node
EXPOSE 8070
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8070/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--no-warnings", "gateway/src/main.ts"]
