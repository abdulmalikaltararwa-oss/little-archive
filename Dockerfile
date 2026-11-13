FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 LA_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 archive \
    && useradd --uid 10001 --gid archive --no-create-home archive \
    && mkdir /data && chown archive:archive /data
COPY --chown=archive:archive server ./server
COPY --chown=archive:archive web ./web
USER archive
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3)"
CMD ["python", "-m", "server.cli", "serve", "--host", "0.0.0.0", "--port", "8787"]
