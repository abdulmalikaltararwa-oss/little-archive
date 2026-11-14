# The interface is built once, in a Node stage, and only its files reach the final image. The image holds
# no Node, no npm packages and no interface source: just the server and the built interface in /app/webui.
FROM node:24-slim AS interface
WORKDIR /build
# ui/ imports a few tested modules, its display font and its demo data from web/, so web/ sits beside it.
COPY web ./web
COPY ui/package.json ui/package-lock.json ./ui/
RUN npm --prefix ui ci --ignore-scripts --no-audit --no-fund
COPY ui ./ui
# The build checks types and lint first. The build manifest is for the demo site, not for the server.
RUN npm --prefix ui run build && rm -rf ui/dist/.vite

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 LA_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 archive \
    && useradd --uid 10001 --gid archive --no-create-home archive \
    && mkdir /data && chown archive:archive /data
COPY --chown=archive:archive server ./server
COPY --from=interface --chown=archive:archive /build/ui/dist ./webui
COPY --chown=archive:archive LICENSE ./LICENSE
USER archive
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3)"
CMD ["python", "-m", "server.cli", "serve", "--host", "0.0.0.0", "--port", "8787"]
